// Hear the room: auralization in the browser with the Web Audio API.
//
// We turn the acoustics engine's RT60 estimate into a synthetic impulse
// response (the "sound" of a clap in that room) and run a dry source through
// it with a ConvolverNode. The impulse response is exponentially decaying noise:
// it falls 60 dB in RT60 seconds, high frequencies die sooner than lows (as in
// real rooms, where air and soft surfaces eat the treble), and a few early
// reflections arrive first, spaced by the room's size.
//
// Two sources: a synthesized four-part a cappella chord progression (no audio
// files needed) and the user's own microphone.

export class RoomSound {
  constructor() {
    this.ctx = null;
    this.voices = [];
    this.mic = null;
    this.room = { rt60: 1.5, volume: 500 };
  }

  _ensure() {
    if (this.ctx) return;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.convolver = ctx.createConvolver();
    this.master = ctx.createGain();
    this.master.gain.value = 0.8;
    this.input.connect(this.dry).connect(this.master);
    this.input.connect(this.convolver).connect(this.wet).connect(this.master);
    this.master.connect(ctx.destination);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.master.connect(this.analyser);
    this.setRoom(this.room.rt60, this.room.volume);
  }

  /**
   * Rebuild the impulse response for a room.
   * detail (optional): { bands: [RT60 per octave 125..4k], dims: {length, width, height} in metres }
   */
  setRoom(rt60, volumeM3 = 500, detail = null) {
    this.room = { rt60, volume: volumeM3, detail };
    if (!this.ctx) return;
    this.convolver.buffer = detail?.bands && detail?.dims
      ? makeRoomImpulse(this.ctx, detail.bands, detail.dims)
      : makeImpulse(this.ctx, rt60, volumeM3);
    // Bigger, livelier rooms put more of the sound in the reverberant field.
    const wet = Math.min(0.85, 0.25 + rt60 * 0.22);
    this.wet.gain.setTargetAtTime(wet, this.ctx.currentTime, 0.05);
    this.dry.gain.setTargetAtTime(1 - wet * 0.6, this.ctx.currentTime, 0.05);
  }

  async playChoir() {
    this._ensure();
    await this.ctx.resume();
    this.stopChoir();
    const t0 = this.ctx.currentTime + 0.05;
    // I - vi - IV - V - I in C, SATB voicings (MIDI note numbers).
    const chords = [
      [48, 55, 64, 72], [45, 57, 64, 72], [41, 57, 65, 72], [43, 55, 62, 71], [48, 55, 64, 72],
    ];
    const vowels = ["ah", "oh", "ah", "ee", "ah"];
    const dur = 1.3; // an unhurried choral tempo
    chords.forEach((chord, i) => {
      chord.forEach((note, v) => {
        // legato: each chord swells into the next instead of stopping short
        const len = i === chords.length - 1 ? dur * 2.4 : dur * 1.04;
        this.voices.push(sing(this.ctx, this.input, midiToHz(note), t0 + i * dur, len, vowels[i], v));
      });
    });
    return (chords.length + 1.4) * dur;
  }

  stopChoir() {
    this.voices.forEach((stop) => stop());
    this.voices = [];
  }

  async startMic() {
    this._ensure();
    await this.ctx.resume();
    if (this.mic) return true;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const src = this.ctx.createMediaStreamSource(stream);
    const gain = this.ctx.createGain();
    gain.gain.value = 0.9;
    src.connect(gain).connect(this.input);
    this.mic = { stream, src, gain };
    return true;
  }

  stopMic() {
    if (!this.mic) return;
    this.mic.stream.getTracks().forEach((t) => t.stop());
    this.mic.gain.disconnect();
    this.mic = null;
  }

  /** A clap through the room, to hear the decay on its own. */
  async clap() {
    this._ensure();
    await this.ctx.resume();
    const len = Math.floor(this.ctx.sampleRate * 0.02);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (len / 5));
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.input);
    src.start();
  }
}

function midiToHz(n) {
  return 440 * Math.pow(2, (n - 69) / 12);
}

