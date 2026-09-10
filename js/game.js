(() => {
  'use strict';

  // ---------- Canvas / lane geometry ----------
  const canvas = document.getElementById('lane-canvas');
  const ctx = canvas.getContext('2d');
  const CANVAS_W = canvas.width;
  const CANVAS_H = canvas.height;

  const LANE_MARGIN = 54;
  const LANE_LEFT = LANE_MARGIN;
  const LANE_RIGHT = CANVAS_W - LANE_MARGIN;
  const LANE_W = LANE_RIGHT - LANE_LEFT;
  const FOUL_Y = CANVAS_H - 50;
  const DECK_Y = 70;
  const LANE_SPAN = FOUL_Y - DECK_Y;

  const toX = (nx) => LANE_LEFT + nx * LANE_W;
  const toY = (s) => FOUL_Y - s * LANE_SPAN;

  // ---------- Pin layout (top-down, normalized) ----------
  // nx: 0..1 across lane width, s: 0 (foul line) .. 1 (deep pin deck)
  const PIN_DEFS = [
    { id: 1, nx: 0.500, s: 0.850 },
    { id: 2, nx: 0.455, s: 0.890 },
    { id: 3, nx: 0.545, s: 0.890 },
    { id: 4, nx: 0.410, s: 0.930 },
    { id: 5, nx: 0.500, s: 0.930 },
    { id: 6, nx: 0.590, s: 0.930 },
    { id: 7, nx: 0.365, s: 0.970 },
    { id: 8, nx: 0.455, s: 0.970 },
    { id: 9, nx: 0.545, s: 0.970 },
    { id: 10, nx: 0.635, s: 0.970 },
  ];
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

  // ---------- Oil pattern (real Kegel pattern data) ----------
  // "2022 Starting House Pattern" — exact rows from the pattern's FORWARD/REVERSE
  // LOADS DATA tables: [board (L/R mirrored, 1=gutter..20=center), loads, t_oil (uL), distA, distB]
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

  const BOARD_COUNT = 39; // real mirrored numbering: 1 (gutter) .. 20 (center) .. 1 (gutter)
  const DIST_FT = 44; // 0..43 ft, 1ft buckets
  const LANE_FEET = 62; // approx real feet from foul line to the pin deck, for s <-> feet mapping

  // Placeholder "medium/hybrid" coverstock oil-transition rates, per roll.
  // Real values will come from the ball creator once it exists.
  const OIL_ABSORPTION_RATE = 0.05; // fraction of oil under the ball's path removed per pass
  const OIL_CARRYDOWN_RATE = 0.35; // fraction of absorbed oil redeposited further down the lane
  const CARRYDOWN_SPREAD_FT = 4; // how many feet ahead carrydown gets smeared into

  function boxBlur1D(arr, radius) {
    const n = arr.length;
    const out = new Float64Array(n);
    let sum = 0;
    for (let i = 0; i < Math.min(radius, n); i++) sum += arr[i];
    for (let i = 0; i < n; i++) {
      const add = i + radius < n ? arr[i + radius] : 0;
      const sub = i - radius - 1 >= 0 ? arr[i - radius - 1] : 0;
      if (i > 0) sum += add - sub;
      let count = Math.min(i + radius, n - 1) - Math.max(i - radius, 0) + 1;
      out[i] = sum / count;
    }
    return out;
  }

  function blurGrid(grid, boardRadius, distRadius, iterations) {
    let g = grid;
    for (let it = 0; it < iterations; it++) {
      // blur along board axis (rows)
      g = g.map((row) => Array.from(boxBlur1D(row, boardRadius)));
      // blur along distance axis (columns)
      const cols = g[0].length;
      const transposed = Array.from({ length: cols }, (_, c) => g.map((row) => row[c]));
      const blurredCols = transposed.map((col) => Array.from(boxBlur1D(col, distRadius)));
      g = Array.from({ length: g.length }, (_, r) => blurredCols.map((col) => col[r]));
    }
    return g;
  }

  function buildOilGrid() {
    // grid[distFt][boardIdx], boardIdx 0..38 => board 1..39
    const grid = Array.from({ length: DIST_FT }, () => new Array(BOARD_COUNT).fill(0));

    function applyPass(rows) {
      rows.forEach(([board, loads, tOil, dA, dB]) => {
        if (tOil <= 0) return;
        const lo = board; // left board (1-indexed)
        const hi = BOARD_COUNT + 1 - board; // right board (mirrored)
        const width = hi - lo + 1;
        const density = tOil / width;
        const d0 = Math.min(dA, dB);
        const d1 = Math.max(dA, dB) === d0 ? d0 + 1 : Math.max(dA, dB);
        for (let f = Math.floor(d0); f < Math.ceil(d1) && f < DIST_FT; f++) {
          if (f < 0) continue;
          for (let b = lo; b <= hi; b++) {
            grid[f][b - 1] += density;
          }
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

  function boardToNx(board1to39) {
    return (board1to39 - 0.5) / BOARD_COUNT;
  }
  function nxToBoard(nx) {
    return Math.min(BOARD_COUNT, Math.max(1, Math.round(nx * BOARD_COUNT + 0.5)));
  }
  function sToFeet(s) {
    return s * LANE_FEET;
  }

  // ---------- Meters ----------
  const METERS = {
    power: { period: 900 },
    accuracy: { period: 1100 },
    spin: { period: 1300 },
  };

  function pingpong(elapsedMs, periodMs) {
    const t = (elapsedMs % periodMs) / periodMs;
    return t < 0.5 ? t * 2 : 2 - t * 2;
  }

  // ---------- Game state ----------
  function freshRack() {
    const rack = {};
    PIN_DEFS.forEach((p) => { rack[p.id] = true; });
    return rack;
  }

  function freshFrames() {
    return Array.from({ length: 10 }, () => ({ rolls: [] }));
  }

  const game = {
    frames: freshFrames(),
    frameIndex: 0,
    rollInFrame: 0, // 0-based within current frame
    rack: freshRack(),
    state: 'aim-power', // aim-power | aim-accuracy | aim-spin | rolling | game-over
    stageStart: performance.now(),
    locked: { power: 0, accuracy: 0, spin: 0 },
    ball: null, // { nx, s } while rolling
    trail: [],
    prevTrail: [],
    lastStats: null,
    oil: buildOilGrid(),
    oilMax: 0,
    dynamicOil: true,
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
    meterBlocks: {
      power: document.getElementById('meter-power'),
      accuracy: document.getElementById('meter-accuracy'),
      spin: document.getElementById('meter-spin'),
    },
    fills: {
      power: document.getElementById('fill-power'),
      accuracy: document.getElementById('fill-accuracy'),
      spin: document.getElementById('fill-spin'),
    },
    cursors: {
      power: document.getElementById('cursor-power'),
      accuracy: document.getElementById('cursor-accuracy'),
      spin: document.getElementById('cursor-spin'),
    },
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
    const { frameScores, cumulative } = computeFrameScores();
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
  function pathNX(params, s) {
    return 0.5 + params.angleOffset * s + params.curveAmount * s * s;
  }

  function computeShot(power, accuracy, spin, rack) {
    const accDev = (accuracy - 0.5) * 2; // -1..1
    const spinDev = (spin - 0.5) * 2; // -1..1
    const angleOffset = accDev * 0.32;
    const powerFactor = 1.5 - power * 0.9;
    const curveAmount = spinDev * 0.55 * powerFactor;
    const params = { angleOffset, curveAmount };

    // walk the path to find gutter point (if any)
    let finalS = 1.0;
    let guttered = false;
    const STEPS = 200;
    for (let i = 0; i <= STEPS; i++) {
      const s = i / STEPS;
      const nx = pathNX(params, s);
      if (nx < 0.01 || nx > 0.99) {
        finalS = s;
        guttered = true;
        break;
      }
    }

    const knocked = [];
    if (!guttered) {
      const knockRadius = KNOCK_RADIUS_BASE * (0.8 + power * 0.6);
      PIN_DEFS.forEach((p) => {
        if (!rack[p.id]) return;
        const bx = pathNX(params, p.s);
        if (Math.abs(bx - p.nx) < knockRadius + PIN_RADIUS_NX) {
          knocked.push(p.id);
        }
      });

      // chain reaction across adjacency
      let frontier = knocked.slice();
      for (let pass = 0; pass < 3 && frontier.length; pass++) {
        const next = [];
        frontier.forEach((id) => {
          (ADJACENCY[id] || []).forEach((nid) => {
            if (rack[nid] && !knocked.includes(nid)) {
              const chance = 0.32 + power * 0.4;
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

    return { params, finalS, guttered, knocked };
  }

  // ---------- Rendering ----------
  function drawLane() {
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

    // gutters
    ctx.fillStyle = '#10141a';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    // lane surface
    const grad = ctx.createLinearGradient(0, DECK_Y, 0, FOUL_Y);
    grad.addColorStop(0, '#4a3018');
    grad.addColorStop(1, '#3a2618');
    ctx.fillStyle = grad;
    ctx.fillRect(LANE_LEFT, DECK_Y - 20, LANE_W, FOUL_Y - DECK_Y + 20);

    // wood grain lines
    ctx.strokeStyle = 'rgba(85,56,31,0.5)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 10; i++) {
      const x = LANE_LEFT + (LANE_W / 10) * i;
      ctx.beginPath();
      ctx.moveTo(x, DECK_Y - 20);
      ctx.lineTo(x, FOUL_Y);
      ctx.stroke();
    }

    // lane edges
    ctx.strokeStyle = '#6b4a2a';
    ctx.lineWidth = 2;
    ctx.strokeRect(LANE_LEFT, DECK_Y - 20, LANE_W, FOUL_Y - DECK_Y + 20);

    // foul line
    ctx.strokeStyle = '#ff5c5c';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(LANE_LEFT, FOUL_Y);
    ctx.lineTo(LANE_RIGHT, FOUL_Y);
    ctx.stroke();

    // aiming arrows (decorative top-down guide marks)
    ctx.fillStyle = 'rgba(244,241,232,0.35)';
    [0.30, 0.42].forEach((s) => {
      [0.35, 0.45, 0.5, 0.55, 0.65].forEach((nx) => {
        const x = toX(nx);
        const y = toY(s);
        ctx.beginPath();
        ctx.moveTo(x, y - 6);
        ctx.lineTo(x - 4, y + 5);
        ctx.lineTo(x + 4, y + 5);
        ctx.closePath();
        ctx.fill();
      });
    });

    // foul-line dots
    ctx.fillStyle = 'rgba(244,241,232,0.4)';
    for (let nx = 0.1; nx <= 0.9; nx += 0.1) {
      ctx.beginPath();
      ctx.arc(toX(nx), FOUL_Y - 10, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawOil() {
    const grid = game.oil;
    const max = game.oilMax;
    const cellW = LANE_W / BOARD_COUNT;
    const cellH = LANE_SPAN * (1 / LANE_FEET); // px per foot
    for (let f = 0; f < DIST_FT; f++) {
      const s0 = f / LANE_FEET;
      const y = toY(s0);
      const row = grid[f];
      for (let b = 0; b < BOARD_COUNT; b++) {
        const v = row[b];
        if (v <= 0) continue;
        const alpha = Math.min(0.85, (v / max) * 0.85);
        if (alpha < 0.02) continue;
        const x = LANE_LEFT + b * cellW;
        ctx.fillStyle = `rgba(255, 175, 60, ${alpha})`;
        ctx.fillRect(x, y - cellH - 0.5, cellW + 0.5, cellH + 0.5);
      }
    }
  }

  function drawTrail(trail, alpha) {
    if (trail.length < 2) return;
    ctx.strokeStyle = `rgba(255, 210, 60, ${alpha})`;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    trail.forEach((pt, i) => {
      const x = toX(pt.nx);
      const y = toY(pt.s);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  function drawPins() {
    PIN_DEFS.forEach((p) => {
      const standing = game.rack[p.id];
      const x = toX(p.nx);
      const y = toY(p.s);
      const r = PIN_RADIUS_NX * LANE_W;
      ctx.save();
      ctx.translate(x, y);
      if (!standing) {
        ctx.globalAlpha = 0.55;
        ctx.rotate(0.5);
      }
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fillStyle = standing ? '#f4f1e8' : '#4a4f58';
      ctx.fill();
      ctx.strokeStyle = standing ? '#c9c3ac' : '#33373f';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      if (standing) {
        ctx.beginPath();
        ctx.arc(0, 0, r * 0.4, 0, Math.PI * 2);
        ctx.strokeStyle = '#d6413c';
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
      ctx.restore();
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.font = '9px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(String(p.id), x, y + r + 10);
    });
  }

  function drawBall() {
    let nx = 0.5, s = 0;
    if (game.ball) {
      nx = game.ball.nx;
      s = game.ball.s;
    }
    const x = toX(nx);
    const y = toY(s);
    ctx.beginPath();
    ctx.arc(x, y, 9, 0, Math.PI * 2);
    const grad = ctx.createRadialGradient(x - 3, y - 3, 1, x, y, 9);
    grad.addColorStop(0, '#5aa7ff');
    grad.addColorStop(1, '#1a3a6b');
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = '#0c1f3d';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  function render() {
    drawLane();
    drawOil();
    drawTrail(game.prevTrail, 0.18);
    drawTrail(game.trail, 0.85);
    drawPins();
    if (game.state === 'rolling' || game.ball) drawBall();
  }

  // ---------- Meter UI ----------
  function updateMeterUI(now) {
    ['power', 'accuracy', 'spin'].forEach((key) => {
      const block = el.meterBlocks[key];
      const isActive = game.state === `aim-${key}`;
      const isDone = (key === 'power' && ['aim-accuracy', 'aim-spin', 'rolling'].includes(game.state)) ||
        (key === 'accuracy' && ['aim-spin', 'rolling'].includes(game.state)) ||
        (key === 'spin' && game.state === 'rolling');
      block.classList.toggle('active', isActive);
      block.classList.toggle('done', isDone && !isActive);

      let value;
      if (isActive) {
        value = pingpong(now - game.stageStart, METERS[key].period);
      } else if (isDone || game.locked[key] !== undefined && game.state === 'game-over') {
        value = game.locked[key];
      } else if (game.state === 'aim-power' && key !== 'power') {
        value = 0;
      } else {
        value = game.locked[key] || 0;
      }
      const pct = (value * 100).toFixed(1);
      el.fills[key].style.width = pct + '%';
      el.cursors[key].style.left = `calc(${pct}% - 2px)`;
    });
  }

  // ---------- Flow control ----------
  function setMessage(msg) {
    el.message.textContent = msg;
  }

  function labelForState() {
    switch (game.state) {
      case 'aim-power': return 'LOCK POWER';
      case 'aim-accuracy': return 'LOCK ACCURACY';
      case 'aim-spin': return 'LOCK SPIN & ROLL';
      case 'rolling': return 'ROLLING...';
      case 'game-over': return 'GAME OVER';
      default: return 'GO';
    }
  }

  function updateActionButton() {
    el.actionBtn.textContent = labelForState();
    el.actionBtn.disabled = game.state === 'rolling' || game.state === 'game-over';
  }

  function beginAimStage(stage) {
    game.state = `aim-${stage}`;
    game.stageStart = performance.now();
    updateActionButton();
    const label = stage.charAt(0).toUpperCase() + stage.slice(1);
    setMessage(`Set your ${label.toUpperCase()} — click/tap or press SPACE to lock it in`);
  }

  function startNewRoll() {
    game.trail = [];
    game.ball = { nx: 0.5, s: 0 };
    beginAimStage('power');
    renderScoreboard();
  }

  function handleAction() {
    if (game.state === 'aim-power') {
      game.locked.power = pingpong(performance.now() - game.stageStart, METERS.power.period);
      beginAimStage('accuracy');
    } else if (game.state === 'aim-accuracy') {
      game.locked.accuracy = pingpong(performance.now() - game.stageStart, METERS.accuracy.period);
      beginAimStage('spin');
    } else if (game.state === 'aim-spin') {
      game.locked.spin = pingpong(performance.now() - game.stageStart, METERS.spin.period);
      launchBall();
    }
  }

  function launchBall() {
    game.state = 'rolling';
    updateActionButton();
    setMessage('Rolling...');

    const { power, accuracy, spin } = game.locked;
    const shot = computeShot(power, accuracy, spin, game.rack);

    const durationMs = 1500 - power * 550;
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

  function applyOilTransition(shot) {
    if (!game.dynamicOil) return;
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
      const removed = current * OIL_ABSORPTION_RATE;
      grid[f][b] = current - removed;

      // carrydown: smear a portion of the removed oil into the next few feet down-lane
      const deposit = removed * OIL_CARRYDOWN_RATE / CARRYDOWN_SPREAD_FT;
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

  function finishRoll(shot) {
    const before = Object.keys(game.rack).filter((id) => game.rack[id]).length;
    shot.knocked.forEach((id) => { game.rack[id] = false; });
    const after = Object.keys(game.rack).filter((id) => game.rack[id]).length;
    const pinsThisRoll = before - after;

    game.prevTrail = game.trail;
    game.ball = null;
    applyOilTransition(shot);

    const powerPct = Math.round(shot.params ? game.locked.power * 100 : 0);
    const accDesc = describeAccuracy(game.locked.accuracy);
    const spinDesc = describeSpin(game.locked.spin, game.locked.power);
    el.lastRollStats.innerHTML = `
      <span>Power: <b>${powerPct}%</b></span>
      <span>Aim: <b>${accDesc}</b></span>
      <span>Spin: <b>${spinDesc}</b></span>
      <span>Pins: <b>${pinsThisRoll}</b></span>
      ${shot.guttered ? '<span style="color:#ff5c5c"><b>GUTTER</b></span>' : ''}
    `;

    recordRoll(pinsThisRoll);
  }

  function describeAccuracy(v) {
    const dev = (v - 0.5) * 2;
    if (Math.abs(dev) < 0.08) return 'Dead Center';
    return (dev < 0 ? 'Left ' : 'Right ') + Math.round(Math.abs(dev) * 100) + '%';
  }
  function describeSpin(v, power) {
    const dev = (v - 0.5) * 2;
    if (Math.abs(dev) < 0.08) return 'Straight';
    const dir = dev < 0 ? 'Hook Left' : 'Hook Right';
    const strength = Math.abs(dev) * (1.5 - power * 0.9);
    return `${dir} (${strength > 0.6 ? 'Heavy' : strength > 0.3 ? 'Medium' : 'Light'})`;
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
        // rack continues standing remainder for the bonus roll
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
    game.locked = { power: 0, accuracy: 0, spin: 0 };
    game.trail = [];
    game.prevTrail = [];
    game.ball = null;
    resetLane();
    el.lastRollStats.innerHTML = '';
    startNewRoll();
  }

  // ---------- Loop ----------
  function loop(now) {
    updateMeterUI(now);
    render();
    requestAnimationFrame(loop);
  }

  // ---------- Wiring ----------
  el.actionBtn.addEventListener('click', handleAction);
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
      if (game.state.startsWith('aim-')) handleAction();
    }
  });

  startNewRoll();
  requestAnimationFrame(loop);
})();
