/**
 * TileMan.io Cross-Server Spectator Mod
 * Handles P2P stream state against static index.html and style.css components
 */

(function () {
  const SLOT_PREFIX = 'tileman-slot-';
  const MAX_SLOTS = 15;
  const SCAN_INTERVAL_MS = 2000;
  const BROADCAST_FPS = 15;
  const STALE_PEER_TIMEOUT_MS = 6000;

  let mySlotId = null;
  let peer = null;
  const activeConnections = new Map(); 
  const playerRegistry = new Map();    
  const activeSpectators = new Set();  
  let spectatingSlot = null;           
  let broadcastTimer = null;           

  function initializeMod() {
    const slotsToTry = Array.from({ length: MAX_SLOTS }, (_, i) => i + 1)
      .sort(() => Math.random() - 0.5);

    function attemptNextSlot(list) {
      if (list.length === 0) {
        const msg = document.querySelector('.p2p-status-message');
        if (msg) msg.textContent = 'All spectator slots are currently occupied.';
        return;
      }

      const slot = list.pop();
      const targetId = `${SLOT_PREFIX}${slot}`;
      
      const tempPeer = new Peer(targetId, {
        debug: 1,
        config: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
          ]
        }
      });

      tempPeer.on('open', () => {
        mySlotId = slot;
        peer = tempPeer;
        
        const mySlotTag = document.getElementById('p2p-my-slot');
        if (mySlotTag) {
          mySlotTag.textContent = `SLOT #${mySlotId}`;
        }
        
        setupMeshCallbacks();
      });

      tempPeer.on('error', (err) => {
        if (err.type === 'unavailable-id') {
          tempPeer.destroy();
          attemptNextSlot(list);
        } else {
          console.error(`P2P registry lookup error:`, err);
        }
      });
    }

    attemptNextSlot(slotsToTry);
  }

  function setupMeshCallbacks() {
    peer.on('connection', (conn) => {
      const match = conn.peer.match(/tileman-slot-(\d+)/);
      if (match) {
        const remoteSlot = parseInt(match[1], 10);
        setupConnectionHandlers(conn, remoteSlot);
      }
    });

    setInterval(scanNetworkMesh, SCAN_INTERVAL_MS);
    setInterval(evictDeadNodes, 3000);

    const closeBtn = document.getElementById('spectator-close-btn');
    if (closeBtn) {
      closeBtn.onclick = exitSpectatorView;
    }

    updateUI();
  }

  function scanNetworkMesh() {
    if (!peer || peer.destroyed) return;

    for (let s = 1; s <= MAX_SLOTS; s++) {
      if (s === mySlotId) continue;

      const connectionActive = activeConnections.has(s);
      if (connectionActive) {
        const conn = activeConnections.get(s);
        if (conn.open) sendStatePing(conn);
      } else if (mySlotId < s) {
        connectToPeer(s);
      }
    }
  }

  function connectToPeer(targetSlot) {
    const targetPeerId = `${SLOT_PREFIX}${targetSlot}`;
    const conn = peer.connect(targetPeerId, { serialization: 'json' });
    setupConnectionHandlers(conn, targetSlot);
  }

  function setupConnectionHandlers(conn, slotNum) {
    conn.on('open', () => {
      activeConnections.set(slotNum, conn);
      sendStatePing(conn);
    });

    conn.on('data', (payload) => {
      if (!payload || typeof payload !== 'object') return;

      switch (payload.type) {
        case 'PING':
          playerRegistry.set(slotNum, {
            username: payload.username || 'Unnamed Slot',
            region: payload.region || 'Default',
            mode: payload.mode || 'Default',
            isPlaying: !!payload.isPlaying,
            lastSeen: Date.now()
          });
          updateUI();
          break;

        case 'SUBSCRIBE_STREAM':
          activeSpectators.add(slotNum);
          handleStreamingService();
          break;

        case 'UNSUBSCRIBE_STREAM':
          activeSpectators.delete(slotNum);
          handleStreamingService();
          break;

        case 'FRAME':
          if (spectatingSlot === slotNum) {
            const renderView = document.getElementById('spectator-render-view');
            if (renderView) renderView.src = payload.data;
          }
          break;
      }
    });

    const cleanup = () => {
      activeConnections.delete(slotNum);
      playerRegistry.delete(slotNum);
      activeSpectators.delete(slotNum);
      if (spectatingSlot === slotNum) {
        exitSpectatorView();
      }
      handleStreamingService();
      updateUI();
    };

    conn.on('close', cleanup);
    conn.on('error', cleanup);
  }

  function sendStatePing(conn) {
    const state = {
      type: 'PING',
      username: window.TamState?.getSelfName() || localStorage['n'] || 'Player',
      region: window.TamState?.selectedRegion || 'Default',
      mode: window.TamState?.selectedMode || 'Default',
      isPlaying: !!(window.TamState?.isGameActive)
    };
    if (conn.open) {
      conn.send(state);
    }
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
      const frameData = canvas.toDataURL('image/jpeg', 0.5);
      const packet = { type: 'FRAME', data: frameData };

      activeSpectators.forEach((slotNum) => {
        const conn = activeConnections.get(slotNum);
        if (conn && conn.open) {
          conn.send(packet);
        }
      });
    } catch (e) {
      console.error('Frame processing failure: ', e);
    }
  }

  function evictDeadNodes() {
    const now = Date.now();
    let change = false;

    playerRegistry.forEach((data, slotNum) => {
      if (now - data.lastSeen > STALE_PEER_TIMEOUT_MS) {
        playerRegistry.delete(slotNum);
        activeConnections.delete(slotNum);
        activeSpectators.delete(slotNum);
        change = true;
      }
    });

    if (change) updateUI();
  }

  function updateUI() {
    const list = document.getElementById('p2p-list');
    if (!list) return;

    list.innerHTML = '';

    if (playerRegistry.size === 0) {
      list.innerHTML = '<div class="p2p-status-message">Scanning global network...</div>';
      return;
    }

    playerRegistry.forEach((data, slotNum) => {
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

      if (spectatingSlot === slotNum) {
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
          btn.onclick = () => startSpectating(slotNum);
        }
      }

      item.appendChild(meta);
      item.appendChild(btn);
      list.appendChild(item);
    });
  }

  function startSpectating(slotNum) {
    if (spectatingSlot) exitSpectatorView();

    const conn = activeConnections.get(slotNum);
    if (conn && conn.open) {
      spectatingSlot = slotNum;
      conn.send({ type: 'SUBSCRIBE_STREAM' });

      document.getElementById('spectator-overlay').style.display = 'flex';
      document.body.classList.add('spectating-active');
      updateUI();
    }
  }

  function exitSpectatorView() {
    if (spectatingSlot !== null) {
      const conn = activeConnections.get(spectatingSlot);
      if (conn && conn.open) {
        conn.send({ type: 'UNSUBSCRIBE_STREAM' });
      }
      spectatingSlot = null;
    }

    const overlay = document.getElementById('spectator-overlay');
    if (overlay) overlay.style.display = 'none';
    
    const view = document.getElementById('spectator-render-view');
    if (view) view.src = '';
    
    document.body.classList.remove('spectating-active');
    updateUI();
  }

  // Bind to dynamic TamState wrapper when instantiated
  const stateSync = setInterval(() => {
    if (window.TamState && typeof Peer !== 'undefined') {
      clearInterval(stateSync);
      window.TamState.p2pRegistry = playerRegistry;
      window.TamState.forceDisconnectSpectator = exitSpectatorView;
      initializeMod();
    }
  }, 100);
})();
