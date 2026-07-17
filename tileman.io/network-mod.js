/**
 * TileMan.io Cross-Server Spectator Mod
 * Handles P2P stream state with rate-limiting, staggered connections, and slot backoffs
 */

(function () {
  const SLOT_PREFIX = 'tileman-slot-';
  const MAX_SLOTS = 20;               
  const SCAN_INTERVAL_MS = 2000;      // Relaxed scanning interval to reduce signaling overhead
  const BROADCAST_FPS = 30;           
  
  const STALE_ACTIVE_TIMEOUT_MS = 5000;    
  const STALE_BACKGROUND_TIMEOUT_MS = 120000; 

  let mySlotId = null;
  let peer = null;
  let isRebuilding = false;
  let isScanning = false;
  let isTabActive = true;

  const activeConnections = new Map(); // slotNumber -> DataConnection
  const playerRegistry = new Map();    // slotNumber -> { username, region, mode, isPlaying, status, lastSeen }
  const activeSpectators = new Set();  
  let spectatingSlot = null;           
  let broadcastTimer = null;           

  const scaleCanvas = document.createElement('canvas');
  const scaleCtx = scaleCanvas.getContext('2d');
  const TARGET_STREAM_WIDTH = 600; 

  function initializeMod() {
    isRebuilding = false;
    const slotsToTry = Array.from({ length: MAX_SLOTS }, (_, i) => i + 1)
      .sort(() => Math.random() - 0.5);

    function attemptNextSlot(list) {
      if (list.length === 0) {
        const msg = document.querySelector('.p2p-status-message');
        if (msg) msg.textContent = 'All spectator slots occupied. Retrying in 10s...';
        
        // Wait 10 seconds before starting a new search cycle to avoid rate-limiting
        setTimeout(initializeMod, 10000);
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
        setupMeshCallbacks();
      });

      tempPeer.on('error', (err) => {
        if (err.type === 'unavailable-id') {
          tempPeer.destroy();
          // 500ms delay before attempting the next slot to prevent spamming
          setTimeout(() => attemptNextSlot(list), 500);
        } else if (err.type === 'network' || err.type === 'socket-error') {
          tempPeer.destroy();
          // Server might be busy; back off for 1 second
          setTimeout(() => attemptNextSlot(list), 1000);
        } else {
          tempPeer.destroy();
          setTimeout(() => attemptNextSlot(list), 500);
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
        
        if (activeConnections.has(remoteSlot)) {
          const existing = activeConnections.get(remoteSlot);
          if (existing.open) {
            conn.close();
            return;
          }
        }
        setupConnectionHandlers(conn, remoteSlot);
      }
    });

    // Attempt signaling socket reconnect, leaving active WebRTC channels open
    peer.on('disconnected', () => {
      console.warn('Signaling server link lost. Reconnecting socket in 5s...');
      setTimeout(() => {
        if (peer && peer.disconnected && !peer.destroyed) {
          peer.reconnect();
        }
      }, 5000); // 5-second delay to avoid connection loops
    });

    peer.on('error', (err) => {
      // Normal behavior: ignore unsuccessful connections to empty slots
      if (err.type === 'peer-unavailable') {
        return;
      }
      
      if (err.type === 'unavailable-id') {
        return;
      }

      console.warn(`PeerJS non-fatal error: ${err.type}`);
    });

    setInterval(scanNetworkMesh, SCAN_INTERVAL_MS);
    setInterval(evictDeadNodes, 2500);

    const closeBtn = document.getElementById('spectator-close-btn');
    if (closeBtn) {
      closeBtn.onclick = exitSpectatorView;
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);

    updateUI();
  }

  function handleVisibilityChange() {
    isTabActive = (document.visibilityState === 'visible');
    
    if (isTabActive) {
      if (!peer || peer.destroyed) {
        rebuildEntirePeerInstance();
        return;
      }
      if (peer.disconnected) {
        peer.reconnect();
      }

      broadcastPresence();
      scanNetworkMesh();
    } else {
      broadcastPresence();
      handleStreamingService();
    }
    updateUI();
  }

  function broadcastPresence() {
    activeConnections.forEach((conn) => {
      if (conn.open) {
        sendStatePing(conn);
      }
    });
  }

  function rebuildEntirePeerInstance() {
    if (isRebuilding) return;
    isRebuilding = true;
    console.log('Teardown active. Rebuilding mesh instance...');
    
    activeConnections.forEach((conn) => {
      try { conn.close(); } catch (e) {}
    });
    
    activeConnections.clear();
    playerRegistry.clear();
    activeSpectators.clear();
    
    if (spectatingSlot !== null) {
      exitSpectatorView();
    }

    if (peer) {
      try { peer.destroy(); } catch (e) {}
      peer = null;
    }

    setTimeout(initializeMod, 2000); // 2-second delay on full rebuild to let sockets clean up
  }

  // Staggered connection scanner to avoid rate-limiting limits on free servers
  async function scanNetworkMesh() {
    if (!peer || peer.destroyed || peer.disconnected || isScanning) return;
    isScanning = true;

    for (let s = 1; s <= MAX_SLOTS; s++) {
      if (s === mySlotId) continue;

      const connectionActive = activeConnections.has(s);
      
      if (connectionActive) {
        const conn = activeConnections.get(s);
        if (conn && conn.open) {
          sendStatePing(conn);
        } else {
          activeConnections.delete(s);
        }
      } else {
        if (mySlotId < s) {
          connectToPeer(s);
          // Wait 300ms before attempting the next connection to avoid server socket throttling
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
      }
    }
    isScanning = false;
  }

  function connectToPeer(targetSlot) {
    const targetPeerId = `${SLOT_PREFIX}${targetSlot}`;
    const conn = peer.connect(targetPeerId, { 
      serialization: 'json',
      reliable: false 
    });
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
            status: payload.status || 'ACTIVE',
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
      isPlaying: !!(window.TamState?.isGameActive),
      status: isTabActive ? 'ACTIVE' : 'BACKGROUND'
    };
    if (conn.open) {
      conn.send(state);
    }
  }

  function handleStreamingService() {
    const activeMatch = window.TamState?.isGameActive;
    const shouldStream = activeSpectators.size > 0 && activeMatch && isTabActive;

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
    if (!canvas || !window.TamState?.isGameActive || !isTabActive) {
      handleStreamingService();
      return;
    }

    try {
      let frameData;
      const ratio = TARGET_STREAM_WIDTH / canvas.width;

      if (ratio < 1) {
        scaleCanvas.width = TARGET_STREAM_WIDTH;
        scaleCanvas.height = canvas.height * ratio;
        scaleCtx.drawImage(canvas, 0, 0, scaleCanvas.width, scaleCanvas.height);
        frameData = scaleCanvas.toDataURL('image/jpeg', 0.4);
      } else {
        frameData = canvas.toDataURL('image/jpeg', 0.4);
      }

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
      const allowedIdleTime = (data.status === 'BACKGROUND') 
        ? STALE_BACKGROUND_TIMEOUT_MS 
        : STALE_ACTIVE_TIMEOUT_MS;

      if (now - data.lastSeen > allowedIdleTime) {
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
      
      let statusTag = '';
      if (data.status === 'BACKGROUND') {
        statusTag = '<span style="color:#ffaa00;">Idle</span>';
      } else if (data.isPlaying) {
        statusTag = '<span style="color:#6fffa0;">Match</span>';
      } else {
        statusTag = '<span style="color:#888;">Lobby</span>';
      }

      meta.innerHTML = `
        <div class="p2p-name" title="${data.username}">${data.username}</div>
        <div class="p2p-info">${data.region} • ${data.mode} • ${statusTag}</div>
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
        if (!data.isPlaying || data.status === 'BACKGROUND') {
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

  const stateSync = setInterval(() => {
    if (window.TamState && typeof Peer !== 'undefined') {
      clearInterval(stateSync);
      window.TamState.p2pRegistry = playerRegistry;
      window.TamState.forceDisconnectSpectator = exitSpectatorView;
      initializeMod();
    }
  }, 100);
})();
