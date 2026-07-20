/**
 * TileMan.io Spectator Renderer
 *
 * Consumes the state contract broadcast by network-mod.js (keyframe + delta
 * messages built from window.TamState) and paints it onto a <canvas>.
 *
 * This still can't call hra.min.js's actual renderActiveGrid()/drawPlayer()
 * live — they're closures over private module variables, gated behind
 * isGameActive (which also arms input handling and socket movement
 * emission), and movePlayer() mutates player positions in place using
 * this client's own prediction physics, so pointing any of that at a
 * remote peer's snapshot risks corrupting this client's real match state.
 * That hasn't changed.
 *
 * What *has* changed: this file now ports the actual per-pixel algorithms
 * from those functions (camera transform, tile run-drawing, arena border
 * geometry, minimap-as-bitmap, player head/trail/shield rendering) as
 * static code, instead of a rough from-scratch approximation. It's driven
 * by the same viewer-local settings the broadcaster's own client uses
 * (snake border size, camera zoom, animations, minimap projection, grid
 * colors), synced via the read-only getters added to hra_min.js's
 * TamState instrumentation API.
 *
 * Remaining known simplifications (small, intentionally not chased):
 *   - Emotes are drawn as simple heart/skull glyphs, not the original's
 *     hand-built bezier vector shapes — those are cosmetic flourishes and
 *     porting the exact curve math wasn't worth the risk of subtly
 *     breaking it under time pressure. Fully portable later if wanted.
 *   - The debug-lines overlay (isDebugLinesEnabled) isn't ported; it's a
 *     developer tool, not something a spectator needs.
 */

const INTERP_DELAY_MS = 60; // render slightly "in the past" for smooth motion between ticks
                             // (was 100ms, sized for the old 12Hz/83ms tick gap; at 24Hz/~42ms
                             // gap this stays safely above one tick's worth of jitter margin
                             // while cutting perceived input lag)
const CAPTURE_FLASH_MS = 400;
const DEATH_FADE_MS = 1000;
const TILE_PX = 10;
const INVINCIBLE_GRACE_MS = 2000;   // matches hra_min.js's drawPlayer: shield stays fully opaque this long...
const INVINCIBLE_FADE_START_MS = INVINCIBLE_GRACE_MS;
const INVINCIBLE_FADE_END_MS = 4000; // ...then fades out by this point.
const TILE_DRAW_RADIUS_X = 22; // hra_min.js renderActiveGrid's rx/ry — NOT the same as the
const TILE_DRAW_RADIUS_Y = 13; // exposed cameraWidthDelta/cameraHeightDelta (23/14), which is
                                // used for background-fill sizing only, one tile larger.

export function createSession() {
  return {
    ready: false,
    gridSize: 0,
    tiles: null,            // flat array, tiles[x * gridSize + y] = raw color string
    tileFlash: null,        // flat array, tileFlash[x * gridSize + y] = timestamp of last capture or null
    colorPalette: [],
    activeColorPalette: {}, // raw hex -> brightness-adjusted hex, from the broadcaster's own settings
    emptyCellColor: '#666666',
    backgroundColor: '#333333',
    arenaSetting: 0,
    bounds: { lobby: [], safe: [], trail: [] },
    players: new Map(),     // id -> { prev, curr, prevT, currT }
    camera: { pos: [0, 0], widthDelta: 23, heightDelta: 14 }, // matches TamState's cameraWidthDelta/
                                                                 // cameraHeightDelta — used for background-
                                                                 // fill sizing, NOT the tile-draw radius
                                                                 // (see TILE_DRAW_RADIUS_X/Y below)
    lastDeltaAt: 0,
    sequence: -1,
    matchState: 'LOBBY',

    selfId: null,           // id of the player being spectated, within `players`
    minimapWidth: 0,
    collisionBuffer: null,  // flat array of 0/1, collisionBuffer[mx * minimapWidth + my]
    minimapCanvas: null,    // offscreen <canvas>, redrawn from collisionBuffer each frame, then
                             // blitted with drawImage — mirrors hra_min.js's own offscreenCanvas
                             // approach instead of drawing thousands of individual rects.
    projectionSeen: null,   // flat Uint8Array, mirrors hra_min.js's per-viewer "have I had this
                             // minimap cell in my live viewport at some point" cache. Purely
                             // local — same algorithm as the source, so no need to sync it.

    viewerSettings: {
      snakeSizeRatio: 3,
      isCameraZoomEnabled: true,
      cameraZoomFactor: 1,
      areAnimationsEnabled: true,
      isMinimapProjectionEnabled: false,
      emptyCellColor: '#666666',
      cellBgColor: '#3a3a3a',
      projectionShadowColor: '#666666',
      customSkinsEnabled: true,
    },
    renderSettings: null,
    display: null,
    pathfinding: { selfPath: [], enemyPaths: [] },
    hostCanvas: { width: 0, height: 0 },

    hud: {
      finalScore: 0, totalKills: 0, pointScaleFactor: 100,
      killsComboCounter: 0, capturedComboCounter: 0,
      respawnCooldownMs: null, rank: null,
    },
    respawnReceivedAt: null, // local performance.now() when respawnCooldownMs was last (re)set, for client-side countdown

    chatFeed: [],           // [{ text, receivedAt }], newest last
    watchStartedAt: null,   // local performance.now() of first delta where selfId is alive

    leaderboard: [],        // [{ rank, name, score, isSelf }], top-N as shown on the broadcaster's own screen
  };
}

