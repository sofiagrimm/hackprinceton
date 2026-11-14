// Play the room.
//
// Four tools built on one room model (the acoustics engine's dimensions, per-band
// reverberation and surface absorption):
//
// 1. Watch the sound. A 2D finite-difference time-domain (FDTD) simulation of the
//    wave equation over the room's floor plan, the method used in research room
//    acoustics solvers (Savioja 2010; Saarelma & Savioja 2014; Microsoft's Planeverb).
//    Walls are locally reacting impedance boundaries (Kowalczyk & van Walstijn 2008)
//    whose admittance comes from the wall finish. Floor and ceiling can't exist in a
//    plan view, so their share of the decay is applied as a uniform loss sized so the
//    field dies away at the room's estimated RT60.
//
// 2. Hear it from any seat. A hybrid impulse response per seat: image sources up to
//    third order, each rendered through the browser's HRTF panner from its true
//    direction and filtered for the high-frequency loss of every bounce, then a
//    diffuse tail per octave band whose level follows Barron's revised theory and
//    starts at the room's mixing time (about sqrt(V) ms).
//
// 3. Clap to measure. ISO 3382 style: octave filtering, Schroeder backward
//    integration, Lundeby's iterative noise truncation with compensation, and a
//    T20 / T15 / T10 fit depending on the dynamic range the clap gave us.
//
// 4. Compare two rooms with your own voice, with a crossfade between them.

import { RoomSound, bandpass } from "./audio.js";
import { barronC80 } from "./roommap.js";

const C = 343;
const $ = (root, sel) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const fmtS = (s) => `${s.toFixed(s < 1 ? 2 : 1)}s`;

// ============================================================ the wave field

class WaveField {
  constructor() {
    this.ready = false;
  }

  /** dims in metres, alphaWalls mid-band random-incidence absorption, rt60 mid (s) */
  setRoom(dims, alphaWalls, rt60, cellsLong = 200) {
    const L = Math.max(dims.length, 3), W = Math.max(dims.width, 2);
    this.L = L; this.W = W;
    this.dx = L / cellsLong;
    this.nx = cellsLong;
    this.ny = Math.max(24, Math.round(W / this.dx));
    this.lambda = 0.7; // Courant number, under the 2D stability limit of 1/sqrt(2)
    this.dt = (this.lambda * this.dx) / C;
    const n = this.nx * this.ny;
    this.p0 = new Float32Array(n); this.p1 = new Float32Array(n); this.p2 = new Float32Array(n);
    // Wall admittance from the finish: normal-incidence pressure reflection R = sqrt(1 - alpha).
    const R = Math.sqrt(1 - clamp(alphaWalls, 0.01, 0.95));
    this.beta = (1 - R) / (1 + R);
    // Decay the walls alone give in 2D (Eyring, mean free path pi A / P), and the rest
    // (floor, ceiling, audience, air) as a uniform loss so the field fades at the room's RT60.
    const mfp = (Math.PI * L * W) / (2 * (L + W));
    const wallRate = (-C * Math.log(1 - clamp(alphaWalls, 0.01, 0.95))) / mfp;
    const totalRate = 13.82 / Math.max(rt60, 0.1);
    this.extraRate = Math.max(0, totalRate - wallRate);
    this.damp = Math.exp((-this.extraRate * this.dt) / 2);
    this.rt60 = rt60;
    this.time = 0;
    this.pulses = [];
    this.ref = 1;
    this.ready = true;
    // Ricker wavelet with a wavelength of about 10 cells keeps numerical dispersion small.
    this.fp = C / (10 * this.dx);
  }

  clear() { this.p0.fill(0); this.p1.fill(0); this.p2.fill(0); this.time = 0; this.pulses = []; }

  /** Start a pulse at (x, y) metres. */
  emit(points, amp = 1) {
    this.pulses.push({ points: points.map(([x, y]) => this.cell(x, y)), t: 0, amp });
    this.time = 0;
  }

  cell(x, y) {
    return [clamp(Math.round(x / this.dx), 1, this.nx - 2), clamp(Math.round(y / this.dx), 1, this.ny - 2)];
  }

  step() {
    const { nx, ny, p0, p1, p2, lambda } = this;
    const l2 = lambda * lambda, lb = lambda * this.beta, damp = this.damp;
    for (let j = 0; j < ny; j++) {
      const row = j * nx;
      for (let i = 0; i < nx; i++) {
        const k0 = row + i;
        const c = p1[k0];
        let k = 0;
        // Missing neighbours at a wall are mirrored (rigid part) and counted (lossy part).
        const w = i > 0 ? p1[k0 - 1] : (k++, p1[k0 + 1]);
        const e = i < nx - 1 ? p1[k0 + 1] : (k++, p1[k0 - 1]);
        const s = j > 0 ? p1[k0 - nx] : (k++, p1[k0 + nx]);
        const n = j < ny - 1 ? p1[k0 + nx] : (k++, p1[k0 - nx]);
        const lap = w + e + s + n - 4 * c;
        p2[k0] = k
          ? (2 * c - (1 - k * lb) * p0[k0] + l2 * lap) / (1 + k * lb) * damp
          : (2 * c - p0[k0] + l2 * lap) * damp;
      }
    }
    // Soft sources: add the wavelet at the singers.
    const half = 1.4 / this.fp;
    this.pulses = this.pulses.filter((p) => {
      const t = p.t - half;
      const a = Math.PI * Math.PI * this.fp * this.fp * t * t;
      const v = p.amp * t * this.fp * (3 - 2 * a) * Math.exp(-a);
      p.points.forEach(([x, y]) => { p2[y * nx + x] += v; });
      p.t += this.dt;
      return p.t < 2 * half;
    });
    this.p0 = p1; this.p1 = p2; this.p2 = p0;
    this.time += this.dt;
  }
}

