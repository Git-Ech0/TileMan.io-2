/**
 * TileMan.io Spectator Renderer
 *
 * Consumes the state contract broadcast by network-mod.js (keyframe + delta
 * messages built from window.TamState) and paints it onto a <canvas>, the
 * same way the real game paints its own canvas from its own local state.
 *
 * This is a *parallel* renderer, not a hook into hra.min.js's internal
 * renderActiveGrid()/drawPlayer() — those are closures over private,
 * un-exported module variables and can't safely be called with foreign
 * data. Re-implementing the drawing logic here, driven purely by the
 * documented TAM_MAP shapes, is the practical alternative and keeps
 * hra.min.js completely untouched (so upstream updates to it can't break
 * this file, and vice versa).
 *
 * Known simplifications vs. the real renderer (fine for spectating, but
 * worth knowing about if you want pixel-perfect parity later):
 *   - No subpixel zoom-overlap smoothing on tile edges.
 *   - No minimap "projection shadow" for previously-seen-but-now-offscreen
 *     territory.
 *   - No custom player skins (e.g. the Tomas123 easter egg).
 *   - Arena border mode 2 (bordered tiles) is drawn simply, not with the
 *     exact stroke geometry hra.min.js uses.
 */

const TILE_PX = 10;
const INTERP_DELAY_MS = 100; // render slightly "in the past" for smooth motion between ticks
const CAPTURE_FLASH_MS = 400;
const DEATH_FADE_MS = 1000;
const INVINCIBLE_FADE_START_MS = 2000;
const INVINCIBLE_FADE_END_MS = 4000;

export function createSession() {
  return {
    ready: false,
    gridSize: 0,
    tiles: null,            // flat array, tiles[x * gridSize + y] = raw color string
    tileFlash: null,        // flat array, tileFlash[x * gridSize + y] = timestamp of last capture or null
    colorPalette: [],
    emptyCellColor: '#666666',
    backgroundColor: '#333333',
    arenaSetting: 0,
    bounds: { lobby: [], safe: [], trail: [] },
    players: new Map(),     // id -> { prev, curr, prevT, currT }
    camera: { pos: [0, 0], widthDelta: 22, heightDelta: 13 },
    lastDeltaAt: 0,

    selfId: null,           // id of the player being spectated, within `players`
    minimapWidth: 0,
    collisionBuffer: null,  // flat array of 0/1, collisionBuffer[mx * minimapWidth + my]

    hud: {
      finalScore: 0, totalKills: 0, pointScaleFactor: 100,
      killsComboCounter: 0, capturedComboCounter: 0,
      respawnCooldownMs: null, rank: null,
    },
    respawnReceivedAt: null, // local performance.now() when respawnCooldownMs was last (re)set, for client-side countdown

    chatFeed: [],           // [{ text, receivedAt }], newest last
    watchStartedAt: null,   // local performance.now() of first delta where selfId is alive
  };
}

