// ═══════════════════════════════════════════════════════════════
//  TAM FULL VALUE MAPPING — reference for any TamState userscript
//  Every possible value documented with type, range, and meaning
// ═══════════════════════════════════════════════════════════════

const TAM_MAP = {

  // ─── PLAYER OBJECT ────────────────────────────────────────────
  // Access: window.TamState.players[i]  or  window.TamState.localPlayer
  player: {
    id:       { type: 'number',  desc: 'Unique server-assigned player ID' },
    pos:      { type: '[number, number]', desc: 'World tile position [x, y]. Fractional mid-tile = 0.5 offset. Range: [0, gridSize-1]' },
    d: {
      type: 'number (enum)',
      values: {
        0: 'moving RIGHT',
        1: 'moving DOWN',
        2: 'moving LEFT',
        3: 'moving UP',
        4: 'STOPPED / dead direction',
      }
    },
    trs: {
      type: '[[number, number], ...]',
      desc: 'Trail vertex array. Each entry is a world [x, y] corner where player changed direction. Empty array = no active trail.',
    },
    m:    { type: 'boolean', desc: 'true = this is the local (self) player' },
    c:    { type: 'string',  desc: 'Raw color string from server. Format: "h,s" where h=hue index (0–345 step 15), s=saturation (100|60). OR a hex string if custom.' },
    na:   { type: 'string',  desc: 'Filtered display name (HTML entities escaped). Empty string if unnamed.' },
    nac:  { type: 'HTMLCanvasElement | null', desc: 'Firefox name label cache canvas. null until first render.' },
    setTime: { type: 'number', desc: 'performance.now() timestamp of last server position sync' },
    de:   { type: 'number | null', desc: 'performance.now() of death event. null = alive. Used to fade out player over 1000ms.' },
    b:    { type: 'number | null', desc: 'performance.now() of last emote trigger. null = no emote active.' },
    bt: {
      type: 'number (enum)',
      values: {
        0: 'circle emote',
        1: 'heart emote',
        2: 'skull emote',
      }
    },
    skull: { type: 'HTMLCanvasElement | null', desc: 'Cached tinted skull canvas for skull emote. null until generated.' },
    nt:   { type: 'number | null', desc: 'Spawn invincibility. null = not invincible. -9000 = invincible and just spawned. performance.now() value = invincibility start time. Fades out 2000–4000ms after spawn.' },
    serPos: { type: '[number, number] | undefined', desc: 'Server-confirmed position [x, y]. Only on local player (m===true). Used for prediction correction.' },
    serD: {
      type: 'number | undefined',
      desc: 'Server-confirmed direction. Only on local player. Same enum as d (0–4).',
    },
  },

  // ─── GRID MATRIX CELL ─────────────────────────────────────────
  // Access: window.TamState.gridMatrix[col][row]
  // gridMatrix is indexed [x][y] — col first, then row
  gridCell: {
    c: {
      type: 'string',
      desc: 'Current tile color. Either DEFAULT_EMPTY_CELL_COLOR (#666666) for unclaimed, or a palette hex like "#ff0000" for owned territory.',
      special: {
        '#666666': 'DEFAULT_EMPTY_CELL_COLOR — unclaimed tile',
        '#333333': 'DEFAULT_BACKGROUND_COLOR — canvas background',
        'any palette hex': 'Owned by a player with that color',
      }
    },
    t: {
      type: 'number | null',
      desc: 'performance.now() timestamp of last capture animation start. null = no animation pending. Used to drive the tile capture expand animation (400ms duration).',
    },
    em: { type: 'boolean', desc: 'Reserved/unused in current version. Always false.' },
    m:  { type: 'boolean', desc: 'Reserved/unused in current version. Always false.' },
  },

  // ─── CAMERA ───────────────────────────────────────────────────
  // Access: window.TamState.cameraPos etc.
  camera: {
    cameraPos: {
      type: '[number, number]',
      desc: 'Camera center in world tile coordinates [x, y]. Follows local player with lerp. Range: [0, gridSize].',
    },
    cameraWidthDelta: {
      type: 'number',
      desc: 'Half-width of visible tile range on X axis. Typically 22–23 tiles. Affected by isArenaResetActive.',
    },
    cameraHeightDelta: {
      type: 'number',
      desc: 'Half-height of visible tile range on Y axis. Typically 13–14 tiles.',
    },
  },

  // ─── GAME STATE FLAGS ─────────────────────────────────────────
  flags: {
    isGameActive:       { type: 'boolean', desc: 'true when a game session is running and canvas is visible.' },
    isSpectating:       { type: 'boolean', desc: 'true when game-over scoreboard is open in spectate mode.' },
    isCustomMapMode:    { type: 'boolean', desc: 'true when gamemode is custom map (handshake m===3). Affects minimap.' },
    isArenaResetActive: { type: 'boolean', desc: 'true after yy socket event (arena shrink). Reduces camera deltas.' },
    isAprilFoolsActive: { type: 'boolean', desc: 'true if server sent apr event. Enables translation overlays.' },
    isScoreboardActive: { type: 'boolean', desc: 'true when game-over scoreboard overlay is displayed.' },
    serverFullFlag:     { type: 'boolean', desc: 'true if server sent fu (full) event. Triggers region fallback.' },
  },

  // ─── SCORING ──────────────────────────────────────────────────
  scoring: {
    finalScore: {
      type: 'number',
      desc: 'Current tile territory count (ca socket event). Represents how many tiles the local player owns. Range: [0, gridSize²].',
    },
    totalKills: {
      type: 'number',
      desc: 'Kill count this session (ki socket event). Starts at 0 on spawn.',
    },
    pointScaleFactor: {
      type: 'number',
      desc: 'Kill point multiplier from server handshake (ks field). Typically 100. Score = finalScore + totalKills * pointScaleFactor.',
    },
    killsComboCounter: {
      type: 'number',
      desc: 'Running kill combo accumulator. Resets if >10000ms since last kill. Displayed as +N in HUD.',
    },
    capturedComboCounter: {
      type: 'number',
      desc: 'Running territory capture combo. Can go negative (lost tiles). Displayed as +N or -N in HUD.',
    },
  },

  // ─── SERVER / NETWORK ─────────────────────────────────────────
  network: {
    serverSpeed: {
      type: 'number',
      desc: 'Tiles per millisecond. From handshake sp field. Typical value: 0.006–0.010. Used for movement prediction compensation.',
    },
    halfPingLatency: {
      type: 'number | null',
      desc: 'One-way latency estimate in ms (pong value / 2). null until first pong. Used for movement prediction offset.',
    },
    localSyncedClock: {
      type: 'number | null',
      desc: 'Server-synchronized clock value in ms. null before first ti/wd event. Advances with each frame using performance.now() delta.',
    },
    serverPauseOffset: {
      type: 'number',
      desc: 'Pause compensation value from server (pa field in handshake and ti events). Added to clock calculations.',
    },
    gridSize: {
      type: 'number',
      desc: 'World dimension in tiles. Square grid: gridSize × gridSize total cells. Common values: 50, 100, 200.',
    },
    serverArenaSetting: {
      type: 'number (enum)',
      values: {
        0: 'standard arena',
        1: 'walled arena — draws white border rect around grid',
        2: 'bordered tiles — draws colored edge lines on boundary tiles',
      }
    },
    minimapWidth: {
      type: 'number',
      desc: 'Minimap canvas resolution in pixels = gridSize / 5. Also the collision buffer dimension.',
    },
  },

  // ─── INPUT / QUEUE ────────────────────────────────────────────
  input: {
    inputQueue: {
      type: 'number[]',
      desc: 'Pending direction inputs queued for emit. Max length 2 (non-stop inputs). Each value: 0=right, 1=down, 2=left, 3=up, 4=stop.',
    },
    pendingInputQueue: {
      type: 'Array<{ d: number, po: [number, number] }>',
      desc: 'Client-prediction pending input log. Each entry: d=direction, po=position snapshot at send time. Used to validate server corrections.',
    },
  },

  // ─── BOUNDS LISTS ─────────────────────────────────────────────
  // Access: window.TamState.lobbyBoundsList etc.
  bounds: {
    lobbyBoundsList: {
      type: 'Array<{ minX, maxX, minY, maxY }>',
      desc: 'List of lobby zone rectangles in tile coords. Drawn as blue (#bbf) outlines. From da socket event.',
    },
    safeZoneBounds: {
      type: 'Array<{ minX, maxX, minY, maxY }>',
      desc: 'List of safe zone rectangles. Drawn as yellow (#ff0) outlines. From da socket event.',
    },
    trailBoundsList: {
      type: 'Array<{ minX, maxX, minY, maxY }>',
      desc: 'List of trail-allowed zone rectangles. Drawn as black outlines. From da socket event.',
    },
  },

  // ─── MINIMAP / COLLISION BUFFER ───────────────────────────────
  minimap: {
    collisionBuffer: {
      type: 'boolean[][]',
      desc: 'minimapWidth × minimapWidth 2D boolean array. collisionBuffer[mx][my] = true means that minimap cell is filled (owned territory). Updated by m socket event.',
    },
  },

  // ─── COLOR PALETTE ────────────────────────────────────────────
  colors: {
    colorPalette: {
      type: 'string[]',
      desc: '69-entry array of raw hex color strings. The canonical full palette all player colors are drawn from.',
    },
    activeColorPalette: {
      type: '{ [rawHex: string]: adjustedHex: string }',
      desc: 'Maps each raw palette hex → brightness-adjusted hex based on clg2 setting. Use this for actual render color lookups.',
    },
    emptyCellColor: {
      type: 'string',
      desc: 'Current adjusted hex for unclaimed tiles. Derived from bgem localStorage setting. Default: #666666.',
    },
    DEFAULT_EMPTY_CELL_COLOR: { type: 'string', value: '#666666' },
    DEFAULT_BACKGROUND_COLOR: { type: 'string', value: '#333333' },
  },

  // ─── LEADERBOARD (DOM-sourced) ────────────────────────────────
  leaderboard: {
    entry: {
      rank:   { type: 'number', desc: '1-indexed rank position' },
      name:   { type: 'string', desc: 'Player display name' },
      score:  { type: 'string', desc: 'Score text as shown in DOM' },
      isSelf: { type: 'boolean', desc: 'true if entry color is rgb(255,85,85) — the local player highlight' },
    }
  },

  // ─── CHAT LOG ─────────────────────────────────────────────────
  chatLog: {
    type: 'string[]',
    desc: 'Append-only array of chat/event strings this session. Includes kill messages like "Killed PlayerName".',
  },

  // ─── DIRECTION ENUM (shared reference) ───────────────────────
  DIRECTION: {
    RIGHT: 0,
    DOWN:  1,
    LEFT:  2,
    UP:    3,
    STOP:  4,
  },

  // ─── DERIVED / COMPUTED ───────────────────────────────────────
  computed: {
    totalScore:      'finalScore + totalKills * pointScaleFactor',
    tilePercent:     '(finalScore / (gridSize * gridSize)) * 100',
    playerCount:     'window.TamState.players.length',
    isInvincible:    'localPlayer.nt !== null',
    hasTrail:        'localPlayer.trs.length > 0',
    isMoving:        'localPlayer.d !== 4',
    isOnOwnTile:     'gridMatrix[floor(pos[0])][floor(pos[1])].c === localPlayer.c',
    isDead:          'localPlayer.de !== null',
    minimapSelfPos:  '{ mx: floor(pos[0] / gridSize * minimapWidth), my: floor(pos[1] / gridSize * minimapWidth) }',
  },
}

