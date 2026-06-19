/*
 * fireflies — a tiny night simulation
 * -----------------------------------
 * Everything is drawn into one low-resolution canvas which the browser
 * upscales with nearest-neighbour (CSS image-rendering: pixelated), giving
 * a crisp pixel-art look for almost no cost — ideal for phones.
 *
 * Two algorithms drive the life on screen:
 *
 *  1. FLIGHT  — Reynolds-style steering. A wandering heading (gaussian random
 *     walk + rare darts), variable speed with hover/pause states, and a *weak*
 *     touch of flocking (separation strongest; alignment & cohesion tiny) so
 *     they mostly do their own thing but loosely gather.
 *
 *  2. BLINKING — pulse-coupled oscillators (Mirollo–Strogatz). Each firefly
 *     carries a phase that fires & resets; seeing a neighbour flash nudges its
 *     own phase forward (distance-weighted, with a refractory window). On top
 *     of that, periods slowly ease toward the local average (frequency
 *     entrainment). Together they make the swarm drift into synchrony.
 */
(function () {
  'use strict';

  var TAU = Math.PI * 2;
  var reduceMotion = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------------------------------------------------------------- helpers
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function rand(a, b) { return a + Math.random() * (b - a); }

  // small seeded PRNG so each plant regrows identically every frame
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  // gaussian noise (Box–Muller, cached spare)
  var spare = null;
  function randn() {
    if (spare !== null) { var s = spare; spare = null; return s; }
    var u = Math.random() || 1e-9, v = Math.random();
    var r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(TAU * v);
    return r * Math.cos(TAU * v);
  }

  // -------------------------------------------------------------- config
  // All spatial values are in *internal* (low-res) pixels, time in seconds.
  var CFG = {
    maxFlies: 300,

    // --- flight ---
    speedMax:     24,
    speedBaseMin: 3,
    speedBaseMax: 18,
    turnNoise:    3.2,    // rad/s heading random-walk
    dartChance:   0.022,  // per-frame chance of a sharp turn
    tremor:       0,     // jittery shake — random acceleration each frame
    shakeAmp:     0.1,    // visual per-frame tremble (internal px)
    steerGain:    3.0,
    edgeMargin:   12,
    edgeForce:    46,
    skyPull:      7,      // gentle bias to stay below the upper sky
    hoverChance:  0.006,
    hoverMin:     0.5,
    hoverMax:     2.0,
    headingMin:   1.5,    // min speed before we re-orient the sprite
    bobAmp:       1.0,
    bobFreq:      2.6,
    flapRate:     14,     // wing-beat Hz

    // --- weak flocking ---
    flockR: 32, sepR: 10,
    wSep: 8.0, wAli: 0.5, wCoh: 0.45,

    // --- blinking / synchrony ---
    periodMin:  1.8,
    periodMax:  3.4,
    blinkR:     86,       // how far a flash is "seen"
    phaseBump:  0.08,     // pulse-coupling strength
    maxBump:    0.30,     // cap on per-frame phase advance from neighbours
    freqAdapt:  0.30,     // how fast periods ease toward local average
    refractory: 0.22,     // ignore input for a moment after own flash
    flashAttack: 0.06,    // glow envelope: quick rise ...
    flashHold:   0.16,    // ... brief plateau at full ...
    flashTau:    0.30,    // ... then a slow fade (longer glow, not a blink)
    idleGlow:    0.03,    // faint lantern glow between flashes
    glitchChance: 0.05,   // per cycle: chance a firefly misfires — skips a flash
                          // or lingers & falls off-beat, nudging the swarm's rhythm

    // --- background ---
    windSpeed: reduceMotion ? 0.15 : 0.40,
    twinkle:   reduceMotion ? 0.10 : 0.35
  };

  // -------------------------------------------------------------- canvas
  var canvas = document.getElementById('scene');
  var ctx = canvas.getContext('2d');
  var PIXEL = 3, Wi = 0, Hi = 0;

  // pre-rendered assets (rebuilt on resize)
  var sprites = null;          // [wingFrame] -> lit (coloured) body canvas
  var spritesDark = null;      // [wingFrame] -> near-black silhouette
  var SP = { S: 16, lanX: 0, lanY: 0 };
  var glowWarm = null, glowCore = null;
  var skyTex = null, vignetteTex = null;
  var stars = [], veg = { back: [], mid: [], front: [] };

  // ------------------------------------------------ firefly sprite (vector)
  // Drawn small and smooth; the final CSS upscale turns it into pixel art.
  // Points toward +x (angle 0); we rotate it to the heading at draw time.
  function drawFireflyBody(g, S, wing) {
    var cx = S / 2, cy = S / 2;
    var L = S * 0.30;            // half body length
    var thin = Math.max(0.6, S * 0.045);

    g.save();
    g.translate(cx, cy);
    g.lineCap = 'round';

    // --- membranous wings (behind body), two beat poses ---
    var spread = wing ? 1.0 : 0.62;
    g.fillStyle = 'rgba(205,220,235,0.16)';
    ellipse(g, -L * 0.05, -(S * 0.17 * spread + S * 0.03), S * 0.32, S * 0.15 * spread, -0.5); g.fill();
    ellipse(g, -L * 0.05,  (S * 0.17 * spread + S * 0.03), S * 0.32, S * 0.15 * spread,  0.5); g.fill();

    // --- legs ---
    g.strokeStyle = 'rgba(18,18,12,0.9)';
    g.lineWidth = thin;
    for (var i = -1; i <= 1; i++) {
      var bx = L * (0.15 + i * 0.22);
      g.beginPath();
      g.moveTo(bx, S * 0.07);
      g.lineTo(bx - S * 0.04, S * 0.22);
      g.stroke();
      g.beginPath();
      g.moveTo(bx, -S * 0.07);
      g.lineTo(bx - S * 0.04, -S * 0.22);
      g.stroke();
    }

    // --- abdomen (elytra / wing cases) ---
    g.fillStyle = '#26271a';
    ellipse(g, -L * 0.18, 0, L * 0.92, S * 0.18, 0); g.fill();
    // central seam
    g.strokeStyle = 'rgba(10,10,6,0.8)';
    g.lineWidth = thin * 0.8;
    g.beginPath(); g.moveTo(-L * 1.05, 0); g.lineTo(L * 0.3, 0); g.stroke();
    // faint sheen
    g.strokeStyle = 'rgba(120,130,90,0.25)';
    g.beginPath(); g.moveTo(-L * 0.9, -S * 0.07); g.lineTo(L * 0.1, -S * 0.07); g.stroke();

    // --- lantern (rear underside, glow origin) ---
    g.fillStyle = '#cdd98a';
    ellipse(g, -L * 0.55, S * 0.05, S * 0.16, S * 0.11, 0); g.fill();

    // --- pronotum (the little shield), warm reddish ---
    g.fillStyle = '#50403a';
    ellipse(g, L * 0.5, 0, S * 0.14, S * 0.15, 0); g.fill();
    g.fillStyle = 'rgba(40,20,10,0.9)';
    ellipse(g, L * 0.5, 0, S * 0.05, S * 0.07, 0); g.fill();

    // --- head + antennae ---
    g.fillStyle = '#14140d';
    ellipse(g, L * 0.82, 0, S * 0.09, S * 0.09, 0); g.fill();
    g.strokeStyle = 'rgba(20,20,14,0.9)';
    g.lineWidth = thin * 0.8;
    g.beginPath(); g.moveTo(L * 0.85, -S * 0.04); g.lineTo(L * 1.2, -S * 0.16); g.stroke();
    g.beginPath(); g.moveTo(L * 0.85,  S * 0.04); g.lineTo(L * 1.2,  S * 0.16); g.stroke();

    g.restore();
  }

  function ellipse(g, x, y, rx, ry, rot) {
    g.beginPath();
    g.ellipse(x, y, Math.max(0.1, rx), Math.max(0.1, ry), rot || 0, 0, TAU);
  }

  function buildSprites() {
    var bodyPx = clamp(Math.round(20 / PIXEL), 5, 12);
    var S = bodyPx + 8;
    SP.S = S;
    SP.scale = 0.6;                  // overall on-screen size of the firefly
    SP.lanX = -(S * 0.30) * 0.55;   // matches lantern position above
    SP.lanY = S * 0.05;
    sprites = [];
    spritesDark = [];
    for (var w = 0; w < 2; w++) {
      var c = document.createElement('canvas');
      c.width = S; c.height = S;
      drawFireflyBody(c.getContext('2d'), S, w);
      sprites.push(c);

      // near-black silhouette: same shape, almost no colour (used when unlit)
      var d = document.createElement('canvas');
      d.width = S; d.height = S;
      var dg = d.getContext('2d');
      dg.drawImage(c, 0, 0);
      dg.globalCompositeOperation = 'source-atop';
      dg.fillStyle = 'rgba(2,4,3,0.93)';
      dg.fillRect(0, 0, S, S);
      spritesDark.push(d);
    }
  }

  // --------------------------------------------------------------- glow
  function makeGlow(stops) {
    var s = 64;
    var c = document.createElement('canvas');
    c.width = c.height = s;
    var g = c.getContext('2d');
    var grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    for (var i = 0; i < stops.length; i++) grd.addColorStop(stops[i][0], stops[i][1]);
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
    return c;
  }

  function buildGlow() {
    // wide, soft pool of light that spills onto nearby plants
    glowWarm = makeGlow([
      [0.0, 'rgb(255, 237, 118)'],
      [0.25, 'rgba(148,234,92,0.5)'],
      [0.55, 'rgba(118,204,68,0.14)'],
      [1.0, 'rgba(108,188,58,0)']
    ]);
    // the lantern itself — tight and bright
    glowCore = makeGlow([
      [0.0, 'rgba(248,255,226,1)'],
      [0.35, 'rgba(224,255,178,0.55)'],
      [1.0, 'rgba(204,255,158,0)']
    ]);
  }

  // ----------------------------------------------------------- background
  function buildBackground() {
    // --- static sky (gradient + faint moon) baked once ---
    skyTex = document.createElement('canvas');
    skyTex.width = Wi; skyTex.height = Hi;
    var g = skyTex.getContext('2d');
    var sky = g.createLinearGradient(0, 0, 0, Hi);
    sky.addColorStop(0.0, '#05070f');
    sky.addColorStop(0.45, '#0a1422');
    sky.addColorStop(0.78, '#0d2230');
    sky.addColorStop(1.0, '#0f2a2c');
    g.fillStyle = sky;
    g.fillRect(0, 0, Wi, Hi);
    drawMoon(g);

    // --- stars ---
    stars = [];
    var n = Math.round(Wi * Hi / 1150);
    for (var i = 0; i < n; i++) {
      stars.push({
        x: Math.random() * Wi,
        y: Math.random() * Hi * 0.62,
        b: rand(0.25, 1),
        tw: Math.random() * TAU,
        tf: rand(0.4, 1.6),
        big: Math.random() < 0.06
      });
    }

    // --- vegetation: filled silhouette mass + swaying blades per layer ---
    veg.back = makeVegLayer(Hi * 0.82, '#0c2018', 0.7, 38);
    veg.mid = makeVegLayer(Hi * 0.92, '#091811', 1.0, 33);
    veg.front = makeVegLayer(Hi * 1.05, '#050d08', 1.5, 29);

    // --- vignette ---
    vignetteTex = document.createElement('canvas');
    vignetteTex.width = Wi; vignetteTex.height = Hi;
    var vg = vignetteTex.getContext('2d');
    var vr = vg.createRadialGradient(Wi / 2, Hi * 0.45, Math.min(Wi, Hi) * 0.25,
                                     Wi / 2, Hi * 0.5, Math.max(Wi, Hi) * 0.75);
    vr.addColorStop(0, 'rgba(0,0,0,0)');
    vr.addColorStop(1, 'rgba(0,0,8,0.55)');
    vg.fillStyle = vr;
    vg.fillRect(0, 0, Wi, Hi);
  }

  function drawMoon(g) {
    var mx = Wi * 0.82, my = Hi * 0.15, mr = Math.max(5, Wi * 0.024);
    // soft halo
    var halo = g.createRadialGradient(mx, my, mr * 0.6, mx, my, mr * 6);
    halo.addColorStop(0, 'rgba(180,200,175,0.10)');
    halo.addColorStop(0.5, 'rgba(150,180,165,0.035)');
    halo.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = halo;
    g.fillRect(0, 0, Wi, Hi);
    // disc — lit from the upper-left, feathered edge
    var disc = g.createRadialGradient(mx - mr * 0.35, my - mr * 0.35, mr * 0.15, mx, my, mr);
    disc.addColorStop(0.0, 'rgba(238,242,226,0.95)');
    disc.addColorStop(0.55, 'rgba(206,214,190,0.9)');
    disc.addColorStop(0.85, 'rgba(168,180,156,0.55)');
    disc.addColorStop(1.0, 'rgba(150,162,140,0)');
    g.fillStyle = disc;
    ellipse(g, mx, my, mr, mr, 0); g.fill();
    // faint maria (darker patches) for a bit of character
    g.fillStyle = 'rgba(120,135,120,0.16)';
    ellipse(g, mx - mr * 0.26, my + mr * 0.12, mr * 0.28, mr * 0.22, 0.4); g.fill();
    ellipse(g, mx + mr * 0.30, my - mr * 0.20, mr * 0.18, mr * 0.15, 0); g.fill();
    ellipse(g, mx + mr * 0.04, my + mr * 0.36, mr * 0.13, mr * 0.11, 0); g.fill();
  }

  // --- vegetation: procedural L-system-ish plants, swaying in the wind ---
  // kinds: 0 fern frond · 1 bushy weed · 2 broad-leaf herb · 3 grass/reed clump
  function makeVegLayer(baseY, color, swayMul, spacing) {
    var plants = [];
    for (var x = -spacing * 0.5; x < Wi + spacing * 0.5; x += rand(spacing * 0.42, spacing)) {
      var r = Math.random();
      var kind = r < 0.30 ? 0 : r < 0.54 ? 1 : r < 0.78 ? 2 : 3;
      plants.push({
        x: x,
        base: baseY + rand(-Hi * 0.015, Hi * 0.03),
        h: rand(Hi * 0.12, Hi * 0.32),
        seed: (Math.random() * 1e9) | 0,
        phase: Math.random() * TAU,
        sway: rand(0.6, 1.1) * swayMul,
        kind: kind,
        // leaf silhouette: 0 oval · 1 lance (pointed) · 2 round · 3 teardrop
        leaf: kind === 2 ? (Math.random() < 0.5 ? 2 : 3)
            : kind === 3 ? 1
            : (Math.random() < 0.5 ? 0 : 1),
        curl: rand(-1, 1)                       // gentle lean / arch direction
      });
    }
    return { color: color, baseY: baseY, gphase: Math.random() * TAU, plants: plants };
  }

  // gentle rolling ground silhouette so there's no hard horizon line
  function fillGround(layer) {
    var amp = Hi * 0.018;
    ctx.fillStyle = layer.color;
    ctx.beginPath();
    ctx.moveTo(0, Hi + 2);
    ctx.lineTo(0, layer.baseY);
    for (var x = 0; x <= Wi; x += 6) {
      var y = layer.baseY + Math.sin(x * 0.018 + layer.gphase) * amp
                          + Math.sin(x * 0.05 + layer.gphase * 2) * amp * 0.4;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(Wi, Hi + 2);
    ctx.closePath();
    ctx.fill();
  }

  function drawVeg(layer, t) {
    if (layer.baseY < Hi) fillGround(layer);
    ctx.strokeStyle = layer.color;
    ctx.fillStyle = layer.color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    var wind = t * CFG.windSpeed;
    for (var i = 0; i < layer.plants.length; i++) drawPlant(layer.plants[i], wind);
  }

  // One plant, regrown deterministically from its seed every frame so only the
  // sway changes. Recursion gives natural branching; sway accumulates down the
  // chain so the tips move most — like a real plant in a breeze.
  function drawPlant(p, wind) {
    var rng = mulberry32(p.seed);
    var baseW = Math.max(1.1, p.h * 0.05);
    var lean = p.curl * 0.15;          // base lean
    var arch = p.curl * 0.04;          // gentle per-segment arch

    // one leaf, drawn pointing along +x then rotated to the branch angle
    function leaf(x, y, ang, len) {
      var s = Math.max(1.1, len);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(-ang);
      ctx.beginPath();
      if (p.leaf === 1) {                          // lanceolate (pointed)
        var lw = s * 1.5, lh = s * 0.4;
        ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(lw * 0.45, -lh, lw, 0);
        ctx.quadraticCurveTo(lw * 0.45, lh, 0, 0);
      } else if (p.leaf === 2) {                   // round
        ctx.ellipse(s * 0.5, 0, s * 0.7, s * 0.6, 0, 0, TAU);
      } else if (p.leaf === 3) {                   // teardrop / heart-ish
        var tw = s * 1.1, th = s * 0.62;
        ctx.moveTo(0, 0);
        ctx.bezierCurveTo(tw * 0.1, -th, tw * 1.05, -th * 0.5, tw, 0);
        ctx.bezierCurveTo(tw * 1.05, th * 0.5, tw * 0.1, th, 0, 0);
      } else {                                     // oval (default)
        ctx.ellipse(s * 0.55, 0, s * 0.8, s * 0.3, 0, 0, TAU);
      }
      ctx.fill();
      ctx.restore();
    }

    function stem(x, y, ang, len, wid) {
      var ex = x + Math.cos(ang) * len;
      var ey = y - Math.sin(ang) * len;
      var mx = (x + ex) / 2 + Math.cos(ang + 1.57) * len * 0.07;
      var my = (y + ey) / 2 - Math.sin(ang + 1.57) * len * 0.07;
      ctx.lineWidth = Math.max(0.7, wid);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.quadraticCurveTo(mx, my, ex, ey);
      ctx.stroke();
      return [ex, ey];
    }

    function leaflet(x, y, ang, len, wid, d) {
      var flex = (d + 1) * 0.14;
      var a = ang + Math.sin(wind * 1.7 + p.phase + d) * p.sway * 0.14 * flex;
      var e = stem(x, y, a, len, wid);
      leaf(e[0], e[1], a, len * 0.5);
    }

    function branch(x, y, ang, len, wid, depth, d) {
      var flex = (d + 1) * 0.14;
      ang += arch
           + Math.sin(wind + p.phase + d * 0.7) * p.sway * 0.10 * flex
           + Math.sin(wind * 2.4 + p.phase * 1.7 + d) * p.sway * 0.035 * flex;
      var e = stem(x, y, ang, len, wid);

      if (depth <= 0 || len < 2.2) {
        if (p.kind === 3) leaf(e[0], e[1], ang, len * 0.7);        // pointed blade tip
        else if (p.kind === 2) leaf(e[0], e[1], ang, len * 1.45);  // big broad leaf
        else leaf(e[0], e[1], ang, len * 1.3);
        return;
      }

      if (p.kind === 0) {                          // fern: paired leaflets + continue
        var ll = len * 0.62;
        leaflet(e[0], e[1], ang + 0.7 + rng() * 0.25, ll, wid * 0.55, d);
        leaflet(e[0], e[1], ang - 0.7 - rng() * 0.25, ll, wid * 0.55, d);
        branch(e[0], e[1], ang + (rng() * 2 - 1) * 0.18, len * 0.84, wid * 0.8, depth - 1, d + 1);
      } else if (p.kind === 1) {                   // bush: forks into 2–3 stems
        var spread = 0.45 + rng() * 0.3;
        branch(e[0], e[1], ang + spread, len * 0.76, wid * 0.72, depth - 1, d + 1);
        branch(e[0], e[1], ang - spread * (0.7 + rng() * 0.5), len * 0.72, wid * 0.7, depth - 1, d + 1);
        if (rng() < 0.35) branch(e[0], e[1], ang + (rng() * 2 - 1) * 0.25, len * 0.66, wid * 0.6, depth - 1, d + 1);
      } else {                                     // broadleaf (2) & grass (3): single stem
        branch(e[0], e[1], ang + (rng() * 2 - 1) * 0.12,
               len * (p.kind === 3 ? 0.9 : 0.82),
               wid * (p.kind === 3 ? 0.86 : 0.78), depth - 1, d + 1);
      }
    }

    // grass & broad-leaf herbs grow several stems from the base; others a single one
    if (p.kind === 3) {
      var blades = 4 + (rng() * 4 | 0);
      for (var i = 0; i < blades; i++) {
        var a = Math.PI / 2 + (i / (blades - 1) - 0.5) * 0.9 + lean;
        branch(p.x + (rng() * 2 - 1) * 2, p.base, a, p.h * 0.32, baseW * 0.7, 5, 0);
      }
    } else if (p.kind === 2) {
      var stems = 3 + (rng() * 3 | 0);
      for (var j = 0; j < stems; j++) {
        var a2 = Math.PI / 2 + (j / Math.max(1, stems - 1) - 0.5) * 1.1 + lean;
        branch(p.x + (rng() * 2 - 1) * 2, p.base, a2, p.h * 0.34, baseW * 0.8, 2, 0);
      }
    } else {
      branch(p.x, p.base, Math.PI / 2 + (rng() * 2 - 1) * 0.18 + lean, p.h * 0.4, baseW,
             p.kind === 0 ? 6 : 4, 0);
    }
  }

  function drawStars(t) {
    for (var i = 0; i < stars.length; i++) {
      var s = stars[i];
      var a = s.b * (0.55 + CFG.twinkle * Math.sin(t * s.tf + s.tw) + (1 - CFG.twinkle) * 0.45);
      a = clamp(a, 0, 1);
      ctx.fillStyle = 'rgba(220,232,210,' + (a * 0.9).toFixed(3) + ')';
      var sz = s.big ? 2 : 1;
      ctx.fillRect(s.x | 0, s.y | 0, sz, sz);
    }
  }

  // ----------------------------------------------------------- firefly
  function Firefly(x, y) {
    this.x = x; this.y = y;
    var a = Math.random() * TAU;
    var sp = rand(4, 12);
    this.vx = Math.cos(a) * sp;
    this.vy = Math.sin(a) * sp;
    this.heading = a;          // intended travel direction
    this.dir = a;              // sprite orientation
    this.spdPhase = Math.random() * TAU;
    this.spdFreq = rand(0.15, 0.5);
    this.hoverT = 0;
    this.period = rand(CFG.periodMin, CFG.periodMax);
    this.phase = Math.random();
    this.flashClock = 99;
    this.flashLong = false;     // this flash lingers (a misfire)
    this.phaseDelta = 0;
    this.flapOff = Math.random() * TAU;
    this.bobOff = Math.random() * TAU;
    this.shx = 0; this.shy = 0; // per-frame visual tremble
    this.cx = 0; this.cy = 0;   // grid cell
  }

  Firefly.prototype.move = function (dt, sepx, sepy, cohx, cohy, alx, aly) {
    // wander
    if (Math.random() < CFG.dartChance) this.heading += (Math.random() * 2 - 1) * 2.2;
    this.heading += randn() * CFG.turnNoise * dt;

    // hover / pause state
    if (this.hoverT > 0) this.hoverT -= dt;
    else if (Math.random() < CFG.hoverChance * dt * 60) this.hoverT = rand(CFG.hoverMin, CFG.hoverMax);

    // variable cruising speed
    this.spdPhase += dt * this.spdFreq;
    var base = lerp(CFG.speedBaseMin, CFG.speedBaseMax, 0.5 + 0.5 * Math.sin(this.spdPhase));
    var ts = this.hoverT > 0 ? base * 0.12 : base;

    var dvx = Math.cos(this.heading) * ts;
    var dvy = Math.sin(this.heading) * ts;

    var ax = (dvx - this.vx) * CFG.steerGain + sepx * CFG.wSep + cohx * CFG.wCoh + alx * CFG.wAli;
    var ay = (dvy - this.vy) * CFG.steerGain + sepy * CFG.wSep + cohy * CFG.wCoh + aly * CFG.wAli;

    // restless insect tremor
    ax += randn() * CFG.tremor;
    ay += randn() * CFG.tremor;

    // soft walls
    var m = CFG.edgeMargin;
    if (this.x < m) ax += CFG.edgeForce * (1 - this.x / m);
    else if (this.x > Wi - m) ax -= CFG.edgeForce * (1 - (Wi - this.x) / m);
    if (this.y < m) ay += CFG.edgeForce * (1 - this.y / m);
    else if (this.y > Hi - m) ay -= CFG.edgeForce * (1 - (Hi - this.y) / m);

    // prefer to hover over the vegetation, not high in the sky
    var skyLine = Hi * 0.42;
    if (this.y < skyLine) ay += CFG.skyPull * (skyLine - this.y) / skyLine;

    this.vx += ax * dt; this.vy += ay * dt;
    var sp = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
    if (sp > CFG.speedMax) { var k = CFG.speedMax / sp; this.vx *= k; this.vy *= k; sp = CFG.speedMax; }

    this.x = clamp(this.x + this.vx * dt, 1, Wi - 1);
    this.y = clamp(this.y + this.vy * dt, 1, Hi - 1);
    if (sp > CFG.headingMin) this.dir = Math.atan2(this.vy, this.vx);

    // fast visual buzz, on top of the actual motion
    this.shx = randn() * CFG.shakeAmp;
    this.shy = randn() * CFG.shakeAmp;
  };

  Firefly.prototype.intensity = function () {
    var t = this.flashClock, p;
    var hold = CFG.flashHold + (this.flashLong ? CFG.flashHold * 2.5 : 0);   // lingers longer
    var tau = CFG.flashTau * (this.flashLong ? 1.6 : 1);
    if (t < CFG.flashAttack) p = t / CFG.flashAttack;            // rise
    else if (t < CFG.flashAttack + hold) p = 1;                  // hold
    else p = Math.exp(-(t - CFG.flashAttack - hold) / tau);      // fade
    return Math.max(CFG.idleGlow, p);
  };

  // ------------------------------------------------------------ population
  var flies = [];

  function spawn(x, y) {
    flies.push(new Firefly(x, y));
    if (flies.length > CFG.maxFlies) flies.shift();  // recycle the oldest
  }

  // ------------------------------------------------------- spatial grid
  var grid = [], GW = 0, GH = 0, CS = 0;
  function buildGrid() {
    CS = CFG.blinkR;
    GW = Math.max(1, Math.ceil(Wi / CS));
    GH = Math.max(1, Math.ceil(Hi / CS));
    grid = new Array(GW * GH);
    for (var i = 0; i < flies.length; i++) {
      var f = flies[i];
      f.cx = clamp(Math.floor(f.x / CS), 0, GW - 1);
      f.cy = clamp(Math.floor(f.y / CS), 0, GH - 1);
      var key = f.cx * GH + f.cy;
      (grid[key] || (grid[key] = [])).push(f);
    }
  }
  function forNeighbors(f, cb) {
    for (var dx = -1; dx <= 1; dx++) {
      var nx = f.cx + dx;
      if (nx < 0 || nx >= GW) continue;
      for (var dy = -1; dy <= 1; dy++) {
        var ny = f.cy + dy;
        if (ny < 0 || ny >= GH) continue;
        var bucket = grid[nx * GH + ny];
        if (!bucket) continue;
        for (var i = 0; i < bucket.length; i++) {
          var g = bucket[i];
          if (g === f) continue;
          var ex = f.x - g.x, ey = f.y - g.y;
          cb(g, ex * ex + ey * ey);
        }
      }
    }
  }

  // ------------------------------------------------------------ world step
  var flashes = [];
  function step(dt) {
    buildGrid();
    flashes.length = 0;

    for (var i = 0; i < flies.length; i++) {
      var f = flies[i];
      var sepx = 0, sepy = 0, cox = 0, coy = 0, alx = 0, aly = 0, fn = 0;
      var perSum = 0, perN = 0;

      forNeighbors(f, function (g, d2) {
        var d = Math.sqrt(d2) || 1e-4;
        if (d < CFG.flockR) {
          cox += g.x; coy += g.y; alx += g.vx; aly += g.vy; fn++;
          if (d < CFG.sepR) {
            var w = (CFG.sepR - d) / CFG.sepR / d;
            sepx += (f.x - g.x) * w; sepy += (f.y - g.y) * w;
          }
        }
        if (d < CFG.blinkR) { perSum += g.period; perN++; }
      });

      f.move(dt, sepx, sepy,
        fn ? cox / fn - f.x : 0, fn ? coy / fn - f.y : 0,
        fn ? alx / fn - f.vx : 0, fn ? aly / fn - f.vy : 0);

      // frequency entrainment: ease period toward local average
      if (perN > 0) {
        var avg = perSum / perN;
        f.period += CFG.freqAdapt * (avg - f.period) * dt;
        f.period = clamp(f.period, CFG.periodMin * 0.7, CFG.periodMax * 1.3);
      }

      // advance phase; fire on wrap
      f.flashClock += dt;
      f.phase += dt / f.period;
      if (f.phase >= 1) {
        f.phase -= 1;
        if (Math.random() < CFG.glitchChance) {
          // a misfire — keeps the swarm from locking perfectly
          if (Math.random() < 0.5) {
            // SKIP: stay dark this cycle, emit no pulse (a missed beat)
          } else {
            // LINGER: glow longer and slip a little behind, throwing off the
            // rhythm; coupling will pull it (and its neighbours) back in time
            f.flashClock = 0;
            f.flashLong = true;
            f.phase -= 0.15;
            flashes.push(f);
          }
        } else {
          f.flashClock = 0;
          f.flashLong = false;
          flashes.push(f);
        }
      }
    }

    // pulse coupling: deliver each flash to nearby fireflies
    for (var k = 0; k < flashes.length; k++) {
      forNeighbors(flashes[k], function (g, d2) {
        if (g.flashClock < CFG.refractory) return;   // refractory
        if (d2 > CFG.blinkR * CFG.blinkR) return;
        var d = Math.sqrt(d2);
        g.phaseDelta += CFG.phaseBump * (1 - d / CFG.blinkR);
      });
    }
    for (var j = 0; j < flies.length; j++) {
      var ff = flies[j];
      if (ff.phaseDelta) {
        ff.phase = Math.min(0.999, ff.phase + Math.min(CFG.maxBump, ff.phaseDelta));
        ff.phaseDelta = 0;
      }
    }
  }

  // -------------------------------------------------------------- render
  function render(t) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.drawImage(skyTex, 0, 0);
    drawStars(t);
    drawVeg(veg.back, t);
    drawVeg(veg.mid, t);

    // firefly bodies
    var ws = SP.S * SP.scale, off = -ws / 2;
    for (var i = 0; i < flies.length; i++) {
      var f = flies[i];
      var bob = Math.sin(t * CFG.bobFreq + f.bobOff) * CFG.bobAmp;
      var wing = (Math.floor((t + f.flapOff) * CFG.flapRate) & 1);
      var lit = clamp((f.intensity() - CFG.idleGlow) / 0.5, 0, 1);
      ctx.save();
      ctx.translate(f.x + f.shx, f.y + bob + f.shy);
      ctx.rotate(f.dir);
      ctx.drawImage(spritesDark[wing], off, off, ws, ws);   // near-black when unlit
      if (lit > 0) {                                         // colour appears as it flashes
        ctx.globalAlpha = lit;
        ctx.drawImage(sprites[wing], off, off, ws, ws);
        ctx.globalAlpha = 1;
      }
      ctx.restore();
    }

    // glows (additive)
    ctx.globalCompositeOperation = 'lighter';
    var bp = (SP.S - 8) * SP.scale;
    var lanX = SP.lanX * SP.scale, lanY = SP.lanY * SP.scale;
    for (var j = 0; j < flies.length; j++) {
      var fl = flies[j];
      var bob2 = Math.sin(t * CFG.bobFreq + fl.bobOff) * CFG.bobAmp;
      var cs = Math.cos(fl.dir), sn = Math.sin(fl.dir);
      var lx = fl.x + fl.shx + cs * lanX - sn * lanY;
      var ly = fl.y + fl.shy + bob2 + sn * lanX + cs * lanY;
      var inten = fl.intensity();

      // soft pool of light — wide but faint, so it lights the plants
      // around the firefly without painting an opaque disc over them
      var ra = bp * (1.0 + inten * 2.0);
      ctx.globalAlpha = clamp(inten * 0.40, 0, 0.48);
      ctx.drawImage(glowWarm, lx - ra, ly - ra, ra * 2, ra * 2);

      // the lantern itself — small and bright (just the firefly's back)
      var rc = bp * (0.28 + inten * 0.45);
      ctx.globalAlpha = Math.max(0.1, clamp((inten - 0.12) / 0.88, 0, 1) * 0.9);
      ctx.drawImage(glowCore, lx - rc, ly - rc, rc * 2, rc * 2);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;

    drawVeg(veg.front, t);       // foreground occludes for depth
    ctx.drawImage(vignetteTex, 0, 0);
  }

  // ---------------------------------------------------------------- loop
  var last = 0;
  function frame(now) {
    var t = now / 1000;
    var dt = last ? Math.min(0.05, t - last) : 0;
    last = t;
    if (dt > 0 && flies.length) step(dt);
    render(t);
    requestAnimationFrame(frame);
  }

  // --------------------------------------------------------------- resize
  function resize() {
    var cssW = window.innerWidth, cssH = window.innerHeight;
    PIXEL = clamp(Math.round(Math.min(cssW, cssH) / 180), 2, 4);
    var nWi = Math.max(80, Math.ceil(cssW / PIXEL));
    var nHi = Math.max(80, Math.ceil(cssH / PIXEL));

    // keep existing fireflies in frame
    if (Wi && Hi && flies.length) {
      var fx = nWi / Wi, fy = nHi / Hi;
      for (var i = 0; i < flies.length; i++) { flies[i].x *= fx; flies[i].y *= fy; }
    }
    Wi = nWi; Hi = nHi;
    canvas.width = Wi; canvas.height = Hi;
    ctx.imageSmoothingEnabled = true;   // smooth at low-res; CSS pixelates upscale

    buildSprites();
    buildGlow();
    buildBackground();
  }

  // ---------------------------------------------------------------- input
  var intro = document.getElementById('intro');
  var started = false, pressing = false, lastSpawnX = 0, lastSpawnY = 0;

  // about overlay (reachable only from the start screen, via the "?")
  var help = document.getElementById('help');
  var about = document.getElementById('about');
  var aboutCloseBtn = document.getElementById('about-close');
  var aboutOpen = false;

  function openAbout() { aboutOpen = true; about.classList.add('open'); }
  function closeAbout() { aboutOpen = false; about.classList.remove('open'); about.scrollTop = 0; }

  if (help) {
    help.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    help.addEventListener('click', openAbout);
  }
  if (aboutCloseBtn) {
    aboutCloseBtn.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    aboutCloseBtn.addEventListener('click', closeAbout);
  }
  if (about) {
    about.addEventListener('pointerdown', function (e) { e.stopPropagation(); });  // never spawn behind it
    about.addEventListener('click', function (e) { if (e.target === about) closeAbout(); });
  }
  window.addEventListener('keydown', function (e) { if (e.key === 'Escape' && aboutOpen) closeAbout(); });

  function evt(e) {
    return { x: clamp(e.clientX / PIXEL, 1, Wi - 1), y: clamp(e.clientY / PIXEL, 1, Hi - 1) };
  }
  function begin() {
    if (started) return;
    started = true;
    intro.classList.add('gone');
  }
  function onDown(e) {
    if (aboutOpen) return;
    var p = evt(e);
    spawn(p.x, p.y);
    pressing = true; lastSpawnX = p.x; lastSpawnY = p.y;
    begin();
  }
  function onMove(e) {
    if (!pressing || aboutOpen) return;
    var p = evt(e);
    var dx = p.x - lastSpawnX, dy = p.y - lastSpawnY;
    if (dx * dx + dy * dy > 49) {        // drag to scatter a trail of fireflies
      spawn(p.x + rand(-2, 2), p.y + rand(-2, 2));
      lastSpawnX = p.x; lastSpawnY = p.y;
    }
  }
  function onUp() { pressing = false; }

  window.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', resize);

  // ----------------------------------------------------------------- go
  resize();
  requestAnimationFrame(frame);
})();