// ============================================================ seat impulse responses

/** Per-band random-incidence reflection coefficients implied by the band RT60s (Sabine, inverted). */
function bandReflections(bands, dims) {
  const { length: L, width: W, height: H } = dims;
  const V = L * W * H, S = 2 * (L * W + L * H + W * H);
  return bands.map((t) => Math.sqrt(1 - clamp((0.161 * V) / (Math.max(t, 0.05) * S), 0.01, 0.95)));
}

export function stagePoint(dims) {
  return [clamp(0.15 * dims.length, 1.2, 4), dims.width / 2];
}

export function singerPoints(dims) {
  const [sx, sy] = stagePoint(dims);
  const spread = Math.min(dims.width * 0.25, 2.4);
  return [-1.5, -0.5, 0.5, 1.5].map((k) => [sx + Math.abs(k) * 0.25, sy + (k * spread) / 1.5]);
}

/**
 * Binaural impulse response for one seat. Returns an AudioBuffer at the given rate.
 * seat: [x, y] metres on the floor plan; listener faces the singers.
 */
export async function makeSeatImpulse(bands, dims, seat, sampleRate = 48000) {
  const L = Math.max(dims.length, 2), W = Math.max(dims.width, 2), H = Math.max(dims.height, 2.4);
  const V = L * W * H;
  const [sx, sy] = stagePoint({ length: L, width: W });
  const src = [sx, sy, 1.6];
  const ear = [seat[0], seat[1], 1.2];
  const rtMax = Math.max(...bands);
  const len = Math.floor(sampleRate * Math.min(6, Math.max(0.6, rtMax * 1.2)));
  const ctx = new OfflineAudioContext(2, len, sampleRate);

  const refl = bandReflections(bands, { length: L, width: W, height: H });
  const rMid = (refl[2] + refl[3]) / 2;
  const g4k = Math.min(1, refl[5] / rMid);
  const one = ctx.createBuffer(1, 2, sampleRate);
  one.getChannelData(0)[0] = 1;

  const N = 3;
  for (let i = -N; i <= N; i++) for (let j = -N; j <= N; j++) for (let k = -N; k <= N; k++) {
    const order = Math.abs(i) + Math.abs(j) + Math.abs(k);
    if (order > N) continue;
    const ix = i % 2 === 0 ? i * L + src[0] : i * L + (L - src[0]);
    const iy = j % 2 === 0 ? j * W + src[1] : j * W + (W - src[1]);
    const iz = k % 2 === 0 ? k * H + src[2] : k * H + (H - src[2]);
    const dx = ix - ear[0], dy = iy - ear[1], dz = iz - ear[2];
    const d = Math.hypot(dx, dy, dz);
    const t = d / C;
    if (t * sampleRate >= len - 2) continue;
    const s = ctx.createBufferSource();
    s.buffer = one;
    const g = ctx.createGain();
    g.gain.value = Math.pow(rMid, order) / Math.max(d, 0.5);
    // Each bounce loses treble in proportion to the 4 kHz vs mid reflection (plus air).
    const hfLoss = Math.pow(g4k, order) * Math.exp(-0.0115 * d);
    const fc = hfLoss < 0.999 ? clamp(4000 / Math.sqrt(1 / (hfLoss * hfLoss) - 1), 700, 20000) : 20000;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = fc; lp.Q.value = 0.5;
    const pan = ctx.createPanner();
    pan.panningModel = "HRTF";
    pan.distanceModel = "linear"; pan.rolloffFactor = 0;
    // Room axes to listener axes: the listener faces -x (toward the stage), right is +y, up is +z.
    // Web Audio's listener faces -z with +x to the right and +y up.
    pan.positionX.value = dy; pan.positionY.value = dz; pan.positionZ.value = dx;
    s.connect(g).connect(lp).connect(pan).connect(ctx.destination);
    s.start(t);
  }
  const rendered = await ctx.startRendering();

  // Diffuse tail. Barron's revised theory gives the reflected energy after time t' from the
  // direct sound as (31200 T / V) e^(-13.82 t'/T) e^(-0.04 r/T) against a direct level of
  // 100 / r^2. With the direct impulse at amplitude 1/r, the tail's rms at t' = 0 is
  // sqrt(4312 / (V fs)) per band-weighted unit.
  const r = Math.hypot(ear[0] - src[0], ear[1] - src[1], ear[2] - src[2]);
  const tDirect = r / C;
  const tMix = Math.max(tDirect + 0.008, Math.sqrt(V) / 1000);
  const sigma0 = Math.sqrt(4312 / (V * sampleRate));
  const OCT = [125, 250, 500, 1000, 2000, 4000];
  for (let ch = 0; ch < 2; ch++) {
    const out = rendered.getChannelData(ch);
    const start = Math.floor(tMix * sampleRate);
    const fade = Math.floor(0.012 * sampleRate);
    for (let b = 0; b < OCT.length; b++) {
      const noise = new Float32Array(len);
      for (let n = start; n < len; n++) noise[n] = Math.random() * 2 - 1;
      const f = bandpass(bandpass(noise, OCT[b], sampleRate), OCT[b], sampleRate);
      let v = 0; for (let n = start; n < len; n++) v += f[n] * f[n];
      const norm = 1 / Math.sqrt(Math.max(v / Math.max(len - start, 1), 1e-12) * OCT.length);
      const T = Math.max(bands[b], 0.05);
      const level = sigma0 * Math.exp((-0.02 * r) / T) * norm;
      for (let n = start; n < len; n++) {
        const tp = n / sampleRate - tDirect;
        const ramp = n - start < fade ? 0.5 - 0.5 * Math.cos((Math.PI * (n - start)) / fade) : 1;
        out[n] += f[n] * level * Math.exp((-6.91 * tp) / T) * ramp;
      }
    }
    // A listener 3 m from the singers hears the direct sound at unity.
    for (let n = 0; n < len; n++) out[n] *= 3;
  }
  return rendered;
}

