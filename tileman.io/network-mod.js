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
 *
 * Also new: a standing 'pos' broadcast (see broadcastPosition/
 * getRemoteMatchPlayers below) that has nothing to do with spectating. Any
 * two clients who are actively playing in the same region+mode+gridSize
 * continuously trade bare position + display-color updates over this same
 * P2P mesh, so hra_min.js_3Ffu's minimap can plot every player in the
 * match, not just whichever ones the game server itself has told this
 * client about.
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
  const DELTA_HZ = 24;                         // state ticks/sec sent to spectators. This constant used to be
                                                // declared but never actually wired up: MIN_DELTA_FRAME_MS was
                                                // derived from a separate MAX_DELTA_HZ=60 constant instead, so
                                                // deltas were really going out at up to 60/sec (rAF-capped),
                                                // not the ~24/sec the old comment here claimed. Deriving the
                                                // throttle from DELTA_HZ for real fixes that wiring bug, and
                                                // 24 vs the actual 60/sec that was going out is exactly the
                                                // ~60% cut requested (keeps 40% of the real current rate).
  const MIN_DELTA_FRAME_MS = 1000 / DELTA_HZ;
  const KEYFRAME_RESYNC_MS = 8000;             // periodic full resync safety net

  // Lightweight, always-on position broadcast so every player in the same
  // match can show up on each other's in-game minimap — independent of the
  // keyframe/delta stream above, which only runs for peers actively being
  // spectated. This one is tiny (a couple of numbers plus a color) and goes
  // out to the whole room continuously while a match is active, whether or
  // not anyone happens to be spectating.
  const POSITION_HZ = 8;
  const MIN_POSITION_FRAME_MS = 1000 / POSITION_HZ;
  const REMOTE_POSITION_STALE_MS = 4000; // drop a peer's marker if they've gone quiet this long

  let room = null;
  let pingAction, subscribeAction, unsubscribeAction, syncAction, positionAction, chatAction;

  const playerRegistry = new Map();   // peerId -> { username, region, mode, matchState, lastSeen, allowSpectating }
  const activeSpectators = new Set(); // peerIds currently watching our state

  // Room-wide P2P chat. Nothing here ever touches localStorage/history —
  // it's peer-to-peer with no server backing it, so the log is purely
  // in-memory and starts fresh every time this mod initializes. Capped so
  // a long session doesn't grow this unboundedly.
  const CHAT_HISTORY_LIMIT = 200;
  const chatMessages = []; // [{ name, text, sentAt, isSelf }]
  let activeP2PTab = 'players';
  // peerId -> { x, y, color, activeColor, name, region, mode, gridSize, receivedAt }
  // Same-match player positions received via positionAction, used to draw
  // everyone's dot on the in-game minimap. See broadcastPosition() /
  // getRemoteMatchPlayers() below.
  const remoteMatchPositions = new Map();
  let spectatingPeerId = null;
  let spectatedMatchState = null;
  let broadcastTimer = null;
  let lastBroadcastFrameAt = 0;
  let broadcastSeq = 0;
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
    positionAction = room.makeAction('pos'); // carries { x, y, color, activeColor, name, region, mode, gridSize }
    chatAction = room.makeAction('chat'); // carries { name, text, sentAt } — broadcast to the whole room, no target

    room.onPeerJoin = (peerId) => {
      sendStatePing(peerId);
    };

    room.onPeerLeave = (peerId) => {
      playerRegistry.delete(peerId);
      activeSpectators.delete(peerId);
      remoteMatchPositions.delete(peerId);
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
      // Ping is the authoritative "are you still in a match" signal, so use
      // it to clear a stale marker right away instead of waiting out
      // REMOTE_POSITION_STALE_MS (e.g. player died or returned to lobby).
      if (matchState !== 'MATCH') {
        remoteMatchPositions.delete(peerId);
      }
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
      } else if (payload.type === 'delta') {
        // broadcastDelta() diffs against a single shared gridShadow and just
        // fires the result at every spectator — there's no per-peer ack, so
        // if THIS delta message gets dropped (packet loss on a laggy/lossy
        // P2P connection), whatever tiles changed in that tick are gone for
        // good: the broadcaster's shadow has already moved on and won't
        // re-diff those cells again. Previously the only recovery was the
        // periodic 8s keyframe resync, so a consistently lossy peer could
        // end up with tiles that never come back (or flicker in every 8s
        // just to drop out again). `sequence` was already being tracked to
        // reject stale/out-of-order packets, but nothing checked for GAPS.
        // Detect a gap here and immediately re-subscribe — the broadcaster's
        // subscribeAction handler sends a fresh keyframe unconditionally, so
        // this self-heals within one round-trip instead of up to 8s.
        const priorSeq = spectatorSession.sequence;
        const gapDetected = payload.sequence !== undefined
          && priorSeq !== undefined && priorSeq !== -1
          && payload.sequence > priorSeq + 1;
        applyDelta(spectatorSession, payload);
        if (gapDetected) {
          subscribeAction.send(null, { target: peerId });
        }
      }
    };

    positionAction.onMessage = (data, { peerId }) => {
      if (!data || typeof data.x !== 'number' || typeof data.y !== 'number') return;
      remoteMatchPositions.set(peerId, {
        x: data.x,
        y: data.y,
        color: data.color,
        activeColor: data.activeColor || data.color,
        name: data.name || '',
        region: data.region,
        mode: data.mode,
        gridSize: data.gridSize,
        receivedAt: Date.now(),
      });
    };

    chatAction.onMessage = (data, { peerId }) => {
      if (!data || typeof data.text !== 'string') return;
      const text = data.text.trim().slice(0, 300);
      if (!text) return;
      const registryEntry = playerRegistry.get(peerId);
      const name = (typeof data.name === 'string' && data.name.trim())
        || registryEntry?.username
        || 'Unnamed Slot';
      const chatColor = isPlausibleHexColor(data.chatColor) ? data.chatColor : null;
      addChatMessage({
        name: name.slice(0, 40),
        text,
        sentAt: typeof data.sentAt === 'number' ? data.sentAt : Date.now(),
        isSelf: false,
        chatColor,
      });
    };

    setInterval(broadcastPosition, MIN_POSITION_FRAME_MS);
    setInterval(pruneStalePositions, 1000);

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

    initChatUI();
    updateUI();
  }

  // ─── Chat tab (Players/Chat switching + sending) ───────────────────────
  function initChatUI() {
    const tabPlayers = document.getElementById('p2p-tab-players');
    const tabChat = document.getElementById('p2p-tab-chat');
    const listEl = document.getElementById('p2p-list');
    const chatEl = document.getElementById('p2p-chat');
    const chatInput = document.getElementById('p2p-chat-input');
    const chatSendBtn = document.getElementById('p2p-chat-send');

    if (tabPlayers) tabPlayers.onclick = () => activateP2PTab('players');
    if (tabChat) tabChat.onclick = () => activateP2PTab('chat');

    function trySend() {
      if (!chatInput) return;
      const text = chatInput.value.trim().slice(0, 300);
      if (!text) return;
      const name = currentState().username;
      const chatColor = getOwnChatColor();
      const sentAt = Date.now();
      chatAction.send({ name, text, sentAt, chatColor });
      addChatMessage({ name, text, sentAt, isSelf: true, chatColor });
      chatInput.value = '';
      if (chatSendBtn) chatSendBtn.disabled = true;
    }

    if (chatSendBtn) chatSendBtn.onclick = trySend;
    if (chatInput) {
      chatInput.addEventListener('input', () => {
        if (chatSendBtn) chatSendBtn.disabled = chatInput.value.trim().length === 0;
      });
      chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          trySend();
        }
      });
    }

    // Not switching tabs here — just making sure the panels reflect
    // whatever activeP2PTab already is (relevant if this ever re-runs).
    if (listEl) listEl.style.display = activeP2PTab === 'players' ? 'block' : 'none';
    if (chatEl) chatEl.style.display = activeP2PTab === 'chat' ? 'flex' : 'none';
  }

  function activateP2PTab(tab) {
    activeP2PTab = tab;
    const tabPlayers = document.getElementById('p2p-tab-players');
    const tabChat = document.getElementById('p2p-tab-chat');
    const listEl = document.getElementById('p2p-list');
    const chatEl = document.getElementById('p2p-chat');
    const chatDot = document.getElementById('p2p-chat-dot');

    if (tabPlayers) tabPlayers.classList.toggle('active', tab === 'players');
    if (tabChat) tabChat.classList.toggle('active', tab === 'chat');
    if (listEl) listEl.style.display = tab === 'players' ? 'block' : 'none';
    if (chatEl) chatEl.style.display = tab === 'chat' ? 'flex' : 'none';

    if (tab === 'chat') {
      if (chatDot) chatDot.classList.remove('visible');
      scrollChatToBottom();
    }
  }

  // Fallback only — used when a chat message doesn't carry a chatColor
  // (e.g. it came from a peer running an older client build). The normal
  // path is msg.chatColor, computed by the sender as the color they'd
  // actually spawn as right now (see getOwnChatColor() below), so chat
  // names match each person's real in-game color instead of an arbitrary
  // cosmetic one.
  const CHAT_NAME_PALETTE = ['#52A8FF', '#FF7733', '#6fffa0', '#FF2E42', '#FFD700', '#c792ff', '#4ce0d2'];
  function chatNameColor(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
    return CHAT_NAME_PALETTE[hash % CHAT_NAME_PALETTE.length];
  }

  // What color would *we* spawn as right now? hra.min.js owns the actual
  // rules (custom color, else first non-taken color from the player's
  // selected list) since it already has the localStorage settings and the
  // live match's player list in scope — this just asks for the answer.
  function getOwnChatColor() {
    return window.TamState?.getChatColor ? window.TamState.getChatColor() : null;
  }

  // Basic sanity check on a color coming from a peer over the wire before
  // it ever reaches a style property — not a security boundary (invalid
  // CSS color values are just silently ignored by the browser), just
  // enough to keep a malformed message from a broken client from looking
  // strange in the chat log.
  function isPlausibleHexColor(value) {
    return typeof value === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(value);
  }

  function formatChatTime(ts) {
    const d = new Date(ts);
    let hours = d.getHours();
    const minutes = d.getMinutes().toString().padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    if (hours === 0) hours = 12;
    return hours + ':' + minutes + ' ' + ampm;
  }

  function renderChatMessage(msg) {
    const container = document.getElementById('p2p-chat-messages');
    if (!container) return;
    const placeholder = container.querySelector('.p2p-status-message');
    if (placeholder) placeholder.remove();

    const row = document.createElement('div');
    row.className = 'p2p-chat-msg';

    const time = document.createElement('span');
    time.className = 'p2p-chat-time';
    time.textContent = formatChatTime(msg.sentAt);
    row.appendChild(time);

    const body = document.createElement('div');
    body.className = 'p2p-chat-body';

    // .textContent (not innerHTML) throughout — name and text both come
    // from an untrusted peer over the wire, so this keeps them as inert
    // text no matter what's in them.
    const name = document.createElement('span');
    name.className = 'p2p-chat-name';
    name.textContent = msg.name;
    name.style.color = msg.isSelf ? 'var(--text-primary)' : (msg.chatColor || chatNameColor(msg.name));
    body.appendChild(name);

    const text = document.createElement('span');
    text.className = 'p2p-chat-text';
    text.textContent = msg.text;
    body.appendChild(text);

    row.appendChild(body);
    container.appendChild(row);

    while (container.children.length > CHAT_HISTORY_LIMIT) {
      container.removeChild(container.firstChild);
    }
  }

  function scrollChatToBottom() {
    const container = document.getElementById('p2p-chat-messages');
    if (container) container.scrollTop = container.scrollHeight;
  }

  function addChatMessage(msg) {
    chatMessages.push(msg);
    if (chatMessages.length > CHAT_HISTORY_LIMIT) chatMessages.shift();
    renderChatMessage(msg);

    if (activeP2PTab === 'chat') {
      scrollChatToBottom();
    } else if (!msg.isSelf) {
      const chatDot = document.getElementById('p2p-chat-dot');
      if (chatDot) chatDot.classList.add('visible');
    }
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

  // Continuous, low-overhead position broadcast — separate from the
  // keyframe/delta stream (which only targets active spectators) so every
  // player currently in a match can plot every other same-match player on
  // their own in-game minimap, not just whoever the game server happens to
  // have already told this specific client about. The color sent is each
  // player's own activeColorPalette entry (i.e. post brightness/custom-color
  // settings) — exactly what they see on their own screen.
  function broadcastPosition() {
    const T = window.TamState;
    if (!T || !T.isGameActive) return;
    if (T.localPlayer && T.localPlayer.de !== null) return; // don't broadcast while dead
    const pos = T.getSelfPos();
    if (!pos) return;
    const rawColor = T.getSelfColor();
    const activeColor = (T.activeColorPalette && T.activeColorPalette[rawColor]) || rawColor;
    positionAction.send({
      x: pos.x,
      y: pos.y,
      color: rawColor,
      activeColor,
      name: T.getSelfName() || 'Player',
      region: T.selectedRegion,
      mode: T.selectedMode,
      gridSize: T.gridSize,
    });
  }

  function pruneStalePositions() {
    const now = Date.now();
    remoteMatchPositions.forEach((data, peerId) => {
      if (now - data.receivedAt > REMOTE_POSITION_STALE_MS) {
        remoteMatchPositions.delete(peerId);
      }
    });
  }

  // Same-match players only. The room is one shared "global" P2P mesh
  // carrying every region/mode at once, so this filters down to peers who
  // could plausibly be on the same map as the local player (same region,
  // mode, and grid size) before handing their positions to the renderer.
  function getRemoteMatchPlayers() {
    const T = window.TamState;
    if (!T || !T.isGameActive) return [];
    const region = T.selectedRegion;
    const mode = T.selectedMode;
    const gridSize = T.gridSize;
    const out = [];
    remoteMatchPositions.forEach((data) => {
      if (data.region === region && data.mode === mode && data.gridSize === gridSize) {
        out.push({ x: data.x, y: data.y, color: data.activeColor || data.color, name: data.name });
      }
    });
    return out;
  }

  function handleStreamingService() {
    const localMatchState = getLocalMatchState();
    const shouldStream = activeSpectators.size > 0 &&
      (localMatchState === 'MATCH' || localMatchState === 'DEAD');

    if (shouldStream && !broadcastTimer) {
      lastKeyframeAt = performance.now();
      lastBroadcastFrameAt = 0;
      activeSpectators.forEach((peerId) => sendKeyframe(peerId));
      broadcastTimer = requestAnimationFrame(broadcastPump);
    } else if (!shouldStream && broadcastTimer) {
      cancelAnimationFrame(broadcastTimer);
      broadcastTimer = null;
      // Force a fresh keyframe basis next time we start streaming.
      gridShadow = null;
      collisionShadow = null;
      lastChatSnapshot = [];
    }
  }

  function broadcastPump(now) {
    if (!broadcastTimer) return;
    if (now - lastBroadcastFrameAt >= MIN_DELTA_FRAME_MS) {
      lastBroadcastFrameAt = now;
      broadcastDelta();
    }
    if (broadcastTimer) broadcastTimer = requestAnimationFrame(broadcastPump);
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

  function clonePoint(point) {
    return point ? [point[0], point[1]] : null;
  }

  function cloneTrail(trail) {
    const out = [];
    if (!trail) return out;
    for (let i = 0; i < trail.length; i++) {
      out.push([trail[i][0], trail[i][1]]);
    }
    return out;
  }

  function buildDisplaySnapshot() {
    const T = window.TamState;
    return T?.getDisplaySnapshot ? T.getDisplaySnapshot() : null;
  }

  function buildPathfindingSnapshot() {
    const T = window.TamState;
    return T?.getPathfindingSnapshot ? T.getPathfindingSnapshot() : { selfPath: [], enemyPaths: [] };
  }

  // The broadcaster's own personal render preferences — these live purely
  // client-side in hra_min.js and were never sent anywhere before now, so a
  // spectator's view could never actually match what the broadcaster sees.
  // Small primitives, cheap to send every tick alongside everything else.
  function buildViewerSettings() {
    const T = window.TamState;
    if (T?.getRenderSettings) return T.getRenderSettings();
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
      showNames: T.showNames,
      renderServerPosition: T.renderServerPosition,
    };
  }

  function sendKeyframe(targetPeerId) {
    const T = window.TamState;
    const matchState = getLocalMatchState();
    if (!T || matchState === 'LOBBY' || !T.gridMatrix || !T.gridSize) return;

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
    const viewerSettings = buildViewerSettings();

    syncAction.send({
      type: 'keyframe',
      schema: 2,
      sequence: ++broadcastSeq,
      sentAt: performance.now(),
      matchState,
      gridSize,
      tiles: encodeGridRLE(grid, gridSize),
      tileAnimations: T.getTileAnimationSnapshot ? T.getTileAnimationSnapshot() : [],
      colorPalette: viewerSettings?.colors?.colorPalette || T.colorPalette,
      // Raw colorPalette entries are unadjusted hex; activeColorPalette maps
      // each to what the broadcaster's own client actually paints with,
      // after their brightness/contrast preference is applied. Both
      // renderActiveGrid() and drawPlayer() key off activeColorPalette,
      // not colorPalette, so this is the one that actually matters visually.
      activeColorPalette: viewerSettings?.colors?.activeColorPalette || T.activeColorPalette,
      // TamState doesn't expose a live emptyCellColor getter (it's derived
      // from each viewer's own 'bgem' localStorage setting), so we send the
      // documented default and let the spectator apply their own theme.
      emptyCellColor: viewerSettings?.colors?.emptyCellColor || T.emptyCellColor || '#666666',
      backgroundColor: viewerSettings?.colors?.cellBgColor || T.cellBgColor || '#333333',
      arenaSetting: T.serverArenaSetting,
      bounds: {
        lobby: T.lobbyBoundsList || [],
        safe: T.safeZoneBounds || [],
        trail: T.trailBoundsList || [],
      },
      minimapWidth,
      collisionBuffer: collisionFlat,
      players: buildPlayerDeltaPayload(),
      selfId: T.getSelfId(),
      cameraPos: clonePoint(T.cameraPos),
      cameraWidthDelta: T.cameraWidthDelta,
      cameraHeightDelta: T.cameraHeightDelta,
      hud: buildHudPayload(),
      leaderboard: T.getScoreboardData ? T.getScoreboardData() : [],
      display: buildDisplaySnapshot(),
      pathfinding: buildPathfindingSnapshot(),
      viewerSettings,
      renderSettings: viewerSettings,
    }, { target: targetPeerId });
  }

  function buildPlayerDeltaPayload() {
    const T = window.TamState;
    const now = performance.now();
    if (T.getRenderPlayers) {
      return T.getRenderPlayers().map(function (p) {
        return {
          id: p.id,
          x: p.pos ? p.pos[0] : 0,
          y: p.pos ? p.pos[1] : 0,
          pos: p.pos,
          d: p.d,
          color: p.c,
          name: p.na,
          trail: p.trs || [],
          isLocal: p.m,
          alive: p.deAgeMs === null,
          deathAgeMs: p.deAgeMs,
          invincible: p.ntAgeMs !== null,
          invincibleAgeMs: p.ntAgeMs,
          emote: p.bAgeMs !== null ? { type: p.bt, ageMs: p.bAgeMs } : null,
          serverPosition: p.serPos,
          serverDirection: p.serD,
          setAgeMs: p.setAgeMs,
        };
      });
    }
    return T.players.map(function (p) {
      return {
        id: p.id,
        x: p.pos[0], y: p.pos[1],
        pos: clonePoint(p.pos),
        d: p.d,
        color: p.c,
        name: p.na,
        trail: cloneTrail(p.trs),
        isLocal: !!p.m,
        alive: p.de === null,
        deathAgeMs: p.de === null ? null : now - p.de,
        invincible: p.nt !== null,
        invincibleAgeMs: p.nt === null ? null : now - p.nt,
        emote: p.b !== null ? { type: p.bt, ageMs: now - p.b } : null,
        serverPosition: clonePoint(p.serPos),
        serverDirection: typeof p.serD === 'undefined' ? null : p.serD,
        setAgeMs: p.setTime === null || typeof p.setTime === 'undefined' ? null : now - p.setTime,
      };
    });
  }

  function buildHudPayload() {
    const T = window.TamState;
    return {
      finalScore: T.finalScore,
      totalKills: T.totalKills,
      pointScaleFactor: T.pointScaleFactor,
      killsComboCounter: T.killsComboCounter,
      capturedComboCounter: T.capturedComboCounter,
      respawnCooldownMs: T.respawnCooldownMs,
      rank: T.getRank(),
      stats: T.getStats ? T.getStats() : null,
    };
  }

  function broadcastDelta() {
    const T = window.TamState;
    const matchState = getLocalMatchState();
    if (!T || matchState === 'LOBBY') {
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

    const now = performance.now();
    const gridSize = T.gridSize;
    const grid = T.gridMatrix;
    const tileDiffs = [];
    if (gridShadow) {
      for (let x = 0; x < gridSize; x++) {
        const col = grid[x];
        for (let y = 0; y < gridSize; y++) {
          const idx = x * gridSize + y;
          const cell = col[y];
          const c = cell.c;
          if (gridShadow[idx] !== c) {
            tileDiffs.push([x, y, c, cell.t === null ? null : Math.max(0, now - cell.t)]);
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

    const viewerSettings = buildViewerSettings();
    const payload = {
      type: 'delta',
      schema: 2,
      sequence: ++broadcastSeq,
      sentAt: now,
      matchState,
      selfId: T.getSelfId(),
      players: buildPlayerDeltaPayload(),
      tileDiffs,
      collisionDiffs,
      newChatMessages,
      tileAnimations: T.getTileAnimationSnapshot ? T.getTileAnimationSnapshot() : [],
      cameraPos: clonePoint(T.cameraPos),
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
        stats: T.getStats ? T.getStats() : null,
      },
      // Top-N leaderboard entries, read straight from TamState's own
      // getScoreboardData() helper. Small array, sent in full each tick —
      // not worth diffing.
      leaderboard: T.getScoreboardData ? T.getScoreboardData() : [],
      display: buildDisplaySnapshot(),
      pathfinding: buildPathfindingSnapshot(),
      viewerSettings,
      renderSettings: viewerSettings,
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
        if (data.matchState === 'LOBBY') {
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
    if (!data || data.matchState === 'LOBBY') return;

    if (spectatingPeerId) exitSpectatorView();

    spectatingPeerId = peerId;
    spectatedMatchState = data.matchState;
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
      notice.style.display = 'none';
      return;
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
      window.TamState.getRemoteMatchPlayers = getRemoteMatchPlayers;
      initializeMod();
    }
  }, 100);
})();
