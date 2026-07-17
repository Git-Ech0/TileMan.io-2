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
  const APP_ID = 'tileman-io-p2p-spectator-v1';
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
  const TARGET_STREAM_WIDTH = 600;

  let room = null;
  let pingAction, subscribeAction, unsubscribeAction, frameAction;

  const playerRegistry = new Map();   // peerId -> { username, region, mode, isPlaying, lastSeen }
  const activeSpectators = new Set(); // peerIds currently watching our stream
  let spectatingPeerId = null;
  let broadcastTimer = null;

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
      playerRegistry.set(peerId, {
        username: state.username || 'Unnamed Slot',
        region: state.region || 'Default',
        mode: state.mode || 'Default',
        isPlaying: !!state.isPlaying,
        lastSeen: Date.now()
      });
      updateUI();
    };

    subscribeAction.onMessage = (_, { peerId }) => {
      activeSpectators.add(peerId);
      handleStreamingService();
    };

    unsubscribeAction.onMessage = (_, { peerId }) => {
      activeSpectators.delete(peerId);
      handleStreamingService();
    };

    frameAction.onMessage = (blobData, { peerId }) => {
      if (spectatingPeerId === peerId) {
        const renderView = document.getElementById('spectator-render-view');
        if (renderView) renderView.src = URL.createObjectURL(new Blob([blobData]));
      }
    };

    setInterval(broadcastState, PING_INTERVAL_MS);

    const closeBtn = document.getElementById('spectator-close-btn');
    if (closeBtn) closeBtn.onclick = exitSpectatorView;

    updateUI();
  }

  function currentState() {
    return {
      username: window.TamState?.getSelfName() || localStorage['n'] || 'Player',
      region: window.TamState?.selectedRegion || 'Default',
      mode: window.TamState?.selectedMode || 'Default',
      isPlaying: !!(window.TamState?.isGameActive)
    };
  }

  function sendStatePing(targetPeerId) {
    pingAction.send(currentState(), targetPeerId ? { target: targetPeerId } : undefined);
  }

  function broadcastState() {
    sendStatePing();
  }

  function handleStreamingService() {
    const activeMatch = window.TamState?.isGameActive;
    const shouldStream = activeSpectators.size > 0 && activeMatch;

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
    if (!canvas || !window.TamState?.isGameActive) {
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
      }, 'image/jpeg', 0.4);
    } catch (e) {
      console.error('Frame processing failure: ', e);
    }
  }

  function updateUI() {
    const list = document.getElementById('p2p-list');
    if (!list) return;

    list.innerHTML = '';

    if (playerRegistry.size === 0) {
      list.innerHTML = '<div class="p2p-status-message">Scanning global network...</div>';
      return;
    }

    playerRegistry.forEach((data, peerId) => {
      const item = document.createElement('div');
      item.className = 'p2p-item';

      const meta = document.createElement('div');
      meta.className = 'p2p-meta';
      meta.innerHTML = `
        <div class="p2p-name" title="${data.username}">${data.username}</div>
        <div class="p2p-info">${data.region} • ${data.mode} • ${data.isPlaying ? '<span style="color:#6fffa0;">Match</span>' : '<span style="color:#888;">Lobby</span>'}</div>
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
        if (!data.isPlaying) {
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
    if (spectatingPeerId) exitSpectatorView();

    spectatingPeerId = peerId;
    subscribeAction.send(null, { target: peerId });

    document.getElementById('spectator-overlay').style.display = 'flex';
    document.body.classList.add('spectating-active');
    updateUI();
  }

  function exitSpectatorView() {
    if (spectatingPeerId !== null) {
      unsubscribeAction.send(null, { target: spectatingPeerId });
      spectatingPeerId = null;
    }

    const overlay = document.getElementById('spectator-overlay');
    if (overlay) overlay.style.display = 'none';

    const view = document.getElementById('spectator-render-view');
    if (view) view.removeAttribute('src');

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