// ============================================================ audio graph with two rooms

class PlaySound extends RoomSound {
  _ensure() {
    if (this.ctx) return;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.convs = [ctx.createConvolver(), ctx.createConvolver()];
    this.gains = [ctx.createGain(), ctx.createGain()];
    this.gains[1].gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10; comp.ratio.value = 6;
    this.master = ctx.createGain();
    this.master.gain.value = 0.6;
    this.convs.forEach((c, i) => {
      c.normalize = false;
      this.input.connect(c).connect(this.gains[i]).connect(comp);
    });
    comp.connect(this.master).connect(ctx.destination);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.master.connect(this.analyser);
    this.active = 0;
  }

  setRoom() { /* rooms are set per slot with setSlot */ }

  setSlot(i, buffer) {
    this._ensure();
    this.convs[i].buffer = buffer;
  }

  choose(i) {
    this._ensure();
    this.active = i;
    const t = this.ctx.currentTime;
    this.gains.forEach((g, k) => g.gain.setTargetAtTime(k === i ? 1 : 0, t, 0.04));
  }
}

// ============================================================ clap measurement

/**
 * Reverberation time from a recorded clap, after ISO 3382-1/-2.
 * Returns { rt, method, edt, rangeDb, curves } or { error }.
 */
export function measureDecay(samples, sr) {
  let peak = 0, pi = 0;
  for (let i = 0; i < samples.length; i++) { const v = Math.abs(samples[i]); if (v > peak) { peak = v; pi = i; } }
  if (peak < 0.02) return { error: "That was too quiet to measure. Clap once, sharply, close to the laptop." };
  const pre = samples.slice(0, Math.max(0, pi - Math.floor(0.05 * sr)));
  const x = samples.slice(Math.max(0, pi - Math.floor(0.002 * sr)));
  if (x.length < sr * 0.4) return { error: "The clap came too late in the recording. Try again and clap right away." };

  const results = [];
  for (const f of [500, 1000]) {
    const y = bandpass(bandpass(x, f, sr), f, sr);
    const r = decayFromBand(y, sr, pre.length > sr * 0.2 ? bandpass(bandpass(pre, f, sr), f, sr) : null);
    if (!r.error) results.push(r);
  }
  if (!results.length) return { error: "The clap didn't stand far enough above the background noise. Find a quieter moment or clap harder." };
  const avg = (k) => results.reduce((s, r) => s + r[k], 0) / results.length;
  return {
    rt: avg("rt"), edt: avg("edt"), rangeDb: Math.min(...results.map((r) => r.rangeDb)),
    method: results.map((r) => r.method).sort().pop(), curves: results[results.length - 1],
  };
}

function decayFromBand(y, sr, preNoise) {
  // Energy envelope in 10 ms blocks.
  const block = Math.floor(0.01 * sr);
  const env = [];
  for (let i = 0; i + block <= y.length; i += block) {
    let e = 0; for (let k = 0; k < block; k++) e += y[i + k] * y[i + k];
    env.push(e / block);
  }
  const e0 = Math.max(...env.slice(0, 5));
  const db = env.map((e) => 10 * Math.log10(Math.max(e, 1e-20) / e0));
  const dt = block / sr;

  // Lundeby et al. (1995): iterate noise level, regression and the cross point.
  const tailMean = (from) => {
    const s = env.slice(Math.max(from, Math.floor(env.length * 0.9)));
    return s.reduce((a, b) => a + b, 0) / Math.max(s.length, 1);
  };
  let noise = tailMean(0);
  if (preNoise) {
    let e = 0; for (const v of preNoise) e += v * v;
    noise = Math.min(noise, e / preNoise.length);
  }
  let noiseDb = 10 * Math.log10(Math.max(noise, 1e-20) / e0);
  if (noiseDb > -20) return { error: "range" };
  let cross = env.length - 1, slope = -60;
  for (let iter = 0; iter < 5; iter++) {
    const stop = db.findIndex((v, i) => i > 0 && v < noiseDb + 10);
    const end = stop > 2 ? stop : Math.floor(env.length / 2);
    const fit = regress(db, 0, end, dt);
    if (fit.slope >= 0) break;
    slope = fit.slope;
    cross = clamp(Math.floor((noiseDb - fit.b) / slope / dt), 3, env.length - 1);
    // Re-estimate the noise from a point 5 to 10 dB of decay past the cross point.
    const after = cross + Math.floor((-10 / slope) / dt);
    if (after < env.length - 3) noiseDb = 10 * Math.log10(Math.max(tailMean(after), 1e-20) / e0);
  }

  // Schroeder backward integration up to the cross point, plus the energy the
  // exponential decay would have had after it (Lundeby compensation).
  const k = (-slope * Math.LN10) / 10; // energy decay rate per second
  let acc = (env[cross] - noise > 0 ? env[cross] - noise : env[cross]) / (k * dt);
  const sch = new Array(cross + 1);
  for (let i = cross; i >= 0; i--) { acc += Math.max(env[i] - noise, 0); sch[i] = acc; }
  const schDb = sch.map((v) => 10 * Math.log10(v / sch[0]));
  const rangeDb = -noiseDb;
  const floor = schDb[schDb.length - 1];

  let method = "T20", lo = -5, hi = -25;
  if (floor > -27) { method = "T15"; hi = -20; }
  if (floor > -22) { method = "T10"; hi = -15; }
  if (floor > -17) return { error: "range" };
  const i1 = schDb.findIndex((v) => v <= lo), i2 = schDb.findIndex((v) => v <= hi);
  const fit = regress(schDb, i1, i2, dt);
  const rt = -60 / fit.slope;
  const iE = schDb.findIndex((v) => v <= -10);
  const edtFit = regress(schDb, 0, Math.max(iE, 2), dt);
  return { rt, edt: -60 / edtFit.slope, method, rangeDb, db, schDb, dt, fit, i1, i2 };
}