export function destroySession(session) {
  session.players.clear();
  session.tiles = null;
  session.collisionBuffer = null;
  session.chatFeed = [];
  session.minimapCanvas = null;
  session.projectionSeen = null;
  session.ready = false;
}

// ─── Grid RLE (shared shape with the broadcaster side) ─────────────────────
// Flat [color, runLength, color, runLength, ...] scanned column-major
// (x outer, y inner) to match gridMatrix[x][y] access order.
export function decodeGridRLE(runs, gridSize) {
  const tiles = new Array(gridSize * gridSize);
  let x = 0, y = 0;
  for (let i = 0; i < runs.length; i += 2) {
    const color = runs[i];
    const len = runs[i + 1];
    for (let k = 0; k < len; k++) {
      tiles[x * gridSize + y] = color;
      y++;
      if (y === gridSize) { y = 0; x++; }
    }
  }
  return tiles;
}

function timestampFromAge(ageMs, now) {
  return ageMs === null || ageMs === undefined ? null : now - Math.max(0, ageMs);
}

function snapshotPlayer(p, now) {
  const pos = p.pos || [p.x || 0, p.y || 0];
  const emote = p.emote
    ? { type: p.emote.type, t: timestampFromAge(p.emote.ageMs, now) }
    : null;
  return {
    x: pos[0],
    y: pos[1],
    d: p.d,
    color: p.color,
    name: p.name || '',
    trail: p.trail || [],
    isLocal: !!p.isLocal,
    alive: p.alive !== false,
    deathT: timestampFromAge(p.deathAgeMs, now),
    invincible: !!p.invincible,
    invincibleT: timestampFromAge(p.invincibleAgeMs, now),
    emote,
    serverPosition: p.serverPosition || null,
    serverDirection: p.serverDirection,
  };
}

function applyPlayers(session, players, now) {
  if (!players) return;
  const seen = new Set();
  for (const p of players) {
    if (!p || p.id === undefined || p.id === null) continue;
    seen.add(p.id);
    const current = snapshotPlayer(p, now);
    const existing = session.players.get(p.id);
    if (existing) {
      existing.prev = existing.curr;
      existing.prevT = existing.currT;
      existing.curr = current;
      existing.currT = now;
    } else {
      session.players.set(p.id, { prev: current, curr: current, prevT: now, currT: now });
    }
  }
  for (const id of session.players.keys()) {
    if (!seen.has(id)) session.players.delete(id);
  }
}

function applyTileAnimations(session, animations, now) {
  if (!session.tileFlash || !animations) return;
  for (const item of animations) {
    const x = item[0];
    const y = item[1];
    const ageMs = item[2];
    if (x < 0 || y < 0 || x >= session.gridSize || y >= session.gridSize) continue;
    session.tileFlash[x * session.gridSize + y] = timestampFromAge(ageMs, now);
  }
}

function applyFullState(session, payload, now) {
  if (payload.sequence !== undefined && payload.sequence < session.sequence) return false;
  if (payload.sequence !== undefined) session.sequence = payload.sequence;
  session.matchState = payload.matchState || session.matchState;
  if (payload.selfId !== undefined) session.selfId = payload.selfId;
  if (payload.hud) {
    const previousCooldown = session.hud.respawnCooldownMs;
    session.hud = payload.hud;
    if (payload.hud.respawnCooldownMs !== previousCooldown) {
      session.respawnReceivedAt = payload.hud.respawnCooldownMs === null ? null : now;
    }
  }
  if (payload.leaderboard) session.leaderboard = payload.leaderboard;
  if (payload.viewerSettings) session.viewerSettings = payload.viewerSettings;
  if (payload.renderSettings) session.renderSettings = payload.renderSettings;
  if (payload.display) session.display = payload.display;
  if (payload.pathfinding) session.pathfinding = payload.pathfinding;
  if (payload.cameraPos) session.camera.pos = payload.cameraPos.slice();
  if (payload.cameraWidthDelta !== undefined) session.camera.widthDelta = payload.cameraWidthDelta;
  if (payload.cameraHeightDelta !== undefined) session.camera.heightDelta = payload.cameraHeightDelta;
  const geometry = session.renderSettings && session.renderSettings.geometry;
  if (geometry) {
    session.hostCanvas.width = geometry.canvasWidth || 0;
    session.hostCanvas.height = geometry.canvasHeight || 0;
  }
  return true;
}

const HUD_ELEMENT_IDS = [
  'leftbottom', 'leaderboard', 'timer', 'performance_stats', 'title', 'after',
];

function ensureHostStage(canvas, session) {
  if (typeof document === 'undefined') return null;
  const overlay = document.getElementById('spectator-overlay');
  if (!overlay) return null;
  let stage = document.getElementById('spectator-host-stage');
  if (!stage) {
    stage = document.createElement('div');
    stage.id = 'spectator-host-stage';
    overlay.insertBefore(stage, overlay.firstChild);
  }
  if (canvas.parentElement !== stage) stage.appendChild(canvas);
  const geometry = session.renderSettings?.geometry;
  const hostWidth = geometry?.viewportWidth || geometry?.canvasWidth || window.innerWidth;
  const hostHeight = geometry?.viewportHeight || geometry?.canvasHeight || window.innerHeight;
  const scale = Math.min(window.innerWidth / hostWidth, window.innerHeight / hostHeight);
  stage.style.width = `${hostWidth}px`;
  stage.style.height = `${hostHeight}px`;
  stage.style.transform = `translate(-50%, -50%) scale(${scale})`;
  return stage;
}

