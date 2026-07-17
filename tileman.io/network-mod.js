/**
 * TileMan.io Cross-Server Spectator Mod
 * Handles P2P stream state against static index.html and style.css components
 */

(function () {
  const SLOT_PREFIX = 'tileman-slot-';
  const MAX_SLOTS = 20;               // Maximum slots increased to 20
  const SCAN_INTERVAL_MS = 1500;      // Accelerated scan interval to check dead channels
  const BROADCAST_FPS = 30;           // Optimized frame-rate targets 30 FPS
  const STALE_PEER_TIMEOUT_MS = 4500;  // Quicker stale peer timeouts to avoid ghost connections

  let mySlotId = null;
  let peer = null;
  const activeConnections = new Map(); 
  const connectingSlots = new Set();   // Tracks in-flight outbound connection attempts
  const playerRegistry = new Map();    
  const activeSpectators = new Set();  
  let spectatingSlot = null;           
  let broadcastTimer = null;           

  // Rescaling offscreen context canvas to avoid DataChannel UDP bottlenecks
  const scaleCanvas = document.createElement('canvas');
  const scaleCtx = scaleCanvas.getContext('2d');
  const TARGET_STREAM_WIDTH = 600; 

  function initializeMod() {
    const slotsToTry = Array.from({ length: MAX_SLOTS }, (_, i) => i + 1)
      .sort(() => Math.random() - 0.5);

    function setStatus(msg) {
      const el = document.querySelector('.p2p-status-message');
      if (el) el.textContent = msg;
    }

    function attemptNextSlot(list, retriesLeft = 3) {
      if (list.length === 0) {
        setStatus('All spectator slots are currently occupied.');
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
        tempPeer.destroy();

        if (err.type === 'unavailable-id') {
          attemptNextSlot(list, retriesLeft);
          return;
        }

        // Broker/network-level failure (e.g. the WebSocket handshake to the
        // signaling server itself failed) rather than a slot conflict.
        console.error(`P2P registry lookup error:`, err);
        if (retriesLeft > 0) {
          setStatus('Connection hiccup — retrying...');
          list.push(slot);
          setTimeout(() => attemptNextSlot(list, retriesLeft - 1), 2000);
        } else {
          setStatus('Unable to reach the P2P network. Check your connection and refresh.');
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

    // Handle signaling server disconnects cleanly
    peer.on('disconnected', () => {
      console.warn('Disconnected from signaling server. Attempting reconnect...');
      peer.reconnect();
    });

    setInterval(scanNetworkMesh, SCAN_INTERVAL_MS);
    setInterval(evictDeadNodes, 2500);

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
        if (conn.open) {
          sendStatePing(conn);
        } else {
          // Tear down broken connections immediately so the next pass can reconstruct
          activeConnections.delete(s);
        }
      } else if (mySlotId < s && !connectingSlots.has(s)) {
        connectToPeer(s);
      }
    }
  }

  function connectToPeer(targetSlot) {
    connectingSlots.add(targetSlot);
    const targetPeerId = `${SLOT_PREFIX}${targetSlot}`;
    const conn = peer.connect(targetPeerId, { 
      serialization: 'json',
      reliable: false // Setting reliable to false utilizes UDP pathways directly for faster streaming
    });
    setupConnectionHandlers(conn, targetSlot);
  }

  function setupConnectionHandlers(conn, slotNum) {
    conn.on('open', () => {
      connectingSlots.delete(slotNum);
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
      connectingSlots.delete(slotNum);
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
      let frameData;
      const ratio = TARGET_STREAM_WIDTH / canvas.width;

      if (ratio < 1) {
        // Resize canvas before sending to reduce bandwidth footprint and sustain 30 FPS
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
      if (now - data.lastSeen > STALE_PEER_TIMEOUT_MS) {
        const staleConn = activeConnections.get(slotNum);
        if (staleConn && staleConn.open) staleConn.close();
        connectingSlots.delete(slotNum);
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
    if (view) view.removeAttribute('src');
    
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