function regress(arr, a, b, dt) {
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = a; i <= b && i < arr.length; i++) { const x = i * dt; n++; sx += x; sy += arr[i]; sxx += x * x; sxy += x * arr[i]; }
  const slope = (n * sxy - sx * sy) / Math.max(n * sxx - sx * sx, 1e-12);
  return { slope, b: (sy - slope * sx) / Math.max(n, 1) };
}

// ============================================================ the component

const TEMPLATE = `
  <div class="pr-stage">
    <canvas class="pr-field" aria-label="Sound spreading through the room, seen from above"></canvas>
    <canvas class="pr-overlay" aria-hidden="true"></canvas>
    <div class="pr-hud">
      <span class="pr-clock">Press play</span>
      <span class="pr-slow"></span>
    </div>
    <div class="pr-hint">Click any seat to sit there</div>
  </div>
  <div class="pr-controls">
    <button type="button" class="pr-play play" aria-label="Play a four-part chord from your seat"><span class="tri"></span></button>
    <div class="pr-seat">
      <p class="pr-seat-line"></p>
      <p class="note">Put on headphones. Echoes arrive from the walls they bounced off.</p>
    </div>
    <div class="pr-buttons">
      <button type="button" class="link pr-clap">Clap</button>
      <button type="button" class="link pr-mic">Sing into the room</button>
    </div>
  </div>
  <div class="pr-compare" hidden>
    <span class="pr-compare-label">Compare with</span>
    <select class="pr-other" aria-label="Second room to compare"></select>
    <div class="seg" role="group" aria-label="Which room you hear">
      <button type="button" data-slot="0" class="on">A</button>
      <button type="button" data-slot="1">B</button>
    </div>
    <span class="note pr-compare-note"></span>
  </div>
  <div class="pr-verdicts">
    <div class="pr-card">
      <p class="eyebrow">For your audience</p>
      <p class="pr-big pr-aud-num"></p>
      <p class="pr-aud"></p>
    </div>
    <div class="pr-card">
      <p class="eyebrow">For your singers</p>
      <p class="pr-big pr-sing-num"></p>
      <p class="pr-sing"></p>
    </div>
  </div>
  <div class="pr-measure">
    <div>
      <h3 class="sub-head">Clap to measure a real room</h3>
      <p class="note">Your microphone hears how long a clap rings, the way acousticians measure halls. Use it on a site visit to check our estimate, or try it right where you are.</p>
      <button type="button" class="btn pr-listen">Measure this room</button>
      <p class="pr-measure-out" aria-live="polite"></p>
      <details class="pr-model">
        <summary>Compare with our model</summary>
        <div class="pr-model-form">
          <label>Length <input type="number" min="5" max="400" value="40" data-k="depth_ft"> ft</label>
          <label>Width <input type="number" min="5" max="400" value="25" data-k="width_ft"> ft</label>
          <label>Ceiling <input type="number" min="6" max="120" value="10" data-k="height_ft"> ft</label>
          <label>Room <select data-k="space_type">
            <option value="office">Office or classroom</option>
            <option value="clubhouse">Lounge or common room</option>
            <option value="ballroom">Ballroom or meeting room</option>
            <option value="chapel">Chapel or church</option>
            <option value="theater">Theater</option>
            <option value="lobby">Lobby or atrium</option>
            <option value="residential_living">Living room</option>
            <option value="unfinished">Bare concrete room</option>
          </select></label>
        </div>
        <p class="pr-model-out"></p>
      </details>
    </div>
    <canvas class="pr-decay" aria-label="Decay of the clap over time"></canvas>
  </div>`;