function ensureDisplayLayer() {
  if (typeof document === 'undefined') return null;
  const stage = document.getElementById('spectator-host-stage');
  if (!stage) return null;
  let layer = document.getElementById('spectator-host-hud');
  if (layer) return layer;
  layer = document.createElement('div');
  layer.id = 'spectator-host-hud';
  layer.setAttribute('aria-hidden', 'true');
  for (const id of HUD_ELEMENT_IDS) {
    const source = document.getElementById(id);
    if (!source) continue;
    const clone = source.cloneNode(true);
    clone.dataset.hostId = id;
    layer.appendChild(clone);
  }
  stage.appendChild(layer);
  return layer;
}

function syncElementSnapshot(layer, id, snapshot) {
  if (!snapshot) return;
  const element = layer.querySelector(`[data-host-id="${id}"]`) || layer.querySelector(`#${id}`);
  if (!element) return;
  element.innerHTML = snapshot.html || '';
  element.className = snapshot.className || '';
  if (snapshot.style) element.setAttribute('style', snapshot.style);
  if (snapshot.display === 'none') element.style.display = 'none';
}

function syncHostHud(session) {
  const display = session.display;
  if (!display) return;
  const layer = ensureDisplayLayer();
  if (!layer) return;
  layer.className = `spectator-host-hud ${display.htmlClassName || ''}`;
  layer.style.fontSize = display.game?.fontSize || '';
  const hud = display.hud || {};
  const groups = {
    leftbottom: ['playerName', 'score', 'captured', 'kills', 'rank', 'capturedCombo', 'capturedPlus', 'killsCombo'],
    performance_stats: ['fps', 'latency', 'latencyToServer', 'regionName'],
  };
  for (const key of groups.leftbottom) {
    const element = layer.querySelector(`[data-host-id="leftbottom"] #${({ playerName: 'player_name', score: 'score', captured: 'captured', kills: 'kills', rank: 'rank', capturedCombo: 'captcombo', capturedPlus: 'captplus', killsCombo: 'killscombo' })[key]}`);
    if (element && hud[key]) {
      element.innerHTML = hud[key].html || '';
      element.className = hud[key].className || '';
      if (hud[key].style) element.setAttribute('style', hud[key].style);
    }
  }
  for (const key of groups.performance_stats) {
    const element = layer.querySelector(`[data-host-id="performance_stats"] #${({ fps: 'fps', latency: 'latency', latencyToServer: 'latencytoserver', regionName: 'regname' })[key]}`);
    if (element && hud[key]) {
      element.innerHTML = hud[key].html || '';
      element.className = hud[key].className || '';
      if (hud[key].style) element.setAttribute('style', hud[key].style);
    }
  }
  const allHudIds = {
    playerName: 'player_name', score: 'score', captured: 'captured', kills: 'kills', rank: 'rank',
    capturedCombo: 'captcombo', capturedPlus: 'captplus', killsCombo: 'killscombo',
    timeAlive: 'time_alive', killMetricLabel: 'kill_metric_label', killMetricValue: 'kill_metric_val',
    fps: 'fps', latency: 'latency', latencyToServer: 'latencytoserver', regionName: 'regname',
    spectatorInfo: 'spectator-info', spectatorCount: 'spectator-count',
  };
  for (const [key, id] of Object.entries(allHudIds)) {
    const element = layer.querySelector(`#${id}`);
    if (!element || !hud[key]) continue;
    element.innerHTML = hud[key].html || '';
    element.className = hud[key].className || '';
    if (hud[key].style) element.setAttribute('style', hud[key].style);
  }
  syncElementSnapshot(layer, 'timer', display.timer);
  syncElementSnapshot(layer, 'title', display.title);
  const leaders = layer.querySelector('[data-host-id="leaderboard"] #leaders');
  if (leaders) leaders.innerHTML = display.leaderboardHtml || '';
  const card = display.scoreCard;
  const after = layer.querySelector('[data-host-id="after"]');
  if (after && card) {
    after.style.display = card.active ? 'block' : 'none';
    const scoreValues = {
      info2: card.info,
      bl: card.last?.tiles, kl: card.last?.kills, til: card.last?.alive, trl: card.last?.trail,
      bh: card.high?.tiles, kh: card.high?.kills, tih: card.high?.alive, trh: card.high?.trail,
    };
    for (const [id, snapshot] of Object.entries(scoreValues)) {
      const element = after.querySelector(`#${id}`);
      if (!element || !snapshot) continue;
      element.innerHTML = snapshot.html || '';
      element.className = snapshot.className || '';
      if (snapshot.style) element.setAttribute('style', snapshot.style);
    }
  }
}