// Sung-vowel formants for each voice type: [frequency Hz, level dB, bandwidth Hz] x 5.
// From the classic choral formant tables (bass, tenor, alto, soprano).
const VOWELS = {
  a: [
    [[600, 0, 60], [1040, -7, 70], [2250, -9, 110], [2450, -9, 120], [2750, -20, 130]],
    [[650, 0, 80], [1080, -6, 90], [2650, -7, 120], [2900, -8, 130], [3250, -22, 140]],
    [[800, 0, 80], [1150, -4, 90], [2800, -20, 120], [3500, -36, 130], [4950, -60, 140]],
    [[800, 0, 80], [1150, -6, 90], [2900, -32, 120], [3900, -20, 130], [4950, -50, 140]],
  ],
  o: [
    [[400, 0, 40], [750, -11, 80], [2400, -21, 100], [2600, -20, 120], [2900, -40, 120]],
    [[400, 0, 40], [800, -10, 80], [2600, -12, 100], [2800, -12, 120], [3000, -26, 120]],
    [[450, 0, 70], [800, -9, 80], [2830, -16, 100], [3500, -28, 130], [4950, -55, 135]],
    [[450, 0, 70], [800, -11, 80], [2830, -22, 100], [3800, -22, 130], [4950, -50, 135]],
  ],
  u: [
    [[350, 0, 40], [600, -20, 80], [2400, -32, 100], [2675, -28, 120], [2950, -36, 120]],
    [[350, 0, 40], [600, -20, 60], [2700, -17, 100], [2900, -14, 120], [3300, -26, 120]],
    [[325, 0, 50], [700, -12, 60], [2530, -30, 170], [3500, -40, 180], [4950, -64, 200]],
    [[325, 0, 50], [700, -16, 60], [2700, -35, 170], [3800, -40, 180], [4950, -60, 200]],
  ],
};
const VOWEL_OF = { ah: "a", oh: "o", ee: "u" }; // a warm "oo" instead of a bright "ee"
const SINGERS = 4; // voices per part, so each line sounds like a section, not a synth

// A softer source than a raw sawtooth: harmonics fall off faster, like a relaxed voice.
const waveCache = new WeakMap();
function voiceWave(ctx) {
  if (waveCache.has(ctx)) return waveCache.get(ctx);
  const n = 48, re = new Float32Array(n), im = new Float32Array(n);
  for (let k = 1; k < n; k++) im[k] = 1 / Math.pow(k, 1.55);
  const w = ctx.createPeriodicWave(re, im);
  waveCache.set(ctx, w);
  return w;
}

const breathCache = new WeakMap();
function breathBuffer(ctx) {
  if (breathCache.has(ctx)) return breathCache.get(ctx);
  const len = ctx.sampleRate * 2, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  breathCache.set(ctx, buf);
  return buf;
}

/**
 * One chord tone for one part, sung by a small section: a few singers slightly out of tune
 * with each other, each with their own vibrato and timing, through that voice type's vowel.
 * voiceIndex: 0 bass, 1 tenor, 2 alto, 3 soprano.
 */
