/**
 * TileMan.io Cross-Server Spectator Mod (Trystero edition)
 * Uses Trystero for serverless WebRTC peer discovery/signaling — replaces
 * the previous PeerJS + public 0.peerjs.com broker + manual slot system.
 * Trystero's default strategy (Nostr) uses hundreds of public relays only
 * to exchange the initial handshake; actual gameplay data still goes
 * directly peer-to-peer, same as before.
 */

import { joinRoom } from 'https://esm.run/trystero';

(function () {
  // Pick something genuinely unique to this app/deployment.
  const APP_ID = 'tileman-io-p2p-spectator-v3';
  const ROOM_ID = 'global';

  // TURN relay fallback for peer pairs that can't establish a direct WebRTC
  // connection (symmetric NAT, restrictive firewalls, etc). Without this,
  // those pairs fail outright and never recover on their own. Fill in
  // credentials from a TURN provider — e.g. Cloudflare Calls TURN (free
  // tier, https://developers.cloudflare.com/calls/turn/) or Open Relay
  // (https://www.metered.ca/tools/openrelay/). Leave the array empty to
  // fall back to STUN-only (direct-connection-only) behavior.
  const TURN_SERVERS = [
    // {
    //   urls: 'turn:your-turn-server.example:3478',
    //   username: 'YOUR_TURN_USERNAME',
    //   credential: 'YOUR_TURN_CREDENTIAL'
    // }
  ];

  const BROADCAST_FPS = 30;
  const PING_INTERVAL_MS = 3000;
  const TARGET_STREAM_WIDTH = 1200;

  let room = null;
  let pingAction, subscribeAction, unsubscribeAction, frameAction;

  const playerRegistry = new Map();   // peerId -> { username, region, mode, matchState, lastSeen, allowSpectating }
  const activeSpectators = new Set(); // peerIds currently watching our stream
  let spectatingPeerId = null;
  let spectatedMatchState = null;     // last known state of whoever we're currently spectating
  let broadcastTimer = null;
  let lastKnownMatchState = null;     // our own LOBBY / MATCH / DEAD, used to detect transitions fast

  // Rescaling offscreen context canvas to avoid bandwidth blowups
  const scaleCanvas = document.createElement('canvas');
  const scaleCtx = scaleCanvas.getContext('2d');

  function initializeMod() {
    const roomConfig = { appId: APP_ID };
    if (TURN_SERVERS.length > 0) {
      roomConfig.turnConfig = TURN_SERVERS;
    }
    room = joinRoom(roomConfig, ROOM_ID, {
      onJoinError: (details) => {
        console.warn('P2P connection failed for peer', details.peerId, '-', details.error);
        console.warn('If this keeps happening for the same peers, it likely means a TURN server is needed (see TURN_SERVERS at the top of this file).');
      }
    });

    pingAction = room.makeAction('ping');
    subscribeAction = room.makeAction('sub');
    unsubscribeAction = room.makeAction('unsub');
    frameAction = room.makeAction('frame');

    room.onPeerJoin = (peerId) => {
      sendStatePing(peerId);
    };

    room.onPeerLeave = (peerId) => {
      playerRegistry.delete(peerId);
      activeSpectators.delete(peerId);
      if (spectatingPeerId === peerId) exitSpectatorView();
      handleStreamingService();
      updateUI();
    };

    pingAction.onMessage = (state, { peerId }) => {
      const previous = playerRegistry.get(peerId);
      const matchState = state.matchState === 'MATCH' || state.matchState === 'DEAD'
        ? state.matchState
        : 'LOBBY';

      playerRegistry.set(peerId, {
        username: state.username || 'Unnamed Slot',
        region: state.region || 'Default',
        mode: state.mode || 'Default',
        matchState,
        allowSpectating: state.allowSpectating !== false,
        lastSeen: Date.now()
      });
      updateUI();

      // If we're actively watching this peer, react to their state changing
      // right away instead of waiting to notice frames stopped arriving.
      if (spectatingPeerId === peerId && (!previous || previous.matchState !== matchState)) {
        handleSpectatedStateChange(matchState);
      }
    };

    subscribeAction.onMessage = (_, { peerId }) => {
      if (window.TamState?.allowSpectating === false) return; // Reject incoming viewer
      activeSpectators.add(peerId);
      handleStreamingService();
    };

    window.addEventListener('spectateSettingChanged', (e) => {
      const isAllowed = e.detail;
      broadcastState();
      
      if (!isAllowed) {
        // Kick anyone currently watching if toggled off mid-match
        activeSpectators.clear();
        handleStreamingService();
      }
    });

    unsubscribeAction.onMessage = (_, { peerId }) => {
      activeSpectators.delete(peerId);
      handleStreamingService();
    };

    frameAction.onMessage = (blobData, { peerId }) => {
      if (spectatingPeerId === peerId && spectatedMatchState === 'MATCH') {
        const renderView = document.getElementById('spectator-render-view');
        if (renderView) renderView.src = URL.createObjectURL(new Blob([blobData]));
      }
    };

    setInterval(broadcastState, PING_INTERVAL_MS);

    // Separate, much faster poll purely to catch our own match-state
    // transitions (MATCH -> DEAD -> LOBBY -> MATCH ...) and push them out
    // immediately, so anyone spectating us doesn't sit on a stale frame
    // for up to PING_INTERVAL_MS before finding out we died.
    setInterval(() => {
      const state = getLocalMatchState();
      if (state !== lastKnownMatchState) {
        lastKnownMatchState = state;
        broadcastState();
        handleStreamingService();
      }
    }, 250);

    const closeBtn = document.getElementById('spectator-close-btn');
    if (closeBtn) closeBtn.onclick = exitSpectatorView;

    updateUI();
  }

  // Single source of truth for our own state, reused by currentState(),
  // handleStreamingService(), and captureAndDistributeFrame() so they can
  // never disagree with each other.
  //   LOBBY - not in a match (menu, or left after dying)
  //   MATCH - actually alive and playing, canvas is showing live gameplay
  //   DEAD  - died and is sitting on the game-over/death screen
  function getLocalMatchState() {
    if (!window.TamState?.isGameActive) return 'LOBBY';
    if (window.TamState?.isGameOverScreenActive) return 'DEAD';
    return 'MATCH';
  }

  function currentState() {
    return {
      username: window.TamState?.getSelfName() || localStorage['n'] || 'Player',
      region: window.TamState?.selectedRegion || 'Default',
      mode: window.TamState?.selectedMode || 'Default',
      matchState: getLocalMatchState(),
      allowSpectating: window.TamState?.allowSpectating !== false
    };
  }

  function sendStatePing(targetPeerId) {
    pingAction.send(currentState(), targetPeerId ? { target: targetPeerId } : undefined);
  }

  function broadcastState() {
    sendStatePing();
  }

  function handleStreamingService() {
    const shouldStream = activeSpectators.size > 0 && getLocalMatchState() === 'MATCH';

    if (shouldStream && !broadcastTimer) {
      const interval = Math.round(1000 / BROADCAST_FPS);
      broadcastTimer = setInterval(captureAndDistributeFrame, interval);
    } else if (!shouldStream && broadcastTimer) {
      clearInterval(broadcastTimer);
      broadcastTimer = null;
    }
  }

  function captureAndDistributeFrame() {
    const canvas = document.getElementById('canvas');
    if (!canvas || getLocalMatchState() !== 'MATCH') {
      handleStreamingService();
      return;
    }

    try {
      const ratio = TARGET_STREAM_WIDTH / canvas.width;
      let sourceCanvas = canvas;

      if (ratio < 1) {
        scaleCanvas.width = TARGET_STREAM_WIDTH;
        scaleCanvas.height = canvas.height * ratio;
        scaleCtx.drawImage(canvas, 0, 0, scaleCanvas.width, scaleCanvas.height);
        sourceCanvas = scaleCanvas;
      }

      sourceCanvas.toBlob((blob) => {
        if (!blob) return;
        activeSpectators.forEach((peerId) => {
          frameAction.send(blob, { target: peerId });
        });
      }, 'image/webp', 0.8);
    } catch (e) {
      console.error('Frame processing failure: ', e);
    }
  }

  function updateUI() {
    const list = document.getElementById('p2p-list');
    if (!list) return;

    list.innerHTML = '';

    // Filter registry to only include peers who allow spectating
    const visiblePeers = [];
    playerRegistry.forEach((data, peerId) => {
      if (data.allowSpectating) {
        visiblePeers.push({ peerId, data });
      }
    });

    if (visiblePeers.length === 0) {
      list.innerHTML = '<div class="p2p-status-message">Scanning global network...</div>';
      return;
    }

    visiblePeers.forEach(({ peerId, data }) => {
      const item = document.createElement('div');
      item.className = 'p2p-item';

      const meta = document.createElement('div');
      meta.className = 'p2p-meta';
      const stateLabel =
        data.matchState === 'MATCH'
          ? '<span style="color:#6fffa0;">Match</span>'
          : data.matchState === 'DEAD'
          ? '<span style="color:var(--red-hot,#FF2E42);">Dead</span>'
          : '<span style="color:#888;">Lobby</span>';
      meta.innerHTML = `
        <div class="p2p-name" title="${data.username}">${data.username}</div>
        <div class="p2p-info">${data.region} • ${data.mode} • ${stateLabel}</div>
      `;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'p2p-btn';

      if (spectatingPeerId === peerId) {
        btn.textContent = 'STOP';
        btn.className += ' active';
        btn.onclick = exitSpectatorView;
      } else {
        btn.textContent = 'SPECTATE';
        if (data.matchState !== 'MATCH') {
          btn.disabled = true;
          btn.style.opacity = '0.4';
          btn.style.cursor = 'not-allowed';
        } else {
          btn.onclick = () => startSpectating(peerId);
        }
      }

      item.appendChild(meta);
      item.appendChild(btn);
      list.appendChild(item);
    });
  }

  function startSpectating(peerId) {
    const data = playerRegistry.get(peerId);
    if (!data || data.matchState !== 'MATCH') return; // can't spectate someone who isn't live

    if (spectatingPeerId) exitSpectatorView();

    spectatingPeerId = peerId;
    spectatedMatchState = 'MATCH';
    subscribeAction.send(null, { target: peerId });

    const notice = document.getElementById('spectator-death-notice');
    if (notice) notice.style.display = 'none';

    document.getElementById('spectator-overlay').style.display = 'flex';
    document.body.classList.add('spectating-active');
    updateUI();
  }

  // Called when a state update arrives for the peer we're currently
  // watching. Doesn't tear down the subscription — we stay subscribed so
  // that if/when they respawn, frames just start flowing again on their
  // own and the view resumes automatically.
  function handleSpectatedStateChange(matchState) {
    spectatedMatchState = matchState;
    const view = document.getElementById('spectator-render-view');
    const notice = document.getElementById('spectator-death-notice');
    if (!notice) return;

    if (matchState === 'DEAD') {
      if (view) view.removeAttribute('src');
      notice.textContent = 'Player died — waiting for them to respawn...';
      notice.style.display = 'block';
    } else if (matchState === 'LOBBY') {
      if (view) view.removeAttribute('src');
      notice.textContent = 'Player left the match.';
      notice.style.display = 'block';
    } else {
      // Back in a live match — hide the notice, new frames will repopulate
      // the view as soon as the broadcaster's next capture tick fires.
      notice.style.display = 'none';
    }
  }

  function exitSpectatorView() {
    if (spectatingPeerId !== null) {
      unsubscribeAction.send(null, { target: spectatingPeerId });
      spectatingPeerId = null;
    }
    spectatedMatchState = null;

    const overlay = document.getElementById('spectator-overlay');
    if (overlay) overlay.style.display = 'none';

    const view = document.getElementById('spectator-render-view');
    if (view) view.removeAttribute('src');

    const notice = document.getElementById('spectator-death-notice');
    if (notice) notice.style.display = 'none';

    document.body.classList.remove('spectating-active');
    updateUI();
  }

  const stateSync = setInterval(() => {
    if (window.TamState) {
      clearInterval(stateSync);
      window.TamState.forceDisconnectSpectator = exitSpectatorView;
      window.TamState.getSpectatorCount = () => activeSpectators.size;
      initializeMod();
    }
  }, 100);
})();