export function createPlayRoom(root) {
  root.innerHTML = TEMPLATE;
  const field = new WaveField();
  const sound = new PlaySound();
  const fieldCanvas = $(root, ".pr-field"), overlay = $(root, ".pr-overlay");
  const off = document.createElement("canvas");
  let image = null;
  let rooms = [];           // [{ label, acoustics }]
  let slotRoom = [0, 1];    // index into rooms for slot A and B
  let active = 0;
  let crowd = "full";
  let seatFrac = [0.62, 0.5];
  let running = false, visible = true, rafId = 0;
  let measured = null;
  let validation = null;
  const irCache = new Map();

  fetch("/api/validation").then((r) => r.json()).then((v) => { validation = v; renderVerdicts(); }).catch(() => {});

  const room = () => rooms[slotRoom[active]]?.acoustics;
  const bandsOf = (a) => (crowd === "full" ? a.rt60_bands_occupied_s : a.rt60_bands_empty_s);
  const rtOf = (a) => (crowd === "full" ? a.rt60_occupied_s : a.rt60_empty_s);
  const seatM = (a) => [clamp(seatFrac[0] * a.dims_m.length, 0.5, a.dims_m.length - 0.5), clamp(seatFrac[1] * a.dims_m.width, 0.5, a.dims_m.width - 0.5)];

  // ---------------------------------------------------------------- layout

  function size() {
    const a = room();
    if (!a) return;
    const w = root.querySelector(".pr-stage").clientWidth;
    const aspect = clamp(a.dims_m.width / a.dims_m.length, 0.32, 0.9);
    const h = Math.round(w * aspect);
    const dpr = Math.min(devicePixelRatio || 1, 2);
    [fieldCanvas, overlay].forEach((c) => { c.width = w * dpr; c.height = h * dpr; c.style.height = `${h}px`; });
    root.querySelector(".pr-stage").style.height = `${h}px`;
    drawOverlay();
  }

  function loadField() {
    const a = room();
    if (!a?.dims_m) return;
    field.setRoom(a.dims_m, a.surface_alpha?.walls ?? 0.08, rtOf(a));
    off.width = field.nx; off.height = field.ny;
    image = off.getContext("2d").createImageData(field.nx, field.ny);
    $(root, ".pr-slow").textContent = "";
    size();
    paint();
  }

  // ---------------------------------------------------------------- drawing

  const toPx = (x, y) => [(x / field.L) * overlay.width, (y / field.W) * overlay.height];

  function drawOverlay() {
    const a = room();
    if (!a || !field.ready) return;
    const g = overlay.getContext("2d");
    const Wp = overlay.width, Hp = overlay.height, dpr = Wp / overlay.clientWidth || 1;
    g.clearRect(0, 0, Wp, Hp);
    // Walls: thicker and brighter the more they reflect.
    const refl = 1 - (a.surface_alpha?.walls ?? 0.1);
    g.strokeStyle = `rgba(243, 210, 122, ${0.35 + 0.6 * refl})`;
    g.lineWidth = (2 + 6 * refl) * dpr;
    g.strokeRect(0, 0, Wp, Hp);
    // Seats.
    const L = a.dims_m.length, W = a.dims_m.width;
    const pitch = Math.max(0.9, L / 26);
    g.fillStyle = "rgba(243, 236, 225, 0.22)";
    for (let x = Math.max(stagePoint(a.dims_m)[0] + 2.5, L * 0.3); x < L - 0.6; x += pitch) {
      for (let y = 0.8; y < W - 0.6; y += pitch * 0.8) {
        const [px, py] = toPx(x, y);
        g.beginPath(); g.arc(px, py, 1.6 * dpr, 0, 7); g.fill();
      }
    }
    // Paths from the centre singer to the seat: direct and the four first-order wall bounces.
    const [sx, sy] = stagePoint(a.dims_m);
    const [lx, ly] = seatM(a);
    const images = [[sx, sy, "direct"], [-sx, sy, "back wall"], [2 * L - sx, sy, "far wall"], [sx, -sy, "side wall"], [sx, 2 * W - sy, "side wall"]];
    images.forEach(([ix, iy, name], i) => {
      // Point where the path meets the wall, by mirroring back.
      let hx = ix, hy = iy;
      if (i === 1) { const t = (0 - lx) / (ix - lx); hx = 0; hy = ly + t * (iy - ly); }
      if (i === 2) { const t = (L - lx) / (ix - lx); hx = L; hy = ly + t * (iy - ly); }
      if (i === 3) { const t = (0 - ly) / (iy - ly); hy = 0; hx = lx + t * (ix - lx); }
      if (i === 4) { const t = (W - ly) / (iy - ly); hy = W; hx = lx + t * (ix - lx); }
      g.strokeStyle = i ? "rgba(232, 163, 176, 0.45)" : "rgba(243, 236, 225, 0.9)";
      g.lineWidth = (i ? 1.2 : 1.8) * dpr;
      g.setLineDash(i ? [4 * dpr, 4 * dpr] : []);
      g.beginPath();
      g.moveTo(...toPx(sx, sy));
      if (i) g.lineTo(...toPx(hx, hy));
      g.lineTo(...toPx(lx, ly));
      g.stroke();
    });
    g.setLineDash([]);
    // Singers.
    g.fillStyle = "#f3d27a";
    singerPoints(a.dims_m).forEach(([x, y]) => { const [px, py] = toPx(x, y); g.beginPath(); g.arc(px, py, 4.5 * dpr, 0, 7); g.fill(); });
    // Listener.
    const [px, py] = toPx(lx, ly);
    g.strokeStyle = "#f3ece1"; g.lineWidth = 2 * dpr;
    g.beginPath(); g.arc(px, py, 9 * dpr, 0, 7); g.stroke();
    g.fillStyle = "#f3ece1"; g.beginPath(); g.arc(px, py, 3.5 * dpr, 0, 7); g.fill();
    // Scale bar.
    const five = (5 / L) * Wp;
    g.fillStyle = "rgba(243, 236, 225, 0.7)";
    g.fillRect(12 * dpr, Hp - 14 * dpr, five, 2 * dpr);
    g.font = `${11 * dpr}px "DM Sans", sans-serif`;
    g.fillText("5 m", 12 * dpr, Hp - 20 * dpr);
  }

  function paint() {
    if (!field.ready || !image) return;
    const { p1, nx, ny } = field;
    const d = image.data;
    let peak = 0;
    for (let i = 0; i < p1.length; i++) { const v = Math.abs(p1[i]); if (v > peak) peak = v; }
    // Hold the reference while the pulse is being emitted, so the decay stays visible.
    if (field.pulses.length) field.ref = Math.max(field.ref * 0.9, peak * 0.9, 1e-6);
    const ref = field.ref;
    const range = 32; // dB shown
    for (let i = 0, n = nx * ny; i < n; i++) {
      const v = p1[i];
      const m = clamp((20 * Math.log10(Math.abs(v) / ref + 1e-9) + range) / range, 0, 1);
      const w = m * m;
      const o = i * 4;
      // Background wine; compressions toward brass, rarefactions toward blush.
      if (v >= 0) { d[o] = 36 + w * 207; d[o + 1] = 12 + w * 198; d[o + 2] = 16 + w * 106; }
      else { d[o] = 36 + w * 196; d[o + 1] = 12 + w * 151; d[o + 2] = 16 + w * 160; }
      d[o + 3] = 255;
    }
    off.getContext("2d").putImageData(image, 0, 0);
    const g = fieldCanvas.getContext("2d");
    g.imageSmoothingEnabled = true;
    g.drawImage(off, 0, 0, fieldCanvas.width, fieldCanvas.height);
  }

  function frame() {
    rafId = 0;
    if (!field.ready) return;
    // Bullet time for the first reflections, then speed up so the whole decay fits on screen.
    const early = field.time < 0.08;
    const steps = early ? 2 : Math.min(18, 2 + Math.floor((field.time - 0.08) * 160));
    for (let s = 0; s < steps; s++) field.step();
    paint();
    const ms = field.time * 1000;
    const slow = Math.round(1 / 60 / (steps * field.dt));
    $(root, ".pr-clock").textContent = `${ms < 1000 ? ms.toFixed(0) + " ms" : (ms / 1000).toFixed(2) + " s"} after the sound`;
    $(root, ".pr-slow").textContent = slow > 1 ? `picture slowed ${slow}×, sound in real time` : "";
    const alive = field.pulses.length || field.time < field.rt60 * 1.1;
    if (alive && visible) rafId = requestAnimationFrame(frame);
    else running = false;
  }

  function kick() {
    if (!running) { running = true; rafId = requestAnimationFrame(frame); }
  }

  function pulse(amp = 1) {
    const a = room();
    if (!a) return;
    field.emit(singerPoints(a.dims_m), amp);
    kick();
  }

  // ---------------------------------------------------------------- audio

  async function impulseFor(slot) {
    const a = rooms[slotRoom[slot]]?.acoustics;
    if (!a?.dims_m) return null;
    const seat = seatM(a).map((v) => +v.toFixed(1));
    const key = `${slotRoom[slot]}|${crowd}|${seat}`;
    sound._ensure();
    if (!irCache.has(key)) irCache.set(key, makeSeatImpulse(bandsOf(a), a.dims_m, seat, sound.ctx.sampleRate));
    return irCache.get(key);
  }

  let irToken = 0;
  async function refreshImpulses() {
    const token = ++irToken;
    const slots = rooms.length > 1 ? [0, 1] : [0];
    const bufs = await Promise.all(slots.map(impulseFor));
    if (token !== irToken) return;
    bufs.forEach((b, i) => b && sound.setSlot(i, b));
  }

  // ---------------------------------------------------------------- text

  function renderSeat() {
    const a = room();
    if (!a) return;
    const [x, y] = seatM(a);
    const [sx, sy] = stagePoint(a.dims_m);
    const r = Math.hypot(x - sx, y - sy);
    const c80 = barronC80(rtOf(a), a.volume_m3, r);
    const row = Math.max(1, Math.round((x - sx - 1.5) / 0.95));
    const side = y < a.dims_m.width * 0.35 ? "left side" : y > a.dims_m.width * 0.65 ? "right side" : "centre";
    const clear = c80 > 3 ? "every part stays distinct" : c80 < -2 ? "the parts melt together" : "clear but warm";
    $(root, ".pr-seat-line").innerHTML = `<b>Row ${row}, ${side}.</b> ${r.toFixed(0)} m from the singers. Clarity ${c80 > 0 ? "+" : ""}${c80.toFixed(1)} dB: ${clear}.`;
  }

  function renderVerdicts() {
    const a = room();
    if (!a) return;
    $(root, ".pr-aud-num").textContent = `${fmtS(rtOf(a))} reverb`;
    $(root, ".pr-aud").textContent = a.verdict || "";
    const st = a.stage_support_db;
    $(root, ".pr-sing-num").textContent = st == null ? "Open air" : `${st > 0 ? "+" : st < 0 ? "\u2212" : ""}${Math.abs(st)} dB stage support`;
    const ref = validation?.find?.((h) => h.stage_support_db != null && /Musikverein/.test(h.hall));
    const cmp = st != null && ref ? ` The same model gives the Musikverein in Vienna ${ref.stage_support_db} dB.` : "";
    $(root, ".pr-sing").textContent = (a.singers_verdict || "") + cmp;
  }

  function renderCompare() {
    const box = $(root, ".pr-compare");
    box.hidden = rooms.length < 2;
    if (rooms.length < 2) return;
    const sel = $(root, ".pr-other");
    sel.innerHTML = rooms.map((r, i) => (i === slotRoom[0] ? "" : `<option value="${i}" ${i === slotRoom[1] ? "selected" : ""}>${esc(r.label)}</option>`)).join("");
    const A = rooms[slotRoom[0]], B = rooms[slotRoom[1]];
    $(root, ".pr-compare-note").textContent = B ? `A: ${A.label}, ${fmtS(rtOf(A.acoustics))}. B: ${B.label}, ${fmtS(rtOf(B.acoustics))}.` : "";
    root.querySelectorAll("[data-slot]").forEach((b) => b.classList.toggle("on", Number(b.dataset.slot) === active));
  }

  function renderAll() {
    renderSeat(); renderVerdicts(); renderCompare(); drawOverlay();
  }

  // ---------------------------------------------------------------- events

  overlay.style.pointerEvents = "auto";
  overlay.addEventListener("click", (e) => {
    const a = room();
    if (!a) return;
    const rect = overlay.getBoundingClientRect();
    seatFrac = [clamp((e.clientX - rect.left) / rect.width, 0.05, 0.97), clamp((e.clientY - rect.top) / rect.height, 0.05, 0.95)];
    const minX = (stagePoint(a.dims_m)[0] + 1) / a.dims_m.length;
    seatFrac[0] = Math.max(seatFrac[0], minX);
    $(root, ".pr-hint").hidden = true;
    renderSeat(); drawOverlay(); refreshImpulses();
  });

  $(root, ".pr-play").onclick = async () => {
    sound._ensure();
    await sound.ctx.resume();
    await refreshImpulses();
    sound.choose(active);
    field.clear();
    const seconds = await sound.playChoir();
    for (let i = 0; i < 5; i++) setTimeout(() => pulse(i === 4 ? 1.2 : 1), i * 1100 + 50);
    $(root, ".pr-play").classList.add("on");
    setTimeout(() => $(root, ".pr-play").classList.remove("on"), seconds * 1000);
  };

  $(root, ".pr-clap").onclick = async () => {
    sound._ensure();
    await sound.ctx.resume();
    await refreshImpulses();
    sound.choose(active);
    field.clear();
    await sound.clap();
    pulse(1.4);
  };

  let micTimer = 0;
  $(root, ".pr-mic").onclick = async () => {
    const btn = $(root, ".pr-mic");
    if (sound.mic) {
      sound.stopMic(); clearInterval(micTimer);
      btn.textContent = "Sing into the room"; btn.classList.remove("live");
      return;
    }
    try {
      await refreshImpulses();
      await sound.startMic();
      sound.choose(active);
      btn.textContent = "Stop singing"; btn.classList.add("live");
      // Send a ripple into the picture on every onset in your voice.
      const an = sound.ctx.createAnalyser();
      an.fftSize = 512;
      sound.mic.gain.connect(an);
      const buf = new Float32Array(an.fftSize);
      let last = 0, lastPulse = 0;
      micTimer = setInterval(() => {
        an.getFloatTimeDomainData(buf);
        let e = 0; for (const v of buf) e += v * v;
        const rms = Math.sqrt(e / buf.length);
        const now = performance.now();
        if (rms > 0.03 && rms > last * 1.8 && now - lastPulse > 220) { pulse(clamp(rms * 8, 0.4, 1.5)); lastPulse = now; }
        last = last * 0.7 + rms * 0.3;
      }, 30);
    } catch (err) {
      $(root, ".pr-seat-line").textContent = `The microphone isn't available: ${err.message}`;
    }
  };

  $(root, ".pr-other").onchange = (e) => {
    slotRoom[1] = Number(e.target.value);
    if (active === 1) loadField();
    renderAll(); refreshImpulses();
  };
  root.querySelectorAll("[data-slot]").forEach((b) => {
    b.onclick = () => {
      active = Number(b.dataset.slot);
      sound.choose(active);
      loadField(); renderAll(); refreshImpulses();
    };
  });

  // ---------------------------------------------------------------- clap meter

  $(root, ".pr-listen").onclick = async () => {
    const btn = $(root, ".pr-listen"), out = $(root, ".pr-measure-out");
    if (sound.mic) $(root, ".pr-mic").click();
    btn.disabled = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      await ctx.resume();
      const src = ctx.createMediaStreamSource(stream);
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      const chunks = [];
      proc.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      const mute = ctx.createGain(); mute.gain.value = 0;
      src.connect(proc).connect(mute).connect(ctx.destination);
      let left = 5;
      out.textContent = "Listening. Wait a second, then clap once, sharply. Stay quiet after.";
      const tick = setInterval(() => { left -= 1; if (left > 0) btn.textContent = `Listening… ${left}`; }, 1000);
      btn.textContent = "Listening… 5";
      await new Promise((r) => setTimeout(r, 5000));
      clearInterval(tick);
      proc.disconnect(); src.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      const all = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
      let o = 0; chunks.forEach((c) => { all.set(c, o); o += c.length; });
      const sr = ctx.sampleRate;
      ctx.close();
      const r = measureDecay(all, sr);
      if (r.error) { out.textContent = r.error; drawDecay(null); }
      else {
        measured = r;
        out.innerHTML = `This room rings for <b>${fmtS(r.rt)}</b> (${r.method}, average of 500 Hz and 1 kHz). Early decay ${fmtS(r.edt)}. The clap stood ${Math.round(r.rangeDb)} dB above the background${r.rangeDb < 35 ? ", so treat this as rough" : ""}.`;
        drawDecay(r.curves);
        compareModel();
      }
    } catch (err) {
      out.textContent = `The microphone isn't available: ${err.message}`;
    }
    btn.disabled = false;
    btn.textContent = "Measure again";
  };

  function drawDecay(c) {
    const cv = $(root, ".pr-decay");
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = cv.clientWidth || 420, h = cv.clientHeight || 220;
    cv.width = w * dpr; cv.height = h * dpr;
    const g = cv.getContext("2d");
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, h);
    const pad = 34;
    g.strokeStyle = "rgba(243,236,225,0.25)"; g.lineWidth = 1;
    g.font = '11px "DM Sans", sans-serif'; g.fillStyle = "rgba(243,236,225,0.7)";
    for (let d = 0; d >= -60; d -= 20) {
      const y = pad / 2 + (-d / 60) * (h - pad * 1.5);
      g.beginPath(); g.moveTo(pad, y); g.lineTo(w - 8, y); g.stroke();
      g.fillText(`${d} dB`, 0, y + 4);
    }
    if (!c) return;
    const tMax = Math.max(c.db.length * c.dt, 0.5);
    const X = (t) => pad + (t / tMax) * (w - pad - 8);
    const Y = (d) => pad / 2 + (clamp(-d, 0, 60) / 60) * (h - pad * 1.5);
    const line = (arr, color, width) => {
      g.strokeStyle = color; g.lineWidth = width; g.beginPath();
      arr.forEach((v, i) => (i ? g.lineTo(X(i * c.dt), Y(v)) : g.moveTo(X(0), Y(v))));
      g.stroke();
    };
    line(c.db, "rgba(232,163,176,0.55)", 1);
    line(c.schDb, "#f3d27a", 2.5);
    g.strokeStyle = "#f3ece1"; g.setLineDash([5, 4]); g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(X(0), Y(c.fit.b)); g.lineTo(X(-60 / c.fit.slope), Y(-60)); g.stroke(); g.setLineDash([]);
    g.fillStyle = "rgba(243,236,225,0.7)";
    g.fillText(`${tMax.toFixed(1)} s`, w - 34, h - 4);
  }

  async function compareModel() {
    const box = root.querySelector(".pr-model");
    const q = new URLSearchParams({ audience: 0, use: "a_cappella_performance" });
    box.querySelectorAll("[data-k]").forEach((el) => q.set(el.dataset.k, el.value));
    const ft = (k) => Number(q.get(k));
    q.set("area_sqft", String(ft("width_ft") * ft("depth_ft")));
    try {
      const a = await (await fetch(`/api/acoustics?${q}`)).json();
      const est = a.rt60_empty_s;
      const line = `Our model says <b>${fmtS(est)}</b> for an empty room like this.`;
      $(root, ".pr-model-out").innerHTML = measured
        ? `${line} You measured ${fmtS(measured.rt)}, so we're ${Math.abs(Math.round((100 * (est - measured.rt)) / measured.rt))}% ${est > measured.rt ? "high" : "low"}.`
        : `${line} Measure the room to see how close it is.`;
    } catch { /* offline */ }
  }
  root.querySelectorAll(".pr-model [data-k]").forEach((el) => (el.onchange = compareModel));
  root.querySelector(".pr-model").addEventListener("toggle", compareModel);

  // ---------------------------------------------------------------- lifecycle

  new IntersectionObserver((entries) => {
    visible = entries[0].isIntersecting;
    if (visible && field.ready && (field.pulses.length || field.time < field.rt60)) kick();
  }).observe(root);
  // The venue page can start hidden (display: none), so size the stage whenever it gets a width.
  let lastW = 0;
  new ResizeObserver(() => {
    const w = root.querySelector(".pr-stage").clientWidth;
    if (w && w !== lastW) { lastW = w; size(); paint(); }
  }).observe(root);
  drawDecay(null);

  return {
    /** rooms: [{ label, acoustics }], the first is the current pick. */
    load(list, crowdMode = "full") {
      const same = rooms[0]?.acoustics === list[0]?.acoustics && crowd === crowdMode;
      rooms = list.filter((r) => r.acoustics?.dims_m);
      crowd = crowdMode;
      if (!rooms.length) return;
      if (!same) { irCache.clear(); active = 0; sound.ctx && sound.choose(0); }
      slotRoom = [0, Math.min(1, rooms.length - 1)];
      root.hidden = false;
      loadField(); renderAll(); refreshImpulses();
    },
  };
}