export function applyKeyframe(session, kf) {
  const now = performance.now();
  session.gridSize = kf.gridSize;
  session.tiles = decodeGridRLE(kf.tiles, kf.gridSize);
  session.tileFlash = new Array(kf.gridSize * kf.gridSize).fill(null);
  session.colorPalette = kf.colorPalette;
  session.activeColorPalette = kf.activeColorPalette || {};
  session.emptyCellColor = kf.emptyCellColor;
  session.backgroundColor = kf.backgroundColor;
  session.arenaSetting = kf.arenaSetting;
  session.bounds = kf.bounds;
  session.minimapWidth = kf.minimapWidth || 0;
  session.collisionBuffer = kf.collisionBuffer ? kf.collisionBuffer.slice() : null;
  session.leaderboard = kf.leaderboard || [];
  applyFullState(session, kf, now);
  applyTileAnimations(session, kf.tileAnimations, now);
  applyPlayers(session, kf.players || [], now);

  if (session.minimapWidth > 0) {
    session.projectionSeen = new Uint8Array(session.minimapWidth * session.minimapWidth);
    if (typeof document !== 'undefined') {
      const c = document.createElement('canvas');
      c.width = session.minimapWidth;
      c.height = session.minimapWidth;
      session.minimapCanvas = c;
    }
  } else {
    session.projectionSeen = null;
    session.minimapCanvas = null;
  }

  session.ready = true;
  session.lastDeltaAt = now;
}

export function applyDelta(session, delta) {
  if (!session.ready) return;
  const now = performance.now();
  if (!applyFullState(session, delta, now)) return;
  applyPlayers(session, delta.players || [], now);

  if (session.tiles) {
    for (const [x, y, color, ageMs] of delta.tileDiffs || []) {
      const idx = x * session.gridSize + y;
      session.tiles[idx] = color;
      session.tileFlash[idx] = timestampFromAge(ageMs, now) || now;
    }
  }
  applyTileAnimations(session, delta.tileAnimations, now);

  if (session.collisionBuffer && delta.collisionDiffs) {
    for (const [mx, my, val] of delta.collisionDiffs) {
      session.collisionBuffer[mx * session.minimapWidth + my] = val;
    }
  }

  if (delta.newChatMessages && delta.newChatMessages.length > 0) {
    for (const text of delta.newChatMessages) {
      session.chatFeed.push({ text, receivedAt: now });
    }
    // Keep only the most recent handful; render fades old ones out anyway.
    if (session.chatFeed.length > 8) {
      session.chatFeed.splice(0, session.chatFeed.length - 8);
    }
  }

  const selfRec = session.players.get(delta.selfId);
  if (session.watchStartedAt === null && selfRec && selfRec.curr.alive) {
    session.watchStartedAt = now;
  }
  if (selfRec && !selfRec.curr.alive) {
    session.watchStartedAt = null; // reset so "time watching" restarts on respawn
  }

  session.lastDeltaAt = now;
}

// ─── Rendering ──────────────────────────────────────────────────────────────

function resolveColor(session, raw) {
  const colors = session.renderSettings && session.renderSettings.colors;
  if (raw === undefined || raw === null) return colors?.emptyCellColor || session.emptyCellColor;
  if (colors?.DEFAULT_EMPTY_CELL_COLOR && raw === colors.DEFAULT_EMPTY_CELL_COLOR) {
    return colors.emptyCellColor || session.emptyCellColor;
  }
  return (colors?.activeColorPalette && colors.activeColorPalette[raw]) ||
    session.activeColorPalette[raw] || raw;
}

function lerp(a, b, t) { return a + (b - a) * t; }

function getInterpolatedPos(rec, renderTime) {
  const span = rec.currT - rec.prevT;
  if (span <= 0) return { x: rec.curr.x, y: rec.curr.y };
  const t = Math.max(0, Math.min(1, (renderTime - rec.prevT) / span));
  return { x: lerp(rec.prev.x, rec.curr.x, t), y: lerp(rec.prev.y, rec.curr.y, t) };
}