function sing(ctx, dest, hz, start, len, vowel, voiceIndex) {
  const formants = VOWELS[VOWEL_OF[vowel] || "a"][voiceIndex];
  // the vowel: five resonances in parallel, then a gentle top cut
  const bus = ctx.createGain();
  const out = ctx.createGain();
  out.gain.value = 7.8; // about as loud as the old synth, so nothing else needs re-levelling
  const air = ctx.createBiquadFilter();
  air.type = "lowpass";
  air.frequency.value = voiceIndex >= 2 ? 5200 : 4200;
  formants.forEach(([f, db, bw]) => {
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = f;
    bp.Q.value = f / bw;
    const g = ctx.createGain();
    g.gain.value = Math.pow(10, db / 20);
    bus.connect(bp).connect(g).connect(out);
  });
  out.connect(air).connect(dest);

  const level = [0.2, 0.15, 0.14, 0.13][voiceIndex] / Math.sqrt(SINGERS);
  const end = start + len;
  const nodes = [];
  for (let s = 0; s < SINGERS; s++) {
    const osc = ctx.createOscillator();
    osc.setPeriodicWave(voiceWave(ctx));
    osc.frequency.value = hz;
    osc.detune.value = (Math.random() - 0.5) * 22; // a section is never perfectly in tune
    // vibrato that blooms after the note settles, each singer at their own speed
    const vib = ctx.createOscillator();
    vib.frequency.value = 4.6 + Math.random() * 1.2;
    const vibAmt = ctx.createGain();
    const onset = start + Math.random() * 0.07;
    vibAmt.gain.setValueAtTime(0, onset);
    vibAmt.gain.linearRampToValueAtTime(hz * (0.005 + Math.random() * 0.004), onset + 0.45 + Math.random() * 0.2);
    vib.connect(vibAmt).connect(osc.frequency);
    // slow pitch drift
    const drift = ctx.createOscillator();
    drift.frequency.value = 0.15 + Math.random() * 0.35;
    const driftAmt = ctx.createGain();
    driftAmt.gain.value = 4 + Math.random() * 4; // cents
    drift.connect(driftAmt).connect(osc.detune);
    // a swell in, a soft release that overlaps the next chord
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, onset);
    env.gain.setTargetAtTime(level, onset, 0.09);
    env.gain.setTargetAtTime(level * 0.85, onset + 0.4, 0.4);
    env.gain.setTargetAtTime(0, end - 0.05, 0.12);
    osc.connect(env).connect(bus);
    [osc, vib, drift].forEach((o) => { o.start(onset); o.stop(end + 0.7); });
    nodes.push(osc, vib, drift);
  }
  // a little breath through the same vowel
  const breath = ctx.createBufferSource();
  breath.buffer = breathBuffer(ctx);
  breath.loop = true;
  const bEnv = ctx.createGain();
  bEnv.gain.setValueAtTime(0, start);
  bEnv.gain.setTargetAtTime(level * 0.18, start, 0.05);
  bEnv.gain.setTargetAtTime(level * 0.06, start + 0.25, 0.2);
  bEnv.gain.setTargetAtTime(0, end - 0.05, 0.1);
  breath.connect(bEnv).connect(bus);
  breath.start(start, Math.random());
  breath.stop(end + 0.6);
  nodes.push(breath);

  return () => {
    nodes.forEach((n) => { try { n.stop(); } catch (_) { /* already stopped */ } });
  };
}

/** Synthetic stereo impulse response for a room with the given RT60. */
export function makeImpulse(ctx, rt60, volumeM3) {
  const sr = ctx.sampleRate;
  const seconds = Math.min(6, Math.max(0.3, rt60 * 1.2));
  const len = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(2, len, sr);
  // Mean free path sets the gap before the first reflections.
  const size = Math.cbrt(Math.max(volumeM3, 20));
  const preDelay = Math.min(0.045, (size * 0.6) / 343);
  const decay = 6.91 / Math.max(rt60, 0.05); // 60 dB = e^-6.91
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      if (t < preDelay) { d[i] = 0; continue; }
      const tt = t - preDelay;
      // Treble dies faster: the low-pass closes as the tail ages.
      const brightness = Math.max(0.08, 0.9 * Math.exp(-tt * (2.2 / Math.max(rt60, 0.2))));
      const noise = Math.random() * 2 - 1;
      lp += brightness * (noise - lp);
      d[i] = lp * Math.exp(-decay * tt);
    }
    // Early reflections from the nearest walls.
    for (let k = 1; k <= 6; k++) {
      const at = Math.floor((preDelay + (k * size * (0.7 + 0.25 * ch)) / 343) * sr);
      if (at < len) d[at] += (ch ? -1 : 1) * 0.5 * Math.exp(-decay * (at / sr)) / k;
    }
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Physically based impulse response for a rectangular room.
//
// Early part: the image-source method (Allen & Berkley, 1979). Every wall is a
// mirror; each mirrored copy of the singers is a reflection that arrives after
// distance / 343 m/s, quieter by 1/distance and by the energy each wall bounce
// absorbs. We go up to third-order reflections.
// Late part: from 80 ms on, the sound field is diffuse, so we use noise split
// into six octave bands, each fading 60 dB over that band's RT60. Low bands
// can ring longer than high ones, exactly as the per-band numbers say.

const OCTAVES = [125, 250, 500, 1000, 2000, 4000];
const C = 343;