export function destroySession(session) {
  session.players.clear();
  session.tiles = null;
  session.collisionBuffer = null;
  session.chatFeed = [];
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

export function applyKeyframe(session, kf) {
  session.gridSize = kf.gridSize;
  session.tiles = decodeGridRLE(kf.tiles, kf.gridSize);
  session.tileFlash = new Array(kf.gridSize * kf.gridSize).fill(null);
  session.colorPalette = kf.colorPalette;
  session.emptyCellColor = kf.emptyCellColor;
  session.backgroundColor = kf.backgroundColor;
  session.arenaSetting = kf.arenaSetting;
  session.bounds = kf.bounds;
  session.minimapWidth = kf.minimapWidth || 0;
  session.collisionBuffer = kf.collisionBuffer ? kf.collisionBuffer.slice() : null;
  session.ready = true;
}

export function applyDelta(session, delta) {
  if (!session.ready) return;
  const now = performance.now();

  const seen = new Set();
  for (const p of delta.players) {
    seen.add(p.id);
    const snapshot = {
      x: p.x, y: p.y, d: p.d, color: p.color, name: p.name,
      alive: p.alive, invincible: p.invincible, trail: p.trail,
      deathT: p.deathT, invincibleT: p.invincibleT, emote: p.emote,
    };
    const existing = session.players.get(p.id);
    if (existing) {
      existing.prev = existing.curr;
      existing.prevT = existing.currT;
      existing.curr = snapshot;
      existing.currT = now;
    } else {
      session.players.set(p.id, { prev: snapshot, curr: snapshot, prevT: now, currT: now });
    }
  }
  for (const id of session.players.keys()) {
    if (!seen.has(id)) session.players.delete(id);
  }

  if (session.tiles) {
    for (const [x, y, color] of delta.tileDiffs) {
      const idx = x * session.gridSize + y;
      session.tiles[idx] = color;
      session.tileFlash[idx] = now;
    }
  }

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

  session.selfId = delta.selfId;
  if (delta.hud) session.hud = delta.hud;

  if (delta.hud && delta.hud.respawnCooldownMs !== session.hud.respawnCooldownMs) {
    session.respawnReceivedAt = delta.hud.respawnCooldownMs !== null ? now : null;
  }

  const selfRec = session.players.get(delta.selfId);
  if (session.watchStartedAt === null && selfRec && selfRec.curr.alive) {
    session.watchStartedAt = now;
  }
  if (selfRec && !selfRec.curr.alive) {
    session.watchStartedAt = null; // reset so "time watching" restarts on respawn
  }

  session.camera.pos = delta.cameraPos;
  session.camera.widthDelta = delta.cameraWidthDelta;
  session.camera.heightDelta = delta.cameraHeightDelta;
  session.lastDeltaAt = now;
}

// ─── Rendering ──────────────────────────────────────────────────────────────

function resolveColor(session, raw) {
  // Real game adjusts brightness per-viewer via activeColorPalette; we don't
  // have that map here, so raw palette colors are drawn as-is. If you want
  // viewer-local brightness adjustment, reuse window.TamState.activeColorPalette
  // (it's a lookup keyed by these same raw strings) when available.
  return raw;
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

  const renderTime = performance.now() - INTERP_DELAY_MS;
  const { pos: cameraPos, widthDelta, heightDelta } = session.camera;
  const gridSize = session.gridSize;

  const viewTilesX = widthDelta * 2 + 1;
  const viewTilesY = heightDelta * 2 + 1;
  const scaleX = canvas.width / (viewTilesX * TILE_PX);
  const scaleY = canvas.height / (viewTilesY * TILE_PX);

  function worldToScreen(wx, wy) {
    return {
      x: (wx - cameraPos[0] + widthDelta) * TILE_PX * scaleX,
      y: (wy - cameraPos[1] + heightDelta) * TILE_PX * scaleY,
    };
  }

  ctx.fillStyle = session.backgroundColor;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // ── Tiles ──
  const minX = Math.max(Math.floor(cameraPos[0] - widthDelta), 0);
  const maxX = Math.min(Math.ceil(cameraPos[0] + widthDelta), gridSize - 1);
  const minY = Math.max(Math.floor(cameraPos[1] - heightDelta), 0);
  const maxY = Math.min(Math.ceil(cameraPos[1] + heightDelta), gridSize - 1);

  for (let gx = minX; gx <= maxX; gx++) {
    for (let gy = minY; gy <= maxY; gy++) {
      const idx = gx * gridSize + gy;
      const raw = session.tiles[idx];
      const fill = raw === undefined ? session.emptyCellColor : resolveColor(session, raw);
      const { x: sx, y: sy } = worldToScreen(gx, gy);
      const w = TILE_PX * scaleX + 0.5; // slight overdraw hides seams between tiles
      const h = TILE_PX * scaleY + 0.5;

      ctx.fillStyle = fill;
      ctx.fillRect(sx, sy, w, h);

      const flashAt = session.tileFlash[idx];
      if (flashAt !== null) {
        const dt = performance.now() - flashAt;
        if (dt > CAPTURE_FLASH_MS) {
          session.tileFlash[idx] = null;
        } else {
          const alpha = 1 - dt / CAPTURE_FLASH_MS;
          ctx.strokeStyle = `rgba(255,255,255,${alpha * 0.6})`;
          ctx.lineWidth = 2;
          ctx.strokeRect(sx + 1, sy + 1, w - 2, h - 2);
        }
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

  // ── Players ──
  for (const [id, rec] of session.players.entries()) {
    drawPlayer(ctx, rec, session, renderTime, worldToScreen, scaleX, id === session.selfId);
  }

  // ── Overlays (minimap, HUD, kill feed, respawn countdown) ──
  drawMinimap(ctx, canvas, session);
  drawHud(ctx, session);
  drawChatFeed(ctx, canvas, session);
  drawRespawnCountdown(ctx, canvas, session);
}

function drawMinimap(ctx, canvas, session) {
  if (!session.collisionBuffer || !session.minimapWidth || session.gridSize <= 50) return;

  const mw = session.minimapWidth;
  const size = Math.min(120, canvas.width * 0.18);
  const cell = size / mw;
  const margin = 10;
  const ox = canvas.width - size - margin;
  const oy = margin;

  ctx.save();
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.fillRect(ox - 2, oy - 2, size + 4, size + 4);

  const selfRec = session.players.get(session.selfId);
  const ownColor = selfRec ? resolveColor(session, selfRec.curr.color) : '#fff';
  ctx.fillStyle = ownColor;
  for (let mx = 0; mx < mw; mx++) {
    for (let my = 0; my < mw; my++) {
      if (session.collisionBuffer[mx * mw + my]) {
        ctx.fillRect(ox + mx * cell, oy + my * cell, cell + 0.5, cell + 0.5);
      }
    }
  }

  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth = 1;
  ctx.strokeRect(ox, oy, size, size);

  if (selfRec) {
    const mx = (selfRec.curr.x / (session.gridSize - 1)) * size;
    const my = (selfRec.curr.y / (session.gridSize - 1)) * size;
    ctx.beginPath();
    ctx.arc(ox + mx, oy + my, 2.5, 0, 2 * Math.PI);
    ctx.fillStyle = 'rgba(250,250,250,0.9)';
    ctx.fill();
  }
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
    const start = worldToScreen(p.trail[0][0], p.trail[0][1]);
    ctx.moveTo(start.x, start.y);
    for (let i = 1; i < p.trail.length; i++) {
      const pt = worldToScreen(p.trail[i][0], p.trail[i][1]);
      ctx.lineTo(pt.x, pt.y);
    }
    const head = worldToScreen(wx, wy);
    ctx.lineTo(head.x, head.y);
    ctx.stroke();
  }

  // Head dot
  const { x: dx, y: dy } = worldToScreen(wx, wy);
  const r = 5 * scaleX;

  ctx.beginPath();
  ctx.arc(dx, dy, r, 0, 2 * Math.PI);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(0,0,0,.5)';
  ctx.stroke();

  // Highlight ring around the player being spectated, so it's easy to pick
  // them out of a crowd. Drawn just outside the head dot (and outside the
  // invincibility shield radius below) with a slow pulse so it stays
  // visible against any background/player color.
  if (isSelf) {
    const pulse = 0.7 + 0.3 * Math.sin(performance.now() / 250);
    ctx.save();
    ctx.globalAlpha = alpha * pulse;
    ctx.beginPath();
    ctx.arc(dx, dy, r + 5 * scaleX, 0, 2 * Math.PI);
    ctx.strokeStyle = '#ffd23f';
    ctx.lineWidth = 2 * scaleX;
    ctx.setLineDash([4 * scaleX, 3 * scaleX]);
    ctx.stroke();
    ctx.restore();
  }

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
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = 1.5 * scaleX;
      ctx.stroke();
      ctx.restore();
    }
  }

  // Name label
  if (p.name) {
    ctx.globalAlpha = alpha;
    ctx.font = `${Math.max(10, 12 * scaleX)}px Rajdhani, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#fff';
    ctx.fillText(p.name, dx, dy - r - 4);
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