export function renderFrame(canvas, session) {
  const ctx = canvas.getContext('2d');
  if (!session.ready) {
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return;
  }

  const geometry = session.renderSettings && session.renderSettings.geometry;
  if (geometry && geometry.canvasWidth && geometry.canvasHeight &&
      (canvas.width !== geometry.canvasWidth || canvas.height !== geometry.canvasHeight)) {
    canvas.width = geometry.canvasWidth;
    canvas.height = geometry.canvasHeight;
  }
  ensureHostStage(canvas, session);
  syncHostHud(session);

  const renderTime = performance.now() - INTERP_DELAY_MS;
  const { pos: cameraPos, widthDelta, heightDelta } = session.camera;
  const gridSize = session.gridSize;
  const hostToggles = session.renderSettings && session.renderSettings.toggles;
  const hostGeometry = session.renderSettings && session.renderSettings.geometry;
  const localPlayerTarget = hostGeometry?.localPlayerTarget || cameraPos;
  const cameraOffsetXY = hostGeometry?.cameraOffsetXY || [0, 0];
  const isLayoutHorizontal = hostGeometry?.isLayoutHorizontal !== false;
  const hostZoom = hostToggles?.isCameraZoomEnabled
    ? (hostGeometry?.cameraZoomFactor || 1)
    : 1;
  const tileRadiusX = Math.round(TILE_DRAW_RADIUS_X / hostZoom);
  const tileRadiusY = Math.round(TILE_DRAW_RADIUS_Y / hostZoom);

  const idealWidth = isLayoutHorizontal
    ? 1100 * Math.min(1, (canvas.width * 0.5625) / canvas.height)
    : 1100 * Math.min(1, (canvas.height * 0.5625) / canvas.width);
  const scaleA = Math.max(canvas.width, canvas.height) / 430;
  const scaleB = Math.sqrt((canvas.width * canvas.height) / idealWidth) / 10;
  const scaleX = Math.max(scaleB, scaleA) * hostZoom;
  const scaleY = scaleX;

  function worldToScreen(wx, wy) {
    if (!isLayoutHorizontal) {
      return {
        x: canvas.width / 2 - scaleX * (wy * TILE_PX - localPlayerTarget[1] * TILE_PX - 5 - cameraOffsetXY[1]),
        y: canvas.height / 2 + scaleY * (wx * TILE_PX - localPlayerTarget[0] * TILE_PX - 5 - cameraOffsetXY[0]),
      };
    }
    return {
      x: canvas.width / 2 + scaleX * (wx * TILE_PX - localPlayerTarget[0] * TILE_PX - 5 - cameraOffsetXY[0]),
      y: canvas.height / 2 + scaleY * (wy * TILE_PX - localPlayerTarget[1] * TILE_PX - 5 - cameraOffsetXY[1]),
    };
  }

  const colors = session.renderSettings && session.renderSettings.colors;
  const toggles = session.renderSettings && session.renderSettings.toggles;
  const snakeSize = geometry?.snakeSizeRatio ?? session.viewerSettings.snakeSizeRatio ?? 1;
  const cellBgColor = colors?.cellBgColor || session.viewerSettings.cellBgColor || session.backgroundColor;
  const emptyCellColor = colors?.emptyCellColor || session.viewerSettings.emptyCellColor || session.emptyCellColor;
  ctx.fillStyle = snakeSize === 0 ? emptyCellColor : cellBgColor;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // ── Tiles ──
  const minX = Math.max(Math.floor(cameraPos[0] - tileRadiusX), 0);
  const maxX = Math.min(Math.ceil(cameraPos[0] + tileRadiusX), gridSize - 1);
  const minY = Math.max(Math.floor(cameraPos[1] - tileRadiusY), 0);
  const maxY = Math.min(Math.ceil(cameraPos[1] + tileRadiusY), gridSize - 1);

  for (let gx = minX; gx <= maxX; gx++) {
    for (let gy = minY; gy <= maxY; gy++) {
      const idx = gx * gridSize + gy;
      const raw = session.tiles[idx];
      let fill = raw === undefined ? emptyCellColor : resolveColor(session, raw);
      if (raw === colors?.DEFAULT_EMPTY_CELL_COLOR) {
        const mx = Math.floor(gx / 5);
        const my = Math.floor(gy / 5);
        const projectionIndex = mx * session.minimapWidth + my;
        const isInsideLiveViewport = Math.abs(gx - cameraPos[0]) <= TILE_DRAW_RADIUS_X &&
          Math.abs(gy - cameraPos[1]) <= TILE_DRAW_RADIUS_Y;
        if (isInsideLiveViewport && session.projectionSeen) session.projectionSeen[projectionIndex] = 1;
        const hasOverride = !!session.projectionSeen?.[projectionIndex];
        if (toggles?.isMinimapProjectionEnabled && !isInsideLiveViewport && !hasOverride &&
            session.collisionBuffer?.[projectionIndex]) {
          fill = colors?.projectionShadowColor || emptyCellColor;
        } else {
          fill = emptyCellColor;
        }
      }
      const { x: sx, y: sy } = worldToScreen(gx, gy);
      const w = TILE_PX * scaleX;
      const h = TILE_PX * scaleY;
      let stroke = snakeSize;
      const changedAt = session.tileFlash[idx];
      if (toggles?.areAnimationsEnabled !== false && changedAt !== null) {
        const elapsed = performance.now() - changedAt;
        if (elapsed > 400) {
          session.tileFlash[idx] = null;
        } else {
          stroke = 5 - (elapsed * (10 - 2 * snakeSize)) / 800;
        }
      }

      ctx.fillStyle = fill;
      if (snakeSize === 0 && stroke <= 0) {
        ctx.fillRect(sx, sy, w, h);
      } else {
        const px = stroke * scaleX;
        const py = stroke * scaleY;
        ctx.fillRect(sx + px, sy + py, Math.max(0, w - px * 2), Math.max(0, h - py * 2));
      }
    }
  }

  // ── Arena border (mode 1: walled arena) ──
  if (session.arenaSetting === 1) {
    const topLeft = worldToScreen(0, 0);
    const bottomRight = worldToScreen(gridSize, gridSize);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 3;
    ctx.strokeRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
  }

  // ── Bounds overlays ──
  drawBoundsList(ctx, session.bounds.lobby, worldToScreen, '#bbf');
  drawBoundsList(ctx, session.bounds.safe, worldToScreen, '#ff0');
  drawBoundsList(ctx, session.bounds.trail, worldToScreen, '#000');
  drawDebugGrid(ctx, session, worldToScreen, minX, minY, maxX, maxY);
  drawPathfinding(ctx, session, worldToScreen);

  // ── Players ──
  for (const [id, rec] of session.players.entries()) {
    drawPlayer(ctx, rec, session, renderTime, worldToScreen, scaleX, id === session.selfId);
  }

  // ── Overlays (minimap, HUD, kill feed, respawn countdown, leaderboard) ──
  drawMinimap(ctx, canvas, session);
  if (!session.display) drawHud(ctx, session);
  if (!session.display) drawChatFeed(ctx, canvas, session);
  drawRespawnCountdown(ctx, canvas, session);
  if (!session.display) drawLeaderboard(ctx, canvas, session);
}

