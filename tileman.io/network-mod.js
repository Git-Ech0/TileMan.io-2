/**
 * TileMan.io Cross-Server Spectator Mod (Trystero edition) — State-Sync
 *
 * Same P2P transport as before (Trystero / WebRTC, no signaling server
 * beyond the public relays used for the initial handshake). What changed
 * is *what* gets sent to a spectator and *how* it becomes pixels:
 *
 *   OLD: capture the broadcaster's <canvas> to a webp blob every frame,
 *        ship the image, spectator just displays it in an <img>.
 *   NEW: ship the broadcaster's game *state* (from window.TamState) —
 *        players, tile grid, camera — and let the spectator's own client
 *        redraw it locally. Cheaper, resolution-independent, and each
 *        spectator's view is reconstructed from data rather than mirrored
 *        video.
 *
 * The player registry / sub / unsub / ping machinery is unchanged; only
 * the payload that flows over what used to be `frameAction` changed, plus
 * the spectator view element itself is now a <canvas> instead of an <img>.
 */

import { joinRoom } from 'https://esm.run/trystero';
import {
  createSession, destroySession, applyKeyframe, applyDelta, startRenderLoop,
} from './spectator-renderer.js';

(function () {
  const APP_ID = 'tileman-io-p2p-spectator-v3';
  const ROOM_ID = 'global';

  // TURN relay fallback for peer pairs that can't establish a direct WebRTC
  // connection (symmetric NAT, restrictive firewalls, etc). Fill in
  // credentials from a TURN provider — e.g. Cloudflare Calls TURN (free
  // tier, https://developers.cloudflare.com/calls/turn/) or Open Relay
  // (https://www.metered.ca/tools/openrelay/). Leave empty for STUN-only.
  const TURN_SERVERS = [
    // {
    //   urls: 'turn:your-turn-server.example:3478',
    //   username: 'YOUR_TURN_USERNAME',
    //   credential: 'YOUR_TURN_CREDENTIAL'
    // }
  ];

  const PING_INTERVAL_MS = 3000;
  const DELTA_HZ = 24;                         // state ticks/sec sent to spectators (was 12 — the per-tick
                                                // diff scan is sub-ms at documented gridSize ranges, so there
                                                // was headroom; this was the real "why isn't it faster" cause)
  const KEYFRAME_RESYNC_MS = 8000;             // periodic full resync safety net

  let room = null;
  let pingAction, subscribeAction, unsubscribeAction, syncAction;

  const playerRegistry = new Map();   // peerId -> { username, region, mode, matchState, lastSeen, allowSpectating }
  const activeSpectators = new Set(); // peerIds currently watching our state
  let spectatingPeerId = null;
  let spectatedMatchState = null;
  let broadcastTimer = null;
  let lastKeyframeAt = 0;
  let lastKnownMatchState = null;

  // Broadcaster-side mirror of the grid, used purely to diff against the
  // live gridMatrix each tick so we only send cells that actually changed.
  let gridShadow = null; // flat array, gridShadow[x * gridSize + y] = color

  // Same idea for the minimap collision buffer (boolean[][] -> flat array).
  let collisionShadow = null;

  // Best-effort kill/capture feed forwarding. window.TamState.chatLog is a
  // drain queue (hra.min.js does chatLog.shift() to show one toast every
  // ~4.1s minimum), not an append-only log — so we can't just read it once.
  // Instead we snapshot it every delta tick and treat any *new* entries
  // since the last snapshot as messages to forward. Because the queue only
  // drains one entry per ~4.1s and we poll far more often than that, we'll
  // reliably see new entries before they're shifted out in the common case.
  // Edge case: if more than one entry is pushed and then shifted within a
  // single tick window, only the newest survives detection here.
  let lastChatSnapshot = [];

  // Spectator-side render session (created fresh each time we start watching someone)
  let spectatorSession = null;
  let stopRenderLoop = null;

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
    syncAction = room.makeAction('sync'); // carries { type: 'keyframe' | 'delta', ... }

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

      if (spectatingPeerId === peerId && (!previous || previous.matchState !== matchState)) {
        handleSpectatedStateChange(matchState);
      }
    };

    subscribeAction.onMessage = (_, { peerId }) => {
      if (window.TamState?.allowSpectating === false) return; // Reject incoming viewer
      activeSpectators.add(peerId);
      // Bring the new spectator up to date immediately; they can't apply
      // deltas meaningfully until they have a full keyframe to start from.
      sendKeyframe(peerId);
      handleStreamingService();
    };

    window.addEventListener('spectateSettingChanged', (e) => {
      const isAllowed = e.detail;
      broadcastState();

      if (!isAllowed) {
        activeSpectators.clear();
        handleStreamingService();
      }
    });

    unsubscribeAction.onMessage = (_, { peerId }) => {
      activeSpectators.delete(peerId);
      handleStreamingService();
    };

    syncAction.onMessage = (payload, { peerId }) => {
      if (spectatingPeerId !== peerId || !spectatorSession) return;
      if (payload.type === 'keyframe') {
        applyKeyframe(spectatorSession, payload);
      } else if (payload.type === 'delta' && spectatedMatchState === 'MATCH') {
        applyDelta(spectatorSession, payload);
      }
    };

    setInterval(broadcastState, PING_INTERVAL_MS);

    setInterval(() => {
      const state = getLocalMatchState();
      if (state !== lastKnownMatchState) {
        lastKnownMatchState = state;
        broadcastState();
        handleStreamingService();
      }
    }, 250);

    ensureSpectatorCanvas();
    const closeBtn = document.getElementById('spectator-close-btn');
    if (closeBtn) closeBtn.onclick = exitSpectatorView;

    updateUI();
  }

  // hra.min.js creates #spectator-render-view as an <img>; swap it for a
  // <canvas> at runtime so we never have to touch that file. Keeps this mod
  // fully self-contained and safe against upstream hra.min.js updates.
  function ensureSpectatorCanvas() {
    const existing = document.getElementById('spectator-render-view');
    if (existing && existing.tagName === 'CANVAS') return;

    const canvas = document.createElement('canvas');
    canvas.id = 'spectator-render-view';
    canvas.width = 1200;
    canvas.height = 675;
    if (existing) {
      existing.replaceWith(canvas);
    } else {
      const overlay = document.getElementById('spectator-overlay');
      if (overlay) overlay.appendChild(canvas);
    }
  }

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
      const interval = Math.round(1000 / DELTA_HZ);
      lastKeyframeAt = performance.now();
      broadcastTimer = setInterval(broadcastDelta, interval);
    } else if (!shouldStream && broadcastTimer) {
      clearInterval(broadcastTimer);
      broadcastTimer = null;
      // Force a fresh keyframe basis next time we start streaming.
      gridShadow = null;
      collisionShadow = null;
      lastChatSnapshot = [];
    }
  }

  // ─── Grid RLE encode (broadcaster side) ────────────────────────────────
  // Flat [color, runLength, ...] scanned column-major (x outer, y inner),
  // matching gridMatrix[x][y] access order. Mirrors decodeGridRLE() in
  // spectator-renderer.js.
  function encodeGridRLE(gridMatrix, gridSize) {
    const runs = [];
    for (let x = 0; x < gridSize; x++) {
      const col = gridMatrix[x];
      let y = 0;
      while (y < gridSize) {
        const color = col[y].c;
        let len = 1;
        while (y + len < gridSize && col[y + len].c === color) len++;
        runs.push(color, len);
        y += len;
      }
    }
    return runs;
  }

  function encodeCollisionBuffer(collisionBuffer, minimapWidth) {
    const flat = new Array(minimapWidth * minimapWidth).fill(0);
    if (!collisionBuffer) return flat;
    for (let mx = 0; mx < minimapWidth; mx++) {
      const col = collisionBuffer[mx];
      if (!col) continue;
      for (let my = 0; my < minimapWidth; my++) {
        if (col[my]) flat[mx * minimapWidth + my] = 1;
      }
    }
    return flat;
  }

  // The broadcaster's own personal render preferences — these live purely
  // client-side in hra_min.js and were never sent anywhere before now, so a
  // spectator's view could never actually match what the broadcaster sees.
  // Small primitives, cheap to send every tick alongside everything else.
  function buildViewerSettings() {
    const T = window.TamState;
    return {
      snakeSizeRatio: T.snakeSizeRatio,
      isCameraZoomEnabled: T.isCameraZoomEnabled,
      cameraZoomFactor: T.cameraZoomFactor,
      areAnimationsEnabled: T.areAnimationsEnabled,
      isMinimapProjectionEnabled: T.isMinimapProjectionEnabled,
      emptyCellColor: T.emptyCellColor,
      cellBgColor: T.cellBgColor,
      projectionShadowColor: T.projectionShadowColor,
      customSkinsEnabled: T.customSkinsEnabled,
    };
  }

  function sendKeyframe(targetPeerId) {
    const T = window.TamState;
    if (!T || getLocalMatchState() !== 'MATCH') return;

    const gridSize = T.gridSize;
    gridShadow = new Array(gridSize * gridSize);
    const grid = T.gridMatrix;
    for (let x = 0; x < gridSize; x++) {
      for (let y = 0; y < gridSize; y++) {
        gridShadow[x * gridSize + y] = grid[x][y].c;
      }
    }

    const minimapWidth = T.minimapWidth || 0;
    const collisionFlat = encodeCollisionBuffer(T.collisionBuffer, minimapWidth);
    collisionShadow = collisionFlat.slice();
    lastChatSnapshot = (T.chatLog || []).slice();

    syncAction.send({
      type: 'keyframe',
      gridSize,
      tiles: encodeGridRLE(grid, gridSize),
      colorPalette: T.colorPalette,
      // Raw colorPalette entries are unadjusted hex; activeColorPalette maps
      // each to what the broadcaster's own client actually paints with,
      // after their brightness/contrast preference is applied. Both
      // renderActiveGrid() and drawPlayer() key off activeColorPalette,
      // not colorPalette, so this is the one that actually matters visually.
      activeColorPalette: T.activeColorPalette,
      // TamState doesn't expose a live emptyCellColor getter (it's derived
      // from each viewer's own 'bgem' localStorage setting), so we send the
      // documented default and let the spectator apply their own theme.
      emptyCellColor: '#666666',
      backgroundColor: '#333333',
      arenaSetting: T.serverArenaSetting,
      bounds: {
        lobby: T.lobbyBoundsList || [],
        safe: T.safeZoneBounds || [],
        trail: T.trailBoundsList || [],
      },
      minimapWidth,
      collisionBuffer: collisionFlat,
      leaderboard: T.getScoreboardData ? T.getScoreboardData() : [],
      viewerSettings: buildViewerSettings(),
    }, { target: targetPeerId });
  }

  function buildPlayerDeltaPayload() {
    return window.TamState.players.map(function (p) {
      return {
        id: p.id,
        x: p.pos[0], y: p.pos[1],
        d: p.d,
        color: p.c,
        name: p.na,
        trail: p.trs,
        alive: p.de === null,
        deathT: p.de,
        invincible: p.nt !== null,
        invincibleT: p.nt,
        emote: p.b !== null ? { type: p.bt, t: p.b } : null,
      };
    });
  }

  function broadcastDelta() {
    const T = window.TamState;
    if (!T || getLocalMatchState() !== 'MATCH') {
      handleStreamingService();
      return;
    }

    // Periodic full resync in case a spectator's delta stream ever drifts
    // (e.g. reconnect edge cases) — cheap insurance, not required for
    // correctness in the common case since every active spectator already
    // received an initial keyframe on subscribe.
    if (performance.now() - lastKeyframeAt > KEYFRAME_RESYNC_MS) {
      lastKeyframeAt = performance.now();
      activeSpectators.forEach((peerId) => sendKeyframe(peerId));
    }

    const gridSize = T.gridSize;
    const grid = T.gridMatrix;
    const tileDiffs = [];
    if (gridShadow) {
      for (let x = 0; x < gridSize; x++) {
        const col = grid[x];
        for (let y = 0; y < gridSize; y++) {
          const idx = x * gridSize + y;
          const c = col[y].c;
          if (gridShadow[idx] !== c) {
            tileDiffs.push([x, y, c]);
            gridShadow[idx] = c;
          }
        }
      }
    }

    const minimapWidth = T.minimapWidth || 0;
    const collisionDiffs = [];
    if (collisionShadow && minimapWidth) {
      const flat = encodeCollisionBuffer(T.collisionBuffer, minimapWidth);
      for (let i = 0; i < flat.length; i++) {
        if (collisionShadow[i] !== flat[i]) {
          collisionDiffs.push([Math.floor(i / minimapWidth), i % minimapWidth, flat[i]]);
          collisionShadow[i] = flat[i];
        }
      }
    }

    // Best-effort new-message detection — see the comment on lastChatSnapshot
    // near the top of this file for why this is a heuristic, not exact.
    const currentChat = (T.chatLog || []).slice();
    const newChatMessages = currentChat.length > lastChatSnapshot.length
      ? currentChat.slice(lastChatSnapshot.length)
      : [];
    lastChatSnapshot = currentChat;

    const payload = {
      type: 'delta',
      selfId: T.getSelfId(),
      players: buildPlayerDeltaPayload(),
      tileDiffs,
      collisionDiffs,
      newChatMessages,
      cameraPos: T.cameraPos,
      cameraWidthDelta: T.cameraWidthDelta,
      cameraHeightDelta: T.cameraHeightDelta,
      hud: {
        finalScore: T.finalScore,
        totalKills: T.totalKills,
        pointScaleFactor: T.pointScaleFactor,
        killsComboCounter: T.killsComboCounter,
        capturedComboCounter: T.capturedComboCounter,
        respawnCooldownMs: T.respawnCooldownMs,
        // getRank() reads the broadcaster's own leaderboard DOM entry — this
        // is the one HUD value we genuinely can't compute from raw state,
        // so we forward whatever their own client already displays.
        rank: T.getRank(),
      },
      // Top-N leaderboard entries, read straight from TamState's own
      // getScoreboardData() helper. Small array, sent in full each tick —
      // not worth diffing.
      leaderboard: T.getScoreboardData ? T.getScoreboardData() : [],
      viewerSettings: buildViewerSettings(),
    };

    activeSpectators.forEach((peerId) => {
      syncAction.send(payload, { target: peerId });
    });
  }

  function updateUI() {
    const list = document.getElementById('p2p-list');
    if (!list) return;

    list.innerHTML = '';

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
    if (!data || data.matchState !== 'MATCH') return;

    if (spectatingPeerId) exitSpectatorView();

    spectatingPeerId = peerId;
    spectatedMatchState = 'MATCH';
    spectatorSession = createSession();
    subscribeAction.send(null, { target: peerId });

    const notice = document.getElementById('spectator-death-notice');
    if (notice) notice.style.display = 'none';

    ensureSpectatorCanvas();
    const canvas = document.getElementById('spectator-render-view');
    document.getElementById('spectator-overlay').style.display = 'flex';
    document.body.classList.add('spectating-active');
    stopRenderLoop = startRenderLoop(canvas, spectatorSession);
    updateUI();
  }

  function handleSpectatedStateChange(matchState) {
    spectatedMatchState = matchState;
    const notice = document.getElementById('spectator-death-notice');
    if (!notice) return;

    if (matchState === 'DEAD') {
      notice.textContent = 'Player died — waiting for them to respawn...';
      notice.style.display = 'block';
    } else if (matchState === 'LOBBY') {
      notice.textContent = 'Player left the match.';
      notice.style.display = 'block';
    } else {
      notice.style.display = 'none';
    }
  }

  function exitSpectatorView() {
    if (spectatingPeerId !== null) {
      unsubscribeAction.send(null, { target: spectatingPeerId });
      spectatingPeerId = null;
    }
    spectatedMatchState = null;

    if (stopRenderLoop) {
      stopRenderLoop();
      stopRenderLoop = null;
    }
    if (spectatorSession) {
      destroySession(spectatorSession);
      spectatorSession = null;
    }

    const overlay = document.getElementById('spectator-overlay');
    if (overlay) overlay.style.display = 'none';

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
