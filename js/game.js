(() => {
  'use strict';

  // ---------- Canvas ----------
  const canvas = document.getElementById('lane-canvas');
  const ctx = canvas.getContext('2d');
  const CANVAS_W = canvas.width;
  const CANVAS_H = canvas.height;

  const insetCanvas = document.getElementById('pin-inset-canvas');
  const insetCtx = insetCanvas.getContext('2d');
  const INSET_W = insetCanvas.width;
  const INSET_H = insetCanvas.height;

  // ---------- Real regulation geometry (USBC) ----------
  // Foul line to headpin: 60 ft. Pin spacing: 12in center-to-center, equilateral
  // triangle (row depth = 12in * sin(60deg)). Lane width: 41.5in across 39 boards.
  const FOUL_TO_HEADPIN_FT = 60;
  const PIN_ROW_DEPTH_FT = Math.sin(Math.PI / 3); // 12in spacing -> ~0.866ft between rows
  const LANE_WIDTH_IN = 41.5;
  const BOARD_COUNT = 39;
  const BOARD_WIDTH_FT = (LANE_WIDTH_IN / BOARD_COUNT) / 12;
  const LANE_WIDTH_FT = LANE_WIDTH_IN / 12;
  const LANE_TOTAL_FT = 64; // a little past the back pin row (~62.6ft) for visual pit margin
  const GUTTER_WIDTH_FT = 9.25 / 12; // regulation gutter: 9.25in wide each side, ~1.875in deep

  function boardToNx(board) {
    return (board - 0.5) / BOARD_COUNT;
  }
  function nxToBoard(nx) {
    return Math.min(BOARD_COUNT, Math.max(1, Math.round(nx * BOARD_COUNT + 0.5)));
  }
  function feetToS(feet) {
    return feet / LANE_TOTAL_FT;
  }
  function sToFeet(s) {
    return s * LANE_TOTAL_FT;
  }

  // ---------- Pin layout — real measured triangle, not eyeballed ----------
  const PIN_ROWS = [
    { ids: [1], lateralFt: [0] },
    { ids: [2, 3], lateralFt: [-0.5, 0.5] },
    { ids: [4, 5, 6], lateralFt: [-1, 0, 1] },
    { ids: [7, 8, 9, 10], lateralFt: [-1.5, -0.5, 0.5, 1.5] },
  ];
  const PIN_DEFS = [];
  PIN_ROWS.forEach((row, rowIdx) => {
    const feet = FOUL_TO_HEADPIN_FT + rowIdx * PIN_ROW_DEPTH_FT;
    row.ids.forEach((id, i) => {
      const board = 20 + row.lateralFt[i] / BOARD_WIDTH_FT;
      PIN_DEFS.push({ id, feet, board, nx: boardToNx(board), s: feetToS(feet) });
    });
  });
  const PIN_RADIUS_NX = 0.024;
  const KNOCK_RADIUS_BASE = 0.050;

  const ADJACENCY = {
    1: [2, 3],
    2: [1, 4, 5],
    3: [1, 5, 6],
    4: [2, 7, 8],
    5: [2, 3, 4, 6, 8, 9],
    6: [3, 5, 9, 10],
    7: [4, 8],
    8: [4, 5, 7, 9],
    9: [5, 6, 8, 10],
    10: [6, 9],
  };

  // ---------- Ball creator access gate ----------
  const GATE_REPO_OWNER = 'ViperLuna';
  const GATE_REPO_NAME = 'vbbowling';
  const GATE_BRANCH = 'main';
  const BALLS_PATH = 'data/balls.json';

  function githubHeaders(token) {
    return { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
  }

  async function checkRepoWriteAccess(token) {
    const headers = githubHeaders(token);
    const userRes = await fetch('https://api.github.com/user', { headers });
    if (!userRes.ok) throw new Error(userRes.status === 401 ? 'Invalid token.' : `GitHub error (${userRes.status}).`);
    const user = await userRes.json();

    const permRes = await fetch(
      `https://api.github.com/repos/${GATE_REPO_OWNER}/${GATE_REPO_NAME}/collaborators/${encodeURIComponent(user.login)}/permission`,
      { headers }
    );
    if (!permRes.ok) {
      if (permRes.status === 404 || permRes.status === 403) return { allowed: false, login: user.login };
      throw new Error(`GitHub error checking permission (${permRes.status}).`);
    }
    const permData = await permRes.json();
    const allowed = permData.permission === 'admin' || permData.permission === 'write';
    return { allowed, login: user.login };
  }

  function utf8ToBase64(str) {
    return btoa(unescape(encodeURIComponent(str)));
  }

  function contentsUrl(path, ref) {
    const base = `https://api.github.com/repos/${GATE_REPO_OWNER}/${GATE_REPO_NAME}/contents/${path}`;
    return ref ? `${base}?ref=${ref}` : base;
  }

  async function getRepoFileSha(token, path) {
    const res = await fetch(contentsUrl(path, GATE_BRANCH), { headers: githubHeaders(token) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Could not read ${path} (${res.status}).`);
    const data = await res.json();
    return data.sha;
  }

  // Writes (creates or updates) a file in the repo via the Contents API, as a
  // real commit on GATE_BRANCH. base64Content is the raw file content already
  // base64-encoded (text or binary, GitHub's API treats both the same way).
  async function putRepoFile(token, path, base64Content, message, sha) {
    const putRes = await fetch(contentsUrl(path), {
      method: 'PUT',
      headers: { ...githubHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, content: base64Content, sha: sha || undefined, branch: GATE_BRANCH }),
    });
    if (!putRes.ok) {
      const body = await putRes.json().catch(() => ({}));
      throw new Error(body.message || `Could not publish ${path} (${putRes.status}).`);
    }
    return putRes.json();
  }

  async function deleteRepoFile(token, path, message, sha) {
    const res = await fetch(contentsUrl(path), {
      method: 'DELETE',
      headers: { ...githubHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, sha, branch: GATE_BRANCH }),
    });
    if (!res.ok) throw new Error(`Could not delete ${path} (${res.status}).`);
  }

  async function publishBallsFile(token, ballsArray, commitMessage) {
    const sha = await getRepoFileSha(token, BALLS_PATH);
    const newContent = JSON.stringify({ balls: ballsArray }, null, 2) + '\n';
    return putRepoFile(token, BALLS_PATH, utf8ToBase64(newContent), commitMessage, sha);
  }

  function ballImagePath(id) {
    return `data/ball-images/${id}.png`;
  }

  // ---------- Ball creator ----------
  // Length/Hook/Backend on a 0-15 scale, matching the shape of real ball spec
  // sheets. Each coverstock caps what's achievable — a plastic ball can't have
  // real hook no matter the slider, a solid reactive can't skid forever.
  // absorption/carrydown drive how each coverstock interacts with lane oil
  // (see OIL_ABSORPTION_RATE/OIL_CARRYDOWN_RATE below, now per-ball not fixed).
  const COVERSTOCKS = {
    plastic: { label: 'Plastic', lengthRange: [14, 15], hookRange: [1, 3], backendRange: [0, 1], absorption: 0.01, carrydown: 0.55 },
    urethane: { label: 'Urethane', lengthRange: [10, 12], hookRange: [6, 9], backendRange: [4, 7], absorption: 0.01, carrydown: 0.75 },
    solid: { label: 'Solid Reactive', lengthRange: [3, 6], hookRange: [10, 15], backendRange: [7, 12], absorption: 0.09, carrydown: 0.05 },
    pearl: { label: 'Pearl Reactive', lengthRange: [12, 14], hookRange: [8, 12], backendRange: [10, 14], absorption: 0.04, carrydown: 0.15 },
    hybrid: { label: 'Hybrid Reactive', lengthRange: [7, 9], hookRange: [7, 11], backendRange: [6, 9], absorption: 0.06, carrydown: 0.30 },
  };

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function defaultLoadout() {
    const cs = COVERSTOCKS.hybrid;
    return {
      coverstock: 'hybrid',
      weight: 15,
      length: (cs.lengthRange[0] + cs.lengthRange[1]) / 2,
      hook: (cs.hookRange[0] + cs.hookRange[1]) / 2,
      backend: (cs.backendRange[0] + cs.backendRange[1]) / 2,
      label: cs.label,
    };
  }

  function clampLoadoutToCoverstock(loadout) {
    const cs = COVERSTOCKS[loadout.coverstock];
    loadout.length = clamp(loadout.length, cs.lengthRange[0], cs.lengthRange[1]);
    loadout.hook = clamp(loadout.hook, cs.hookRange[0], cs.hookRange[1]);
    loadout.backend = clamp(loadout.backend, cs.backendRange[0], cs.backendRange[1]);
  }

  function presetLoadoutForCoverstock(key) {
    const cs = COVERSTOCKS[key];
    return {
      coverstock: key,
      weight: 15,
      length: (cs.lengthRange[0] + cs.lengthRange[1]) / 2,
      hook: (cs.hookRange[0] + cs.hookRange[1]) / 2,
      backend: (cs.backendRange[0] + cs.backendRange[1]) / 2,
      label: cs.label,
    };
  }

  function loadoutFromBall(ball) {
    return {
      coverstock: ball.coverstock, weight: ball.weight, length: ball.length, hook: ball.hook, backend: ball.backend,
      label: `${ball.name} ($${ball.price})`,
    };
  }

  function ramp(s, threshold) {
    if (s <= threshold) return 0;
    const t = (s - threshold) / (1 - threshold);
    return t * t;
  }

  // ---------- Oil pattern (real Kegel "2022 Starting House Pattern" data) ----------
  const PATTERN_FORWARD = [
    [2, 1, 1850, 0, 0],
    [9, 1, 1150, 0, 3],
    [10, 2, 2100, 3, 8],
    [11, 3, 2850, 8, 15],
    [12, 4, 3400, 15, 25],
    [13, 1, 750, 25, 28],
    [2, 0, 0, 28, 38],
    [2, 0, 0, 38, 43],
  ];
  const PATTERN_REVERSE = [
    [2, 0, 0, 40, 37],
    [12, 2, 1700, 37, 32],
    [11, 2, 1900, 32, 27],
    [10, 3, 3150, 27, 19],
    [9, 3, 3450, 19, 12],
    [8, 1, 1250, 12, 9],
    [2, 1, 1850, 9, 7],
    [2, 0, 0, 7, 0],
  ];
  const DIST_FT = 44; // 0..43 ft, 1ft buckets
  const CARRYDOWN_SPREAD_FT = 4;

  function boxBlur1D(arr, radius) {
    const n = arr.length;
    const out = new Float64Array(n);
    let sum = 0;
    for (let i = 0; i < Math.min(radius, n); i++) sum += arr[i];
    for (let i = 0; i < n; i++) {
      const add = i + radius < n ? arr[i + radius] : 0;
      const sub = i - radius - 1 >= 0 ? arr[i - radius - 1] : 0;
      if (i > 0) sum += add - sub;
      const count = Math.min(i + radius, n - 1) - Math.max(i - radius, 0) + 1;
      out[i] = sum / count;
    }
    return out;
  }

  function blurGrid(grid, boardRadius, distRadius, iterations) {
    let g = grid;
    for (let it = 0; it < iterations; it++) {
      g = g.map((row) => Array.from(boxBlur1D(row, boardRadius)));
      const cols = g[0].length;
      const transposed = Array.from({ length: cols }, (_, c) => g.map((row) => row[c]));
      const blurredCols = transposed.map((col) => Array.from(boxBlur1D(col, distRadius)));
      g = Array.from({ length: g.length }, (_, r) => blurredCols.map((col) => col[r]));
    }
    return g;
  }

  function buildOilGrid() {
    const grid = Array.from({ length: DIST_FT }, () => new Array(BOARD_COUNT).fill(0));
    function applyPass(rows) {
      rows.forEach(([board, loads, tOil, dA, dB]) => {
        if (tOil <= 0) return;
        const lo = board;
        const hi = BOARD_COUNT + 1 - board;
        const width = hi - lo + 1;
        const density = tOil / width;
        const d0 = Math.min(dA, dB);
        const d1 = Math.max(dA, dB) === d0 ? d0 + 1 : Math.max(dA, dB);
        for (let f = Math.floor(d0); f < Math.ceil(d1) && f < DIST_FT; f++) {
          if (f < 0) continue;
          for (let b = lo; b <= hi; b++) grid[f][b - 1] += density;
        }
      });
    }
    applyPass(PATTERN_FORWARD);
    applyPass(PATTERN_REVERSE);
    return blurGrid(grid, 2, 3, 3);
  }

  function oilGridMax(grid) {
    let max = 0;
    for (const row of grid) for (const v of row) if (v > max) max = v;
    return max || 1;
  }

  // ---------- Meters ----------
  const SPEED_PERIOD_MS = 1100;

  function pingpong(elapsedMs, periodMs) {
    const t = (elapsedMs % periodMs) / periodMs;
    return t < 0.5 ? t * 2 : 2 - t * 2;
  }

  // ---------- Standing/aim geometry + accuracy difficulty ----------
  const ARROWS_FT = 15; // real bowling arrows distance
  const AIM_LINE_FT = 30; // how far the aim line is drawn past the foul line

  // Accuracy zone widths in boards (each side of the aim board), and how long
  // one full sweep of the dot across the lane takes. Smaller/faster = harder.
  const DIFFICULTY = {
    easy: { green: 2, yellow: 4, sweepMs: 1500 },
    medium: { green: 1.5, yellow: 3, sweepMs: 1100 },
    hard: { green: 1, yellow: 2.5, sweepMs: 850 },
    pro: { green: 0.5, yellow: 2, sweepMs: 650 },
  };
  const YELLOW_ERROR_BOARDS = 1.2;
  const RED_ERROR_BOARDS = 5;
  const SPEED_MPH_MIN = 10;
  const SPEED_MPH_MAX = 25;
  const FT_PER_SEC_PER_MPH = 5280 / 3600;

  // ---------- Game state ----------
  function freshRack() {
    const rack = {};
    PIN_DEFS.forEach((p) => { rack[p.id] = true; });
    return rack;
  }

  function freshFrames() {
    return Array.from({ length: 10 }, () => ({ rolls: [] }));
  }

  // Camera windows, in feet along the lane. minFt can be slightly negative
  // (a little room behind the foul line so the ball has somewhere to rest).
  // Default aim view is zoomed to just past the arrows (15ft); drag on the
  // lane to peek further down toward the pins — see camDrag handling below.
  const CAMERA_AIM = { minFt: -3, maxFt: 19 };
  const CAMERA_RESULT = { minFt: 55, maxFt: 65 };

  const game = {
    frames: freshFrames(),
    frameIndex: 0,
    rollInFrame: 0,
    rack: freshRack(),
    state: 'setup', // setup | aim-speed | aim-accuracy | rolling | game-over
    stageStart: performance.now(),
    standingBoard: 20,
    aimBoard: 20,
    spinValue: 0, // -100..100
    difficulty: 'medium',
    speedPower: 0, // 0..1, locked from the speed meter
    accuracyDot: { startPos: 0.5, startDir: 1 },
    lastAccuracyResult: null, // { zone, errorBoards }
    ball: null,
    trail: [],
    prevTrail: [],
    lastStats: null,
    oil: buildOilGrid(),
    oilMax: 0,
    dynamicOil: true,
    camera: { ...CAMERA_AIM },
    cameraTarget: { ...CAMERA_AIM },
    camDragActive: false,
    camDragOffsetFt: 0,
    insetAlpha: 1,
    insetTarget: 1,
    loadout: defaultLoadout(),
    draft: presetLoadoutForCoverstock('hybrid'),
    ballCreatorUnlocked: false,
    githubToken: null,
    githubLogin: null,
    catalog: [],
    editingBallId: null, // null = drafting a brand new ball
    pendingImageBase64: null,
  };
  game.oilMax = oilGridMax(game.oil);

  // ---------- DOM refs ----------
  const el = {
    message: document.getElementById('message'),
    actionBtn: document.getElementById('action-btn'),
    frameIndicator: document.getElementById('frame-indicator'),
    scoreboard: document.getElementById('scoreboard'),
    lastRollStats: document.getElementById('last-roll-stats'),
    newGameBtn: document.getElementById('new-game-btn'),
    resetLaneBtn: document.getElementById('reset-lane-btn'),
    dynamicOilToggle: document.getElementById('dynamic-oil-toggle'),
    ballToggleBtn: document.getElementById('ball-toggle-btn'),
    ballPanel: document.getElementById('ball-panel'),
    ballGate: document.getElementById('ball-gate'),
    ballFields: document.getElementById('ball-fields'),
    gateTokenInput: document.getElementById('gate-token-input'),
    gateVerifyBtn: document.getElementById('gate-verify-btn'),
    gateStatus: document.getElementById('gate-status'),
    coverstockSelect: document.getElementById('coverstock-select'),
    weightSlider: document.getElementById('weight-slider'),
    weightValue: document.getElementById('weight-value'),
    lengthSlider: document.getElementById('length-slider'),
    lengthValue: document.getElementById('length-value'),
    hookSlider: document.getElementById('hook-slider'),
    hookValue: document.getElementById('hook-value'),
    backendSlider: document.getElementById('backend-slider'),
    backendValue: document.getElementById('backend-value'),
    playBallSelect: document.getElementById('play-ball-select'),
    editTargetSelect: document.getElementById('edit-target-select'),
    ballNameInput: document.getElementById('ball-name-input'),
    ballPriceInput: document.getElementById('ball-price-input'),
    publishBtn: document.getElementById('publish-btn'),
    deleteBallBtn: document.getElementById('delete-ball-btn'),
    forgetTokenBtn: document.getElementById('forget-token-btn'),
    publishStatus: document.getElementById('publish-status'),
    playBallThumb: document.getElementById('play-ball-thumb'),
    editBallThumb: document.getElementById('edit-ball-thumb'),
    ballImageInput: document.getElementById('ball-image-input'),
    standingSlider: document.getElementById('standing-slider'),
    standingValue: document.getElementById('standing-value'),
    aimSlider: document.getElementById('aim-slider'),
    aimValue: document.getElementById('aim-value'),
    spinSlider: document.getElementById('spin-slider'),
    spinValueEl: document.getElementById('spin-value'),
    difficultySelect: document.getElementById('difficulty-select'),
    speedMeterBlock: document.getElementById('meter-speed'),
    fillSpeed: document.getElementById('fill-speed'),
    cursorSpeed: document.getElementById('cursor-speed'),
    balkBtn: document.getElementById('balk-btn'),
  };

  // ---------- Scoring ----------
  function computeFrameScores() {
    const { frames } = game;
    const results = new Array(10).fill(null);
    for (let i = 0; i < 9; i++) {
      const r = frames[i].rolls;
      if (r.length === 0) { results[i] = null; continue; }
      if (r[0] === 10) {
        const lookahead = frames[i + 1].rolls.concat(frames[i + 2] ? frames[i + 2].rolls : []);
        results[i] = lookahead.length >= 2 ? 10 + lookahead[0] + lookahead[1] : null;
      } else if (r.length === 2) {
        const sum = r[0] + r[1];
        if (sum === 10) {
          const lookahead = frames[i + 1].rolls;
          results[i] = lookahead.length >= 1 ? 10 + lookahead[0] : null;
        } else {
          results[i] = sum;
        }
      } else {
        results[i] = null;
      }
    }
    const r10 = frames[9].rolls;
    results[9] = r10.length > 0 ? r10.reduce((a, b) => a + b, 0) : null;

    const cumulative = new Array(10).fill(null);
    let running = 0;
    for (let i = 0; i < 10; i++) {
      if (results[i] == null) { cumulative[i] = null; continue; }
      if (i > 0 && cumulative[i - 1] == null && frames[i - 1].rolls.length > 0) {
        cumulative[i] = null;
        continue;
      }
      running += results[i];
      cumulative[i] = running;
    }
    return { frameScores: results, cumulative };
  }

  function formatFrameRolls(frameIdx) {
    const r = game.frames[frameIdx].rolls;
    const out = [];
    if (frameIdx < 9) {
      if (r.length >= 1) out.push(r[0] === 10 ? 'X' : (r[0] === 0 ? '-' : String(r[0])));
      if (r.length >= 2) {
        if (r[0] + r[1] === 10) out.push('/');
        else out.push(r[1] === 0 ? '-' : String(r[1]));
      }
    } else {
      for (let i = 0; i < r.length; i++) {
        const v = r[i];
        if (v === 10) { out.push('X'); continue; }
        if (i === 0) { out.push(v === 0 ? '-' : String(v)); continue; }
        const prev = r[i - 1];
        if (prev !== 10 && prev + v === 10) { out.push('/'); continue; }
        out.push(v === 0 ? '-' : String(v));
      }
    }
    return out;
  }

  function renderScoreboard() {
    const { cumulative } = computeFrameScores();
    el.scoreboard.innerHTML = '';
    for (let i = 0; i < 10; i++) {
      const box = document.createElement('div');
      box.className = 'frame-box' + (i === game.frameIndex && game.state !== 'game-over' ? ' active' : '');
      const rolls = formatFrameRolls(i);
      box.innerHTML = `
        <div class="fnum">${i + 1}</div>
        <div class="rolls">${rolls.map((r) => `<span>${r}</span>`).join('') || '&nbsp;'}</div>
        <div class="total">${cumulative[i] != null ? cumulative[i] : ''}</div>
      `;
      el.scoreboard.appendChild(box);
    }
    el.frameIndicator.textContent = game.state === 'game-over'
      ? `Final Score: ${cumulative[9] != null ? cumulative[9] : cumulative.filter((c) => c != null).pop() || 0}`
      : `Frame ${game.frameIndex + 1} / 10`;
  }

  // ---------- Ball path & physics ----------
  // Three phases along s (0=foul line, 1=deck): skid (no curve), hook (the
  // main break, engaging at skidS and ramping through the rest of the shot),
  // and backend (an extra late kick near the pins). Length pushes skidS out
  // (longer = later break), Hook sets the main break's strength, Backend adds
  // the late-kick strength. Power still affects timing: a slower ball gets
  // more time to hook, same relationship real bowlers rely on.
  // impactS/bounceMag etc. add a post-contact wobble once the ball reaches a
  // pin (see computeShot) — inert (bounceMag 0, impactS Infinity) beforehand,
  // so this same function is safe to use for hit-testing before contact exists.
  function pathNX(params, s) {
    let x = params.startNX
      + params.angleOffset * s
      + params.spinDir * params.hookMag * ramp(s, params.skidS)
      + params.spinDir * params.backendMag * ramp(s, params.backendS);
    if (s > params.impactS) {
      const t = s - params.impactS;
      x += params.bounceMag * Math.sin(t * params.bounceFreq) * Math.exp(-t * params.bounceDamping);
    }
    return x;
  }

  // standingBoard/aimBoard are real board numbers (1..39); aimBoard is where
  // the ball crosses the arrows (ARROWS_FT down the lane) if released exactly
  // as set up. spinValue is -100..100, speedPower is 0..1 (from the Speed meter).
  function computeShot(standingBoard, aimBoard, spinValue, speedPower, rack, loadout) {
    const startNX = boardToNx(standingBoard);
    const aimNX = boardToNx(aimBoard);
    const aimS = feetToS(ARROWS_FT);
    const angleOffset = (aimNX - startNX) / aimS;
    const spinDev = clamp(spinValue / 100, -1, 1);
    const powerFactor = 1.5 - speedPower * 0.9;

    const lengthNorm = loadout.length / 15;
    const hookNorm = loadout.hook / 15;
    const backendNorm = loadout.backend / 15;

    const baseParams = {
      startNX,
      angleOffset,
      spinDir: spinDev,
      hookMag: hookNorm * 0.75 * powerFactor,
      backendMag: backendNorm * 0.55 * powerFactor,
      skidS: 0.12 + lengthNorm * 0.55,
      backendS: 0.82,
      impactS: Infinity, bounceMag: 0, bounceFreq: 0, bounceDamping: 0,
    };

    let finalS = 1.0;
    let guttered = false;
    const STEPS = 200;
    for (let i = 0; i <= STEPS; i++) {
      const s = i / STEPS;
      const nx = pathNX(baseParams, s);
      if (nx < 0.01 || nx > 0.99) {
        finalS = s;
        guttered = true;
        break;
      }
    }

    const knocked = [];
    let impactS = Infinity;
    if (!guttered) {
      const weightFactor = 0.8 + ((loadout.weight - 6) / 10) * 0.2; // 6lb..16lb -> 0.8..1.0
      const knockRadius = KNOCK_RADIUS_BASE * (0.8 + speedPower * 0.6) * weightFactor;
      PIN_DEFS.forEach((p) => {
        if (!rack[p.id]) return;
        const bx = pathNX(baseParams, p.s);
        if (Math.abs(bx - p.nx) < knockRadius + PIN_RADIUS_NX) {
          knocked.push(p.id);
          if (p.s < impactS) impactS = p.s;
        }
      });

      let frontier = knocked.slice();
      for (let pass = 0; pass < 3 && frontier.length; pass++) {
        const next = [];
        frontier.forEach((id) => {
          (ADJACENCY[id] || []).forEach((nid) => {
            if (rack[nid] && !knocked.includes(nid)) {
              const chance = 0.32 + speedPower * 0.4;
              if (Math.random() < chance) {
                knocked.push(nid);
                next.push(nid);
              }
            }
          });
        });
        frontier = next;
      }
    }

    // Lighter balls bounce/deflect more sharply off the pins; heavier balls
    // still react but drive through with a smaller, quicker wobble.
    const weightNorm = (loadout.weight - 6) / 10;
    const params = {
      ...baseParams,
      impactS,
      bounceMag: 0.05 * (1 - weightNorm) + 0.012,
      bounceFreq: 30,
      bounceDamping: 16,
    };

    return { params, finalS, guttered, knocked };
  }

  function applyOilTransition(shot) {
    if (!game.dynamicOil) return;
    const cs = COVERSTOCKS[game.loadout.coverstock];
    const grid = game.oil;
    const STEPS = 150;
    for (let i = 0; i <= STEPS; i++) {
      const s = (i / STEPS) * shot.finalS;
      const nx = pathNX(shot.params, s);
      if (nx < 0 || nx > 1) continue;
      const board = nxToBoard(nx);
      const feet = sToFeet(s);
      const f = Math.max(0, Math.min(DIST_FT - 1, Math.floor(feet)));
      const b = board - 1;
      const current = grid[f][b];
      if (current <= 0) continue;
      const removed = current * cs.absorption;
      grid[f][b] = current - removed;
      const deposit = (removed * cs.carrydown) / CARRYDOWN_SPREAD_FT;
      for (let k = 1; k <= CARRYDOWN_SPREAD_FT; k++) {
        const ff = f + k;
        if (ff >= DIST_FT) break;
        grid[ff][b] += deposit;
      }
    }
  }

  function resetLane() {
    game.oil = buildOilGrid();
    game.oilMax = oilGridMax(game.oil);
  }

  // ---------- Camera / view ----------
  // A "view" maps real lane feet/nx to canvas pixels using ONE uniform px-per-foot
  // scale for both axes (no stretching), so the rendered lane always keeps true
  // proportions no matter how far the camera is zoomed.
  function makeView(canvasW, canvasH, cam) {
    const spanFt = cam.maxFt - cam.minFt;
    const pxPerFt = canvasH / spanFt;
    const laneWpx = LANE_WIDTH_FT * pxPerFt;
    const laneLeft = (canvasW - laneWpx) / 2;
    return {
      canvasW, canvasH, pxPerFt, laneLeft, laneRight: laneLeft + laneWpx, laneWpx,
      minFt: cam.minFt, maxFt: cam.maxFt,
      toX: (nx) => laneLeft + nx * laneWpx,
      toY: (feet) => canvasH - (feet - cam.minFt) * pxPerFt,
    };
  }

  function lerpCamera(cam, target, factor) {
    cam.minFt += (target.minFt - cam.minFt) * factor;
    cam.maxFt += (target.maxFt - cam.maxFt) * factor;
  }

  function updateCamera() {
    let cameraOverridden = false;
    if (game.state === 'rolling' && game.ball) {
      const ballFt = sToFeet(game.ball.s);
      const t = Math.min(1, game.ball.s / Math.max(0.01, game._shotFinalS || 1));
      const span = 30 - t * 16; // zoom in from 30ft window to 14ft window as the ball travels
      let minFt = ballFt - span / 2;
      let maxFt = ballFt + span / 2;
      if (minFt < -3) { maxFt += -3 - minFt; minFt = -3; }
      if (maxFt > LANE_TOTAL_FT + 1) { minFt -= maxFt - (LANE_TOTAL_FT + 1); maxFt = LANE_TOTAL_FT + 1; }
      game.cameraTarget = { minFt, maxFt };
      game.insetTarget = 0;
    } else if (game.state === 'setup' || game.state.startsWith('aim-')) {
      game.cameraTarget = CAMERA_AIM;
      game.insetTarget = 1;
      // Dragging on the lane peeks the camera forward, 1:1 with the finger/
      // mouse, instead of lerping — feels like scrolling, not floaty.
      // Releasing just stops overriding it, so the lerp below eases it back.
      if (game.camDragActive) {
        game.camera.minFt = CAMERA_AIM.minFt + game.camDragOffsetFt;
        game.camera.maxFt = CAMERA_AIM.maxFt + game.camDragOffsetFt;
        cameraOverridden = true;
      }
    } else {
      // between the roll finishing and the next aim phase: show the result at the pins
      game.cameraTarget = CAMERA_RESULT;
      game.insetTarget = 0;
    }
    if (!cameraOverridden) lerpCamera(game.camera, game.cameraTarget, 0.08);
    game.insetAlpha += (game.insetTarget - game.insetAlpha) * 0.15;
  }

  // ---------- Rendering ----------
  function drawLane(view) {
    ctx2(view).clearRect(0, 0, view.canvasW, view.canvasH);
    const c = ctx2(view);

    c.fillStyle = '#10141a';
    c.fillRect(0, 0, view.canvasW, view.canvasH);

    const topY = view.toY(LANE_TOTAL_FT);
    const bottomY = view.toY(view.minFt < 0 ? view.minFt : 0);
    const grad = c.createLinearGradient(0, topY, 0, bottomY);
    grad.addColorStop(0, '#4a3018');
    grad.addColorStop(1, '#3a2618');
    c.fillStyle = grad;
    c.fillRect(view.laneLeft, topY, view.laneWpx, Math.max(0, bottomY - topY));

    // gutters: regulation 9.25in recessed channel flanking each side of the lane
    const gutterHpx = Math.max(0, bottomY - topY);
    const gutterWpx = GUTTER_WIDTH_FT * view.pxPerFt;
    const gutterGrad = c.createLinearGradient(0, topY, 0, bottomY);
    gutterGrad.addColorStop(0, '#6b7280');
    gutterGrad.addColorStop(1, '#454b54');
    c.fillStyle = gutterGrad;
    c.fillRect(view.laneLeft - gutterWpx, topY, gutterWpx, gutterHpx);
    c.fillRect(view.laneRight, topY, gutterWpx, gutterHpx);
    c.strokeStyle = 'rgba(0,0,0,0.55)';
    c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(view.laneLeft, topY); c.lineTo(view.laneLeft, bottomY);
    c.moveTo(view.laneRight, topY); c.lineTo(view.laneRight, bottomY);
    c.stroke();

    // board grain lines
    c.strokeStyle = 'rgba(85,56,31,0.4)';
    c.lineWidth = 1;
    for (let b = 1; b < BOARD_COUNT; b++) {
      const x = view.toX(b / BOARD_COUNT);
      c.beginPath();
      c.moveTo(x, topY);
      c.lineTo(x, bottomY);
      c.stroke();
    }

    c.strokeStyle = '#6b4a2a';
    c.lineWidth = 2;
    c.strokeRect(view.laneLeft, topY, view.laneWpx, Math.max(0, bottomY - topY));

    // foul line at 0ft
    if (view.minFt <= 0 && view.maxFt >= 0) {
      c.strokeStyle = '#ff5c5c';
      c.lineWidth = 3;
      const y = view.toY(0);
      c.beginPath();
      c.moveTo(view.laneLeft, y);
      c.lineTo(view.laneRight, y);
      c.stroke();
    }

    // aiming arrows at ~15ft, targeting dots at foul line
    if (view.minFt <= 15 && view.maxFt >= 15) {
      c.fillStyle = 'rgba(244,241,232,0.35)';
      [5, 10, 15, 20, 25, 30, 35].forEach((board) => {
        const x = view.toX(boardToNx(board));
        const y = view.toY(15);
        c.beginPath();
        c.moveTo(x, y - 6);
        c.lineTo(x - 4, y + 5);
        c.lineTo(x + 4, y + 5);
        c.closePath();
        c.fill();
      });
    }
    if (view.minFt <= 0 && view.maxFt >= 0) {
      c.fillStyle = 'rgba(244,241,232,0.4)';
      for (let board = 4; board <= 36; board += 4) {
        const x = view.toX(boardToNx(board));
        const y = view.toY(0.5);
        c.beginPath();
        c.arc(x, y, 2.5, 0, Math.PI * 2);
        c.fill();
      }
    }
  }

  function ctx2(view) {
    return view.ctxRef;
  }

  function drawOil(view) {
    const c = ctx2(view);
    const grid = game.oil;
    const max = game.oilMax;
    const cellWft = LANE_WIDTH_FT / BOARD_COUNT;
    for (let f = 0; f < DIST_FT; f++) {
      if (f + 1 < view.minFt || f > view.maxFt) continue;
      const yTop = view.toY(f + 1);
      const yBot = view.toY(f);
      const row = grid[f];
      for (let b = 0; b < BOARD_COUNT; b++) {
        const v = row[b];
        if (v <= 0) continue;
        const alpha = Math.min(0.85, (v / max) * 0.85);
        if (alpha < 0.02) continue;
        const x = view.toX(b / BOARD_COUNT);
        const w = view.toX((b + 1) / BOARD_COUNT) - x;
        c.fillStyle = `rgba(255, 175, 60, ${alpha})`;
        c.fillRect(x, yTop, w + 0.5, Math.max(0, yBot - yTop) + 0.5);
      }
    }
  }

  function drawTrail(view, trail, alpha) {
    if (trail.length < 2) return;
    const c = ctx2(view);
    c.strokeStyle = `rgba(255, 210, 60, ${alpha})`;
    c.lineWidth = 2.5;
    c.beginPath();
    trail.forEach((pt, i) => {
      const x = view.toX(pt.nx);
      const y = view.toY(sToFeet(pt.s));
      if (i === 0) c.moveTo(x, y);
      else c.lineTo(x, y);
    });
    c.stroke();
  }

  function drawPins(view) {
    const c = ctx2(view);
    PIN_DEFS.forEach((p) => {
      if (p.feet < view.minFt - 1 || p.feet > view.maxFt + 1) return;
      const standing = game.rack[p.id];
      const x = view.toX(p.nx);
      const y = view.toY(p.feet);
      const r = PIN_RADIUS_NX * view.laneWpx;
      c.save();
      c.translate(x, y);
      if (!standing) {
        c.globalAlpha = 0.55;
        c.rotate(0.5);
      }
      c.beginPath();
      c.arc(0, 0, r, 0, Math.PI * 2);
      c.fillStyle = standing ? '#f4f1e8' : '#4a4f58';
      c.fill();
      c.strokeStyle = standing ? '#c9c3ac' : '#33373f';
      c.lineWidth = 1.5;
      c.stroke();
      if (standing) {
        c.beginPath();
        c.arc(0, 0, r * 0.4, 0, Math.PI * 2);
        c.strokeStyle = '#d6413c';
        c.lineWidth = 1.2;
        c.stroke();
      }
      c.restore();
    });
  }

  function bounce01(x) {
    const m = ((x % 2) + 2) % 2;
    return m <= 1 ? m : 2 - m;
  }

  function accuracyDotPosNow() {
    const diff = DIFFICULTY[game.difficulty];
    const elapsed = performance.now() - game.stageStart;
    const t = elapsed / diff.sweepMs;
    return bounce01(game.accuracyDot.startPos + game.accuracyDot.startDir * t);
  }

  function isAimingState() {
    return game.state === 'setup' || game.state === 'aim-speed' || game.state === 'aim-accuracy';
  }

  function drawAimLine(view) {
    if (!isAimingState()) return;
    const c = ctx2(view);
    const standingNX = boardToNx(game.standingBoard);
    const aimNX = boardToNx(game.aimBoard);
    const slopePerFt = (aimNX - standingNX) / ARROWS_FT;
    const endNX = standingNX + slopePerFt * AIM_LINE_FT;
    const x0 = view.toX(standingNX), y0 = view.toY(0);
    const x1 = view.toX(endNX), y1 = view.toY(Math.min(AIM_LINE_FT, view.maxFt));
    c.save();
    c.strokeStyle = 'rgba(120, 200, 255, 0.6)';
    c.lineWidth = 1.5;
    c.setLineDash([6, 5]);
    c.beginPath();
    c.moveTo(x0, y0);
    c.lineTo(x1, y1);
    c.stroke();
    c.restore();
  }

  function drawAccuracyBar(view) {
    if (game.state !== 'aim-accuracy') return;
    if (ARROWS_FT < view.minFt || ARROWS_FT > view.maxFt) return;
    const c = ctx2(view);
    const y = view.toY(ARROWS_FT);
    const halfH = 8;
    const diff = DIFFICULTY[game.difficulty];
    const aimNX = boardToNx(game.aimBoard);
    const greenHalf = diff.green / BOARD_COUNT;
    const yellowHalf = diff.yellow / BOARD_COUNT;

    c.fillStyle = 'rgba(255,80,80,0.55)';
    c.fillRect(view.laneLeft, y - halfH, view.laneWpx, halfH * 2);

    c.fillStyle = 'rgba(255,210,60,0.8)';
    const yx0 = view.toX(clamp(aimNX - yellowHalf, 0, 1));
    const yx1 = view.toX(clamp(aimNX + yellowHalf, 0, 1));
    c.fillRect(yx0, y - halfH, yx1 - yx0, halfH * 2);

    c.fillStyle = 'rgba(76,224,122,0.9)';
    const gx0 = view.toX(clamp(aimNX - greenHalf, 0, 1));
    const gx1 = view.toX(clamp(aimNX + greenHalf, 0, 1));
    c.fillRect(gx0, y - halfH, gx1 - gx0, halfH * 2);

    const dotNX = accuracyDotPosNow();
    const dx = view.toX(dotNX);
    c.beginPath();
    c.arc(dx, y, 6, 0, Math.PI * 2);
    c.fillStyle = '#ffffff';
    c.fill();
    c.strokeStyle = '#000';
    c.lineWidth = 1.5;
    c.stroke();
  }

  function drawBall(view) {
    let nx = boardToNx(game.standingBoard), feet = 0;
    if (game.ball) {
      nx = game.ball.nx;
      feet = sToFeet(game.ball.s);
    }
    const c = ctx2(view);
    const x = view.toX(nx);
    const y = view.toY(feet);
    const r = Math.max(3, 0.354 * view.pxPerFt); // real ball radius ~0.354ft
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    const grad = c.createRadialGradient(x - r * 0.3, y - r * 0.3, 1, x, y, r);
    grad.addColorStop(0, '#5aa7ff');
    grad.addColorStop(1, '#1a3a6b');
    c.fillStyle = grad;
    c.fill();
    c.strokeStyle = '#0c1f3d';
    c.lineWidth = 1;
    c.stroke();
  }

  function render() {
    updateCamera();

    const view = makeView(CANVAS_W, CANVAS_H, game.camera);
    view.ctxRef = ctx;
    drawLane(view);
    drawOil(view);
    drawTrail(view, game.prevTrail, 0.18);
    drawTrail(view, game.trail, 0.85);
    drawAimLine(view);
    drawPins(view);
    drawAccuracyBar(view);
    drawBall(view);

    // inset: fixed close-up on the pin deck, fades out once you start rolling
    insetCanvas.style.opacity = String(Math.max(0, game.insetAlpha));
    if (game.insetAlpha > 0.01) {
      const insetView = makeView(INSET_W, INSET_H, { minFt: 57.5, maxFt: 65 });
      insetView.ctxRef = insetCtx;
      drawLane(insetView);
      drawPins(insetView);
    }
  }

  // ---------- Meter UI ----------
  function speedMph(power) {
    return Math.round(SPEED_MPH_MIN + power * (SPEED_MPH_MAX - SPEED_MPH_MIN));
  }

  function updateSpeedMeterUI(now) {
    const isActive = game.state === 'aim-speed';
    const isDone = game.state === 'aim-accuracy' || game.state === 'rolling';
    el.speedMeterBlock.classList.toggle('active', isActive);
    el.speedMeterBlock.classList.toggle('done', isDone);

    let value;
    if (isActive) value = pingpong(now - game.stageStart, SPEED_PERIOD_MS);
    else value = game.speedPower;

    const pct = (value * 100).toFixed(1);
    el.fillSpeed.style.width = pct + '%';
    el.cursorSpeed.style.left = `calc(${pct}% - 2px)`;
    el.speedMeterBlock.querySelector('.meter-label').textContent = `SPEED (${speedMph(value)} MPH)`;
  }

  function updateSetupControlsUI() {
    const disable = !(game.state === 'setup');
    el.standingSlider.disabled = disable;
    el.aimSlider.disabled = disable;
    el.spinSlider.disabled = disable;
    el.difficultySelect.disabled = disable;
  }

  // ---------- Flow control ----------
  function setMessage(msg) {
    el.message.textContent = msg;
  }

  function labelForState() {
    switch (game.state) {
      case 'setup': return 'SET SPEED';
      case 'aim-speed': return 'LOCK SPEED';
      case 'aim-accuracy': return 'LOCK ACCURACY & ROLL';
      case 'rolling': return 'ROLLING...';
      case 'game-over': return 'GAME OVER';
      default: return 'GO';
    }
  }

  function updateActionButton() {
    el.actionBtn.textContent = labelForState();
    el.actionBtn.disabled = game.state === 'rolling' || game.state === 'game-over';
    el.balkBtn.hidden = !(game.state === 'aim-speed' || game.state === 'aim-accuracy');
  }

  function startNewRoll() {
    game.trail = [];
    game.ball = null;
    game.state = 'setup';
    game.lastAccuracyResult = null;
    updateActionButton();
    updateSetupControlsUI();
    setMessage('Set your stance and aim, then lock Speed and Accuracy.');
    renderScoreboard();
  }

  function handleBalk() {
    if (game.state !== 'aim-speed' && game.state !== 'aim-accuracy') return;
    game.state = 'setup';
    updateActionButton();
    updateSetupControlsUI();
    setMessage('Balk — ball back on the return. Reset your stance and aim.');
  }

  function handleAction() {
    if (game.state === 'setup') {
      game.state = 'aim-speed';
      game.stageStart = performance.now();
      updateActionButton();
      updateSetupControlsUI();
      setMessage('Lock your SPEED — click/tap or press SPACE');
    } else if (game.state === 'aim-speed') {
      game.speedPower = pingpong(performance.now() - game.stageStart, SPEED_PERIOD_MS);
      game.state = 'aim-accuracy';
      game.stageStart = performance.now();
      game.accuracyDot = { startPos: Math.random(), startDir: Math.random() < 0.5 ? -1 : 1 };
      updateActionButton();
      setMessage('Lock your ACCURACY — click/tap or press SPACE');
    } else if (game.state === 'aim-accuracy') {
      lockAccuracyAndRoll();
    }
  }

  function lockAccuracyAndRoll() {
    const dotNX = accuracyDotPosNow();
    const dotBoard = dotNX * BOARD_COUNT + 0.5;
    const diff = DIFFICULTY[game.difficulty];
    const distBoards = Math.abs(dotBoard - game.aimBoard);

    let zone, errorBoards;
    if (distBoards <= diff.green) {
      zone = 'green'; errorBoards = 0;
    } else if (distBoards <= diff.yellow) {
      zone = 'yellow';
      errorBoards = dotBoard < game.aimBoard ? -YELLOW_ERROR_BOARDS : YELLOW_ERROR_BOARDS;
    } else {
      zone = 'red';
      errorBoards = (Math.random() * 2 - 1) * RED_ERROR_BOARDS;
    }
    game.lastAccuracyResult = { zone, errorBoards };

    const effectiveAimBoard = clamp(game.aimBoard + errorBoards, 1, BOARD_COUNT);
    launchBall(effectiveAimBoard);
  }

  function launchBall(effectiveAimBoard) {
    game.state = 'rolling';
    updateActionButton();
    setMessage('Rolling...');

    const shot = computeShot(game.standingBoard, effectiveAimBoard, game.spinValue, game.speedPower, game.rack, game.loadout);
    game._shotFinalS = shot.finalS;

    // Real time-of-flight: USBC/manufacturer measurements put an average
    // pro roll (~16.7mph) at about 2.5s to cover the 60ft to the headpin.
    // Drive the animation off the same MPH shown in the HUD and the shot's
    // actual travel distance instead of a hand-tuned duration.
    const mph = speedMph(game.speedPower);
    const distanceFt = sToFeet(shot.finalS);
    // Floor it so an early gutter (a few feet of real travel) still animates
    // instead of the ball vanishing off the foul line in a single frame.
    const durationMs = Math.max(500, (distanceFt / (mph * FT_PER_SEC_PER_MPH)) * 1000);
    const startTime = performance.now();
    game.trail = [];

    function step(now) {
      const t = Math.min(1, (now - startTime) / durationMs);
      const s = t * shot.finalS;
      const nx = pathNX(shot.params, s);
      game.ball = { nx, s };
      game.trail.push({ nx, s });
      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        finishRoll(shot);
      }
    }
    requestAnimationFrame(step);
  }

  function finishRoll(shot) {
    const before = Object.keys(game.rack).filter((id) => game.rack[id]).length;
    shot.knocked.forEach((id) => { game.rack[id] = false; });
    const after = Object.keys(game.rack).filter((id) => game.rack[id]).length;
    const pinsThisRoll = before - after;

    game.prevTrail = game.trail;
    game.ball = null;
    applyOilTransition(shot);

    const mph = speedMph(game.speedPower);
    const spinDesc = describeSpin(game.spinValue);
    const accResult = game.lastAccuracyResult;
    const accDesc = accResult
      ? `${accResult.zone[0].toUpperCase()}${accResult.zone.slice(1)}${accResult.errorBoards ? ` (${accResult.errorBoards > 0 ? '+' : ''}${accResult.errorBoards.toFixed(1)} bd)` : ''}`
      : '—';
    const ballLabel = game.loadout.label || COVERSTOCKS[game.loadout.coverstock].label;
    el.lastRollStats.innerHTML = `
      <span>Ball: <b>${ballLabel} (${game.loadout.weight}lb)</b></span>
      <span>Stand/Aim: <b>${game.standingBoard.toFixed(2)} / ${game.aimBoard.toFixed(2)}</b></span>
      <span>Speed: <b>${mph} MPH</b></span>
      <span>Spin: <b>${spinDesc}</b></span>
      <span>Accuracy: <b>${accDesc}</b></span>
      <span>Pins: <b>${pinsThisRoll}</b></span>
      ${shot.guttered ? '<span style="color:#ff5c5c"><b>GUTTER</b></span>' : ''}
    `;

    recordRoll(pinsThisRoll);
  }

  function describeSpin(v) {
    if (Math.abs(v) < 4) return 'Straight';
    const dir = v < 0 ? 'Hook Left' : 'Hook Right';
    const mag = Math.abs(v);
    return `${dir} (${mag > 65 ? 'Heavy' : mag > 30 ? 'Medium' : 'Light'})`;
  }

  function recordRoll(pinCount) {
    const frame = game.frames[game.frameIndex];
    frame.rolls.push(pinCount);
    renderScoreboard();

    const isTenth = game.frameIndex === 9;

    if (!isTenth) {
      if (game.rollInFrame === 0) {
        if (pinCount === 10) {
          setMessage('STRIKE! 🎳');
          advanceFrame();
        } else {
          game.rollInFrame = 1;
          setMessage(`${pinCount} pins. Go for the spare!`);
          setTimeout(startNewRoll, 900);
        }
      } else {
        const total = frame.rolls[0] + frame.rolls[1];
        setMessage(total === 10 ? 'SPARE!' : `Frame ${game.frameIndex + 1} complete.`);
        advanceFrame();
      }
    } else {
      handleTenthFrame(frame, pinCount);
    }
  }

  function handleTenthFrame(frame, pinCount) {
    const r = frame.rolls;
    if (r.length === 1) {
      if (r[0] === 10) {
        game.rack = freshRack();
        setMessage('STRIKE! Bonus ball — fresh rack.');
      } else {
        setMessage(`${pinCount} pins. Go for the spare!`);
      }
      setTimeout(startNewRoll, 900);
    } else if (r.length === 2) {
      const strikeFirst = r[0] === 10;
      const spareMade = !strikeFirst && r[0] + r[1] === 10;
      const doubleStrike = strikeFirst && r[1] === 10;
      if (strikeFirst && !doubleStrike) {
        setMessage(`${pinCount} pins. One more roll!`);
        setTimeout(startNewRoll, 900);
      } else if (doubleStrike) {
        game.rack = freshRack();
        setMessage('Another STRIKE! Final bonus roll — fresh rack.');
        setTimeout(startNewRoll, 900);
      } else if (spareMade) {
        game.rack = freshRack();
        setMessage('SPARE! Bonus roll — fresh rack.');
        setTimeout(startNewRoll, 900);
      } else {
        endGame();
      }
    } else {
      endGame();
    }
  }

  function advanceFrame() {
    game.frameIndex += 1;
    game.rollInFrame = 0;
    game.rack = freshRack();
    if (game.frameIndex >= 10) {
      endGame();
    } else {
      setTimeout(startNewRoll, 900);
    }
  }

  function endGame() {
    game.state = 'game-over';
    updateActionButton();
    renderScoreboard();
    const { cumulative } = computeFrameScores();
    const final = cumulative[9] != null ? cumulative[9] : cumulative.filter((c) => c != null).pop() || 0;
    setMessage(`Game over! Final score: ${final}. Press New Game to play again.`);
  }

  function newGame() {
    game.frames = freshFrames();
    game.frameIndex = 0;
    game.rollInFrame = 0;
    game.rack = freshRack();
    game.speedPower = 0;
    game.trail = [];
    game.prevTrail = [];
    game.ball = null;
    resetLane();
    el.lastRollStats.innerHTML = '';
    startNewRoll();
  }

  // ---------- Loop ----------
  function loop(now) {
    updateSpeedMeterUI(now);
    render();
    requestAnimationFrame(loop);
  }

  // ---------- Ball panel UI ----------
  const TOKEN_STORAGE_KEY = 'ballCreatorGithubToken';

  function catalogBallById(id) {
    return game.catalog.find((b) => b.id === id) || null;
  }

  // Shows the ball's image if it has one, otherwise the gray placeholder square.
  function setThumb(container, path) {
    const img = container.querySelector('img');
    if (path) {
      img.src = `${path}?v=${Date.now()}`; // cache-bust so a just-published image shows immediately
      img.hidden = false;
    } else {
      img.hidden = true;
      img.removeAttribute('src');
    }
  }

  // "Play With" is open to everyone: the 5 base coverstocks plus whatever's
  // been published to the shared catalog.
  function syncPlayBallSelect() {
    const prevValue = el.playBallSelect.value;
    el.playBallSelect.innerHTML = '';
    Object.entries(COVERSTOCKS).forEach(([key, cs]) => {
      const opt = document.createElement('option');
      opt.value = `preset:${key}`;
      opt.textContent = `${cs.label} (starter)`;
      el.playBallSelect.appendChild(opt);
    });
    game.catalog.forEach((ball) => {
      const opt = document.createElement('option');
      opt.value = `catalog:${ball.id}`;
      opt.textContent = `${ball.name} — $${ball.price}`;
      el.playBallSelect.appendChild(opt);
    });
    if ([...el.playBallSelect.options].some((o) => o.value === prevValue)) {
      el.playBallSelect.value = prevValue;
    }
    const [kind, id] = el.playBallSelect.value.split(':');
    setThumb(el.playBallThumb, kind === 'catalog' ? catalogBallById(id)?.image : null);
  }

  el.playBallSelect.addEventListener('change', (e) => {
    const [kind, id] = e.target.value.split(':');
    if (kind === 'preset') {
      game.loadout = presetLoadoutForCoverstock(id);
      setThumb(el.playBallThumb, null);
    } else {
      const ball = catalogBallById(id);
      if (ball) {
        game.loadout = loadoutFromBall(ball);
        setThumb(el.playBallThumb, ball.image);
      }
    }
  });

  // "Editing" (creator-only): a fresh draft, or an existing catalog ball to revise.
  function syncEditTargetSelect() {
    const prevValue = el.editTargetSelect.value;
    el.editTargetSelect.innerHTML = '';
    const newOpt = document.createElement('option');
    newOpt.value = 'new';
    newOpt.textContent = '+ New Ball';
    el.editTargetSelect.appendChild(newOpt);
    game.catalog.forEach((ball) => {
      const opt = document.createElement('option');
      opt.value = ball.id;
      opt.textContent = `${ball.name} — $${ball.price}`;
      el.editTargetSelect.appendChild(opt);
    });
    if ([...el.editTargetSelect.options].some((o) => o.value === prevValue)) {
      el.editTargetSelect.value = prevValue;
    }
  }

  function loadDraftFromTarget() {
    const target = el.editTargetSelect.value;
    game.pendingImageBase64 = null;
    el.ballImageInput.value = '';
    if (target === 'new') {
      game.editingBallId = null;
      game.draft = presetLoadoutForCoverstock('hybrid');
      el.ballNameInput.value = '';
      el.ballPriceInput.value = 0;
      setThumb(el.editBallThumb, null);
      el.deleteBallBtn.hidden = true;
    } else {
      const ball = catalogBallById(target);
      if (!ball) return;
      game.editingBallId = ball.id;
      game.draft = loadoutFromBall(ball);
      el.ballNameInput.value = ball.name;
      el.ballPriceInput.value = ball.price;
      setThumb(el.editBallThumb, ball.image);
      el.deleteBallBtn.hidden = false;
    }
    syncBallFormUI();
  }

  el.ballImageInput.addEventListener('change', () => {
    const file = el.ballImageInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      // dataURL looks like "data:image/png;base64,AAAA..." — keep just the base64 part
      game.pendingImageBase64 = reader.result.split(',')[1];
      const img = el.editBallThumb.querySelector('img');
      img.src = reader.result;
      img.hidden = false;
    };
    reader.readAsDataURL(file);
  });

  function syncBallFormUI() {
    const cs = COVERSTOCKS[game.draft.coverstock];
    el.coverstockSelect.value = game.draft.coverstock;
    el.weightSlider.value = game.draft.weight;
    el.weightValue.textContent = `${game.draft.weight} lb`;
    [
      ['length', el.lengthSlider, el.lengthValue, cs.lengthRange],
      ['hook', el.hookSlider, el.hookValue, cs.hookRange],
      ['backend', el.backendSlider, el.backendValue, cs.backendRange],
    ].forEach(([key, slider, label, range]) => {
      slider.min = range[0];
      slider.max = range[1];
      slider.value = game.draft[key];
      label.textContent = `${game.draft[key].toFixed(0)} (${range[0]}–${range[1]} for ${cs.label})`;
    });
  }

  el.editTargetSelect.addEventListener('change', loadDraftFromTarget);

  el.coverstockSelect.addEventListener('change', (e) => {
    game.draft.coverstock = e.target.value;
    clampLoadoutToCoverstock(game.draft);
    syncBallFormUI();
  });
  el.weightSlider.addEventListener('input', (e) => {
    game.draft.weight = Number(e.target.value);
    el.weightValue.textContent = `${game.draft.weight} lb`;
  });
  [['length', el.lengthSlider, el.lengthValue], ['hook', el.hookSlider, el.hookValue], ['backend', el.backendSlider, el.backendValue]]
    .forEach(([key, slider, label]) => {
      slider.addEventListener('input', (e) => {
        game.draft[key] = Number(e.target.value);
        const cs = COVERSTOCKS[game.draft.coverstock];
        const range = key === 'length' ? cs.lengthRange : key === 'hook' ? cs.hookRange : cs.backendRange;
        label.textContent = `${game.draft[key].toFixed(0)} (${range[0]}–${range[1]} for ${cs.label})`;
      });
    });

  // ---------- Gate + publishing ----------
  function syncGateUI() {
    el.ballGate.hidden = game.ballCreatorUnlocked;
    el.ballFields.hidden = !game.ballCreatorUnlocked;
    if (game.ballCreatorUnlocked) {
      syncEditTargetSelect();
      loadDraftFromTarget();
    }
  }

  function setGateStatus(msg, cls) {
    el.gateStatus.textContent = msg;
    el.gateStatus.className = 'ball-gate__status' + (cls ? ' ' + cls : '');
  }

  function setPublishStatus(msg, cls) {
    el.publishStatus.textContent = msg;
    el.publishStatus.className = 'ball-gate__status ball-field--wide' + (cls ? ' ' + cls : '');
  }

  async function attemptUnlock(token, { silent } = {}) {
    if (!silent) { el.gateVerifyBtn.disabled = true; setGateStatus('Checking with GitHub...', ''); }
    try {
      const { allowed, login } = await checkRepoWriteAccess(token);
      if (allowed) {
        game.ballCreatorUnlocked = true;
        game.githubToken = token;
        game.githubLogin = login;
        localStorage.setItem(TOKEN_STORAGE_KEY, token);
        setGateStatus(`Access granted — welcome, ${login}.`, 'ok');
        syncGateUI();
      } else {
        localStorage.removeItem(TOKEN_STORAGE_KEY);
        setGateStatus(silent ? 'Saved token no longer has write access — sign in again.' : `${login} doesn't have write access to this repo.`, 'err');
      }
    } catch (err) {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
      setGateStatus(err.message || 'Could not verify token.', 'err');
    } finally {
      el.gateVerifyBtn.disabled = false;
    }
  }

  el.gateVerifyBtn.addEventListener('click', () => {
    const token = el.gateTokenInput.value.trim();
    if (!token) { setGateStatus('Paste a token first.', 'err'); return; }
    el.gateTokenInput.value = '';
    attemptUnlock(token);
  });

  el.forgetTokenBtn.addEventListener('click', () => {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    game.ballCreatorUnlocked = false;
    game.githubToken = null;
    game.githubLogin = null;
    setGateStatus('Token forgotten.', '');
    syncGateUI();
  });

  el.publishBtn.addEventListener('click', async () => {
    const name = el.ballNameInput.value.trim();
    if (!name) { setPublishStatus('Give the ball a name first.', 'err'); return; }
    const price = Math.max(0, Number(el.ballPriceInput.value) || 0);
    const existing = game.editingBallId ? catalogBallById(game.editingBallId) : null;

    const ball = {
      id: game.editingBallId || `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now().toString(36)}`,
      name,
      price,
      ...game.draft,
      image: existing ? existing.image : null,
      createdBy: existing ? existing.createdBy : game.githubLogin,
      updatedAt: new Date().toISOString(),
    };

    el.publishBtn.disabled = true;
    try {
      if (game.pendingImageBase64) {
        setPublishStatus('Uploading image...', '');
        const imagePath = ballImagePath(ball.id);
        const sha = await getRepoFileSha(game.githubToken, imagePath);
        await putRepoFile(game.githubToken, imagePath, game.pendingImageBase64, `${sha ? 'Update' : 'Add'} image for "${name}" (${game.githubLogin})`, sha);
        ball.image = imagePath;
      }

      const nextCatalog = game.editingBallId
        ? game.catalog.map((b) => (b.id === ball.id ? ball : b))
        : [...game.catalog, ball];

      setPublishStatus('Publishing to the repo...', '');
      await publishBallsFile(
        game.githubToken,
        nextCatalog,
        `${game.editingBallId ? 'Update' : 'Add'} ball "${name}" via Ball Creator (${game.githubLogin})`
      );
      game.catalog = nextCatalog;
      game.editingBallId = ball.id;
      game.pendingImageBase64 = null;
      syncPlayBallSelect();
      syncEditTargetSelect();
      el.editTargetSelect.value = ball.id;
      el.deleteBallBtn.hidden = false;
      setThumb(el.editBallThumb, ball.image);
      setPublishStatus(`Published "${name}" to the repo.`, 'ok');
    } catch (err) {
      setPublishStatus(err.message || 'Publish failed.', 'err');
    } finally {
      el.publishBtn.disabled = false;
    }
  });

  el.deleteBallBtn.addEventListener('click', async () => {
    const ball = game.editingBallId ? catalogBallById(game.editingBallId) : null;
    if (!ball) return;
    if (!confirm(`Delete "${ball.name}" for everyone? This can't be undone from here.`)) return;

    el.deleteBallBtn.disabled = true;
    setPublishStatus('Deleting...', '');
    try {
      const nextCatalog = game.catalog.filter((b) => b.id !== ball.id);
      await publishBallsFile(game.githubToken, nextCatalog, `Delete ball "${ball.name}" via Ball Creator (${game.githubLogin})`);
      if (ball.image) {
        const sha = await getRepoFileSha(game.githubToken, ball.image).catch(() => null);
        if (sha) await deleteRepoFile(game.githubToken, ball.image, `Delete image for "${ball.name}" (${game.githubLogin})`, sha).catch(() => {});
      }
      game.catalog = nextCatalog;
      syncPlayBallSelect();
      syncEditTargetSelect();
      el.editTargetSelect.value = 'new';
      loadDraftFromTarget();
      setPublishStatus(`Deleted "${ball.name}".`, 'ok');
    } catch (err) {
      setPublishStatus(err.message || 'Delete failed.', 'err');
    } finally {
      el.deleteBallBtn.disabled = false;
    }
  });

  el.ballToggleBtn.addEventListener('click', () => {
    el.ballPanel.classList.toggle('open');
    if (el.ballPanel.classList.contains('open')) syncGateUI();
  });

  async function loadCatalog() {
    try {
      const res = await fetch('./data/balls.json', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      game.catalog = Array.isArray(data.balls) ? data.balls : [];
      syncPlayBallSelect();
      if (game.ballCreatorUnlocked) syncEditTargetSelect();
    } catch {
      // no catalog yet / offline — starter coverstocks still work fine
    }
  }

  // ---------- Setup sliders wiring ----------
  function syncSetupSlidersUI() {
    el.standingSlider.value = game.standingBoard;
    el.standingValue.textContent = game.standingBoard.toFixed(2);
    el.aimSlider.value = game.aimBoard;
    el.aimValue.textContent = game.aimBoard.toFixed(2);
    el.spinSlider.value = game.spinValue;
    el.spinValueEl.textContent = game.spinValue > 0 ? `+${game.spinValue}` : String(game.spinValue);
    el.difficultySelect.value = game.difficulty;
  }

  el.standingSlider.addEventListener('input', (e) => {
    game.standingBoard = Number(e.target.value);
    el.standingValue.textContent = game.standingBoard.toFixed(2);
  });
  el.aimSlider.addEventListener('input', (e) => {
    game.aimBoard = Number(e.target.value);
    el.aimValue.textContent = game.aimBoard.toFixed(2);
  });
  el.spinSlider.addEventListener('input', (e) => {
    game.spinValue = Number(e.target.value);
    el.spinValueEl.textContent = game.spinValue > 0 ? `+${game.spinValue}` : String(game.spinValue);
  });
  el.difficultySelect.addEventListener('change', (e) => {
    game.difficulty = e.target.value;
  });

  // ---------- Wiring ----------
  el.actionBtn.addEventListener('click', handleAction);
  el.balkBtn.addEventListener('click', handleBalk);
  el.newGameBtn.addEventListener('click', newGame);
  el.resetLaneBtn.addEventListener('click', () => {
    resetLane();
    setMessage('Lane reset — fresh pattern loaded.');
  });
  el.dynamicOilToggle.addEventListener('change', (e) => {
    game.dynamicOil = e.target.checked;
  });
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      e.preventDefault();
      if (game.state === 'setup' || game.state.startsWith('aim-')) handleAction();
    }
  });

  // ---------- Drag-to-peek camera (lane view only shows just past the
  // arrows by default; drag up on it to look further toward the pins) ----------
  const CAM_DRAG_SPAN_FT = CAMERA_AIM.maxFt - CAMERA_AIM.minFt;
  const CAM_DRAG_MAX_OFFSET_FT = Math.max(0, LANE_TOTAL_FT - CAMERA_AIM.maxFt);
  let camDragStartY = 0;
  canvas.addEventListener('pointerdown', (e) => {
    if (!(game.state === 'setup' || game.state.startsWith('aim-'))) return;
    game.camDragActive = true;
    game.camDragOffsetFt = 0;
    camDragStartY = e.clientY;
    canvas.classList.add('dragging');
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!game.camDragActive) return;
    const rect = canvas.getBoundingClientRect();
    const deltaFt = ((camDragStartY - e.clientY) / rect.height) * CAM_DRAG_SPAN_FT;
    game.camDragOffsetFt = clamp(deltaFt, 0, CAM_DRAG_MAX_OFFSET_FT);
  });
  const endCamDrag = () => {
    game.camDragActive = false;
    canvas.classList.remove('dragging');
  };
  canvas.addEventListener('pointerup', endCamDrag);
  canvas.addEventListener('pointercancel', endCamDrag);

  syncSetupSlidersUI();
  syncPlayBallSelect();
  syncGateUI();
  loadCatalog();
  const savedToken = localStorage.getItem(TOKEN_STORAGE_KEY);
  if (savedToken) attemptUnlock(savedToken, { silent: true });

  startNewRoll();
  requestAnimationFrame(loop);
})();