function drawMinimap(ctx, canvas, session) {
  if (!session.collisionBuffer || !session.minimapWidth) return;

  const mw = session.minimapWidth;
  const geometry = session.renderSettings && session.renderSettings.geometry;
  const backingStoreRatio = geometry?.backingStoreRatio || 1;
  const resolutionMultiplier = geometry?.resolutionMultiplier || 1;
  const mmScale = Math.max(Math.round(backingStoreRatio * resolutionMultiplier), 1);
  const rawMmScale = Math.max(
    Math.min(
      backingStoreRatio * resolutionMultiplier * 200,
      canvas.width / 2.5,
      canvas.height / 2,
      (canvas.width + canvas.height) / 7
    ) / mw,
    1
  );
  const size = mw * Math.round(rawMmScale);
  const cell = size / mw;
  const margin = Math.round(5 * mmScale);
  const ox = margin;
  const oy = margin;

  ctx.save();
  ctx.globalAlpha = 0.6;
  ctx.imageSmoothingEnabled = false;

  const selfRec = session.players.get(session.selfId);
  const ownColor = selfRec ? resolveColor(session, selfRec.curr.color) : '#fff';
  ctx.fillStyle = '#fff';
  ctx.fillRect(ox, oy, size, size);
  ctx.fillStyle = '#000';
  for (let mx = 0; mx < mw; mx++) {
    for (let my = 0; my < mw; my++) {
      if (session.collisionBuffer[mx * mw + my]) {
        ctx.fillRect(ox + mx * cell, oy + my * cell, cell, cell);
      }
    }
  }

  ctx.strokeStyle = ownColor;
  ctx.lineWidth = mmScale;
  ctx.strokeRect(ox, oy, size, size);

  if (selfRec) {
    const markerSize = Math.max(4 * backingStoreRatio * resolutionMultiplier, 2);
    const mx = markerSize + (selfRec.curr.x / (session.gridSize - 1)) * (size - 2 * markerSize);
    const my = markerSize + (selfRec.curr.y / (session.gridSize - 1)) * (size - 2 * markerSize);
    ctx.beginPath();
    ctx.arc(ox + mx, oy + my, markerSize, 0, 2 * Math.PI);
    ctx.fillStyle = 'rgba(250,250,250,0.7)';
    ctx.fill();
    ctx.stroke();
  }
  ctx.imageSmoothingEnabled = true;
  ctx.restore();
}

function drawHud(ctx, session) {
  const h = session.hud;
  const selfRec = session.players.get(session.selfId);
  const name = selfRec ? selfRec.curr.name : '???';
  const score = (h.finalScore || 0) + (h.totalKills || 0) * (h.pointScaleFactor || 0);

  const lines = [
    `Watching: ${name}`,
    `Score: ${score}`,
    `Tiles: ${h.finalScore || 0}` + (h.capturedComboCounter ? `  (${h.capturedComboCounter > 0 ? '+' : ''}${h.capturedComboCounter})` : ''),
    `Kills: ${h.totalKills || 0}` + (h.killsComboCounter ? `  (+${h.killsComboCounter})` : ''),
  ];
  if (h.rank) lines.push(`Rank: ${h.rank}`);
  if (session.watchStartedAt !== null) {
    const secs = Math.floor((performance.now() - session.watchStartedAt) / 1000);
    lines.push(`Watching for: ${formatSeconds(secs)}`);
  }

  ctx.save();
  ctx.font = '13px "JetBrains Mono", monospace';
  const padding = 8;
  const lineHeight = 16;
  const boxWidth = 180;
  const boxHeight = lines.length * lineHeight + padding * 2;

  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(10, 10, boxWidth, boxHeight);
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'left';
  lines.forEach((line, i) => {
    ctx.fillText(line, 10 + padding, 10 + padding + lineHeight * (i + 1) - 4);
  });
  ctx.restore();
}