export function makeRoomImpulse(ctx, bands, dims) {
  const sr = ctx.sampleRate;
  const rtMax = Math.max(...bands);
  const len = Math.floor(sr * Math.min(6, Math.max(0.4, rtMax * 1.15)));
  const buf = ctx.createBuffer(2, len, sr);
  const L = Math.max(dims.length, 2), W = Math.max(dims.width, 2), H = Math.max(dims.height, 2);
  // Singers near the front, listener 60 % of the way back; ears a little apart for stereo.
  const src = [0.18 * L, 0.5 * W, 1.6];
  const ears = [[0.6 * L, 0.5 * W - 0.09, 1.2], [0.6 * L, 0.5 * W + 0.09, 1.2]];
  const rtMid = (bands[2] + bands[3]) / 2;
  // Mean wall reflection coefficient implied by the mid-band reverberation (Sabine, inverted).
  const V = L * W * H, S = 2 * (L * W + L * H + W * H);
  const alpha = Math.min(0.9, (0.161 * V) / (rtMid * S));
  const refl = Math.sqrt(1 - alpha);

  for (let ch = 0; ch < 2; ch++) {
    const out = buf.getChannelData(ch);
    const [lx, ly, lz] = ears[ch];
    // --- early reflections (image sources up to order 3)
    const N = 3;
    for (let i = -N; i <= N; i++) for (let j = -N; j <= N; j++) for (let k = -N; k <= N; k++) {
      const order = Math.abs(i) + Math.abs(j) + Math.abs(k);
      if (order > N) continue;
      const ix = i % 2 === 0 ? i * L + src[0] : i * L + (L - src[0]);
      const iy = j % 2 === 0 ? j * W + src[1] : j * W + (W - src[1]);
      const iz = k % 2 === 0 ? k * H + src[2] : k * H + (H - src[2]);
      const d = Math.hypot(ix - lx, iy - ly, iz - lz);
      const t = Math.floor((d / C) * sr);
      if (t >= len) continue;
      const amp = Math.pow(refl, order) / Math.max(d, 1);
      // A short smeared click so higher orders sound diffuse rather than like a comb.
      const spread = 1 + order * 6;
      for (let s = 0; s < spread && t + s < len; s++) {
        out[t + s] += (order === 0 ? 1.4 : 1) * amp * (s === 0 ? 1 : (Math.random() * 2 - 1) * 0.35);
      }
    }
    // --- late diffuse tail, band by band
    const start = Math.floor(0.03 * sr);
    const fade = Math.floor(0.08 * sr);
    const tail = new Float32Array(len);
    for (let b = 0; b < OCTAVES.length; b++) {
      const noise = new Float32Array(len);
      for (let s = start; s < len; s++) noise[s] = Math.random() * 2 - 1;
      const filtered = bandpass(noise, OCTAVES[b], sr);
      const decay = 6.91 / Math.max(bands[b], 0.05);
      for (let s = start; s < len; s++) {
        tail[s] += filtered[s] * Math.exp(-decay * (s / sr));
      }
    }
    // Level of the diffuse field relative to the direct sound grows with reverberation.
    const lateGain = 0.06 * Math.sqrt(rtMid) * (10 / Math.max(Math.cbrt(V), 3));
    for (let s = start; s < len; s++) {
      const ramp = Math.min(1, (s - start) / fade);
      out[s] += tail[s] * lateGain * ramp;
    }
  }
  // Normalise so rooms are compared at the same loudness.
  let peak = 0;
  for (let ch = 0; ch < 2; ch++) for (const v of buf.getChannelData(ch)) peak = Math.max(peak, Math.abs(v));
  if (peak > 0) for (let ch = 0; ch < 2; ch++) { const d = buf.getChannelData(ch); for (let s = 0; s < len; s++) d[s] /= peak * 1.2; }
  return buf;
}

/** Second-order band-pass (RBJ cookbook), one octave wide, run forward over the signal. */
export function bandpass(x, f0, sr) {
  const w0 = (2 * Math.PI * f0) / sr;
  const q = Math.SQRT2; // one-octave bandwidth
  const alpha = Math.sin(w0) / (2 * q);
  const b0 = alpha, b2 = -alpha, a0 = 1 + alpha, a1 = -2 * Math.cos(w0), a2 = 1 - alpha;
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let n = 0; n < x.length; n++) {
    const v = (b0 * x[n] + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x[n]; y2 = y1; y1 = v; y[n] = v;
  }
  return y;
}