function formatSeconds(total) {
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function drawLeaderboard(ctx, canvas, session) {
  const entries = session.leaderboard;
  if (!entries || entries.length === 0) return;

  ctx.save();
  ctx.font = '13px "JetBrains Mono", monospace';
  const padding = 8;
  const lineHeight = 18;
  const boxWidth = 170;
  const boxHeight = (entries.length + 1) * lineHeight + padding * 2;
  const ox = canvas.width - boxWidth - 10;
  // Sits below the minimap box (minimap is top-right; leave room for it).
  const oy = 10 + Math.min(120, canvas.width * 0.18) + 20;

  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(ox, oy, boxWidth, boxHeight);

  ctx.textAlign = 'left';
  ctx.fillStyle = '#fff';
  ctx.fillText('LEADERBOARD', ox + padding, oy + padding + lineHeight - 4);

  entries.forEach((entry, i) => {
    const y = oy + padding + lineHeight * (i + 2) - 4;
    ctx.fillStyle = entry.isSelf ? '#ff5555' : '#fff';
    ctx.fillText(`${entry.rank}. ${entry.name}`, ox + padding, y);
    ctx.textAlign = 'right';
    ctx.fillText(String(entry.score), ox + boxWidth - padding, y);
    ctx.textAlign = 'left';
  });
  ctx.restore();
}

function drawChatFeed(ctx, canvas, session) {
  const CHAT_LIFETIME_MS = 6000;
  const now = performance.now();
  session.chatFeed = session.chatFeed.filter((m) => now - m.receivedAt < CHAT_LIFETIME_MS);
  if (session.chatFeed.length === 0) return;

  ctx.save();
  ctx.font = '13px Rajdhani, sans-serif';
  ctx.textAlign = 'center';
  const baseY = 40;
  session.chatFeed.slice(-4).forEach((m, i) => {
    const age = now - m.receivedAt;
    const alpha = age > CHAT_LIFETIME_MS - 1000 ? (CHAT_LIFETIME_MS - age) / 1000 : 1;
    ctx.fillStyle = `rgba(255,255,255,${Math.max(0, alpha)})`;
    ctx.fillText(m.text, canvas.width / 2, baseY + i * 18);
  });
  ctx.restore();
}

function drawRespawnCountdown(ctx, canvas, session) {
  const h = session.hud;
  if (h.respawnCooldownMs === null || h.respawnCooldownMs === undefined || session.respawnReceivedAt === null) return;
  const remaining = Math.max(0, h.respawnCooldownMs - (performance.now() - session.respawnReceivedAt));
  if (remaining <= 0) return;

  ctx.save();
  ctx.font = 'bold 28px Rajdhani, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.fillText(Math.ceil(remaining / 1000).toString(), canvas.width / 2, canvas.height / 2);
  ctx.restore();
}

function drawBoundsList(ctx, list, worldToScreen, color) {
  if (!list || list.length === 0) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  for (const b of list) {
    const tl = worldToScreen(b.minX, b.minY);
    const br = worldToScreen(b.maxX, b.maxY);
    ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
  }
}

function drawPathfinding(ctx, session, worldToScreen) {
  if (!session.renderSettings?.toggles?.isPathfindingEnabled) return;
  const paths = [];
  if (session.pathfinding?.selfPath?.length) paths.push({ path: session.pathfinding.selfPath, color: '#fff' });
  for (const item of session.pathfinding?.enemyPaths || []) {
    if (item.path?.length) paths.push({ path: item.path, color: item.color || '#ff5555' });
  }
  ctx.save();
  ctx.globalAlpha = .55;
  ctx.lineWidth = 2;
  for (const item of paths) {
    ctx.beginPath();
    item.path.forEach((point, index) => {
      const screen = worldToScreen(point[0], point[1]);
      if (index === 0) ctx.moveTo(screen.x, screen.y);
      else ctx.lineTo(screen.x, screen.y);
    });
    ctx.strokeStyle = item.color;
    ctx.stroke();
  }
  ctx.restore();
}

function drawDebugGrid(ctx, session, worldToScreen, minX, minY, maxX, maxY) {
  if (!session.renderSettings?.toggles?.isDebugLinesEnabled) return;
  const colors = session.renderSettings.colors || {};
  const x0 = minX * 10;
  const y0 = minY * 10;
  const x1 = (maxX + 1) * 10;
  const y1 = (maxY + 1) * 10;
  const startX = Math.floor(x0 / 50) * 50;
  const startY = Math.floor(y0 / 50) * 50;
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = colors.debugGridLineColor || '#ffd700';
  for (let x = startX; x <= x1 + 50; x += 50) {
    if (x < x0 || x > x1) continue;
    const top = worldToScreen(x / 10, y0 / 10);
    const bottom = worldToScreen(x / 10, y1 / 10);
    ctx.beginPath();
    ctx.moveTo(top.x, top.y);
    ctx.lineTo(bottom.x, bottom.y);
    ctx.stroke();
  }
  for (let y = startY; y <= y1 + 50; y += 50) {
    if (y < y0 || y > y1) continue;
    const left = worldToScreen(x0 / 10, y / 10);
    const right = worldToScreen(x1 / 10, y / 10);
    ctx.beginPath();
    ctx.moveTo(left.x, left.y);
    ctx.lineTo(right.x, right.y);
    ctx.stroke();
  }
  for (const [offset, size, color] of [[10, 30, colors.debugBox3x3Color], [20, 10, colors.debugBox1x1Color]]) {
    ctx.strokeStyle = color || '#00ff00';
    for (let x = startX; x <= x1; x += 50) {
      for (let y = startY; y <= y1; y += 50) {
        const topLeft = worldToScreen((x + offset) / 10, (y + offset) / 10);
        const bottomRight = worldToScreen((x + offset + size) / 10, (y + offset + size) / 10);
        ctx.strokeRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
      }
    }
  }
  ctx.restore();
}

function getNameCanvas(rec, color) {
  const p = rec.curr;
  if (rec.nameCanvas && rec.nameCanvasName === p.name && rec.nameCanvasColor === color) return rec.nameCanvas;
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  const nameCtx = canvas.getContext('2d');
  const entities = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#039;': "'" };
  const name = p.name.replace(/&amp;|&lt;|&gt;|&quot;|&#039;/g, (value) => entities[value]);
  nameCtx.font = '48px arial';
  const width = Math.min(800, nameCtx.measureText(name).width);
  canvas.width = width + 16;
  canvas.height = 64;
  nameCtx.font = '48px arial';
  nameCtx.textBaseline = 'top';
  nameCtx.shadowColor = 'rgba(0,0,0,1.0)';
  nameCtx.shadowBlur = 10;
  nameCtx.shadowOffsetX = nameCtx.shadowOffsetY = 4;
  nameCtx.fillStyle = color;
  nameCtx.fillText(name, 8, 8);
  nameCtx.shadowColor = 'black';
  nameCtx.shadowBlur = 0;
  nameCtx.shadowOffsetX = nameCtx.shadowOffsetY = 1.6;
  nameCtx.fillStyle = 'rgba(255,255,255,.3)';
  nameCtx.fillText(name, 8, 8);
  rec.nameCanvas = canvas;
  rec.nameCanvasName = p.name;
  rec.nameCanvasColor = color;
  return canvas;
}

function drawPlayer(ctx, rec, session, renderTime, worldToScreen, scaleX, isSelf) {
  const p = rec.curr;
  let alpha = 1;

  if (!p.alive && p.deathT !== null) {
    const dead = performance.now() - p.deathT;
    if (dead > DEATH_FADE_MS) {
      session.players.delete(findKeyFor(session, rec));
      return;
    }
    alpha = 1 - dead / DEATH_FADE_MS;
  }
  if (p.invincible) alpha *= 0.5;

  ctx.save();
  ctx.globalAlpha = alpha;

  const color = resolveColor(session, p.color);
  const { x: wx, y: wy } = getInterpolatedPos(rec, renderTime);

  // Trail
  if (p.trail && p.trail.length > 0) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 5 * scaleX;
    ctx.strokeStyle = color;
    ctx.beginPath();
    const points = p.trail.slice();
    const tail = points[points.length - 1];
    if (tail && p.x !== tail[0] && p.y !== tail[1]) {
      points.push(p.d === 1 || p.d === 3 ? [p.x, tail[1]] : [tail[0], p.y]);
    }
    const start = worldToScreen(points[0][0] + 0.5, points[0][1] + 0.5);
    ctx.moveTo(start.x, start.y);
    for (let i = 1; i < points.length; i++) {
      const pt = worldToScreen(points[i][0] + 0.5, points[i][1] + 0.5);
      ctx.lineTo(pt.x, pt.y);
    }
    const head = worldToScreen(wx + 0.5, wy + 0.5);
    ctx.lineTo(head.x, head.y);
    ctx.stroke();
  }

  // Head dot
  const { x: dx, y: dy } = worldToScreen(wx + 0.5, wy + 0.5);
  const r = 5 * scaleX;

  ctx.beginPath();
  ctx.arc(dx, dy, r, 0, 2 * Math.PI);
  ctx.fillStyle = color;
  ctx.fill();
  const gradient = ctx.createRadialGradient(dx, dy, 0, dx, dy, r * 1.2);
  gradient.addColorStop(0, 'rgba(0,0,0,.1)');
  gradient.addColorStop(1, 'rgba(0,0,0,.3)');
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(0,0,0,.5)';
  ctx.stroke();

  if (isSelf && session.renderSettings?.toggles?.renderServerPosition && p.serverPosition) {
    const server = worldToScreen(p.serverPosition[0] + 0.5, p.serverPosition[1] + 0.5);
    ctx.fillStyle = 'rgba(0,0,0,.2)';
    ctx.beginPath();
    ctx.arc(server.x, server.y, r, 0, 2 * Math.PI);
    ctx.fill();
  }

  // Highlight ring around the player being spectated, so it's easy to pick
  // them out of a crowd. Drawn just outside the head dot (and outside the
  // invincibility shield radius below) with a slow pulse so it stays
  // visible against any background/player color.
  if (p.invincible && p.invincibleT != null) {
    const elapsed = performance.now() - p.invincibleT;
    if (elapsed <= INVINCIBLE_FADE_END_MS) {
      let shieldAlpha = 1;
      if (elapsed >= INVINCIBLE_FADE_START_MS) {
        shieldAlpha = Math.max(0, 1 - (elapsed - INVINCIBLE_FADE_START_MS) / (INVINCIBLE_FADE_END_MS - INVINCIBLE_FADE_START_MS));
      }
      ctx.save();
      ctx.globalAlpha = shieldAlpha;
      ctx.beginPath();
      ctx.arc(dx, dy, r, 0, 2 * Math.PI);
      const shield = ctx.createRadialGradient(dx, dy, 0, dx, dy, r);
      shield.addColorStop(0, 'rgba(255,255,255,1)');
      shield.addColorStop(1, 'rgba(255,255,255,.4)');
      ctx.fillStyle = shield;
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.3)';
      ctx.lineWidth = .5 * scaleX;
      ctx.stroke();
      ctx.restore();
    }
  }

  // Name label
  if (p.name && !isSelf && (session.renderSettings?.toggles?.showNames ?? session.viewerSettings.showNames !== false)) {
    ctx.globalAlpha = alpha;
    const nameCanvas = getNameCanvas(rec, color);
    if (nameCanvas) {
      ctx.drawImage(
        nameCanvas,
        dx - (nameCanvas.width / 16 + 1) * scaleX,
        dy - 9 * scaleX,
        (nameCanvas.width / 8) * scaleX,
        (nameCanvas.height / 8) * scaleY
      );
    }
  }

  ctx.restore();
}

function findKeyFor(session, rec) {
  for (const [id, v] of session.players.entries()) {
    if (v === rec) return id;
  }
  return null;
}

export function startRenderLoop(canvas, session) {
  let running = true;
  function tick() {
    if (!running) return;
    renderFrame(canvas, session);
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  return () => { running = false; };
}
