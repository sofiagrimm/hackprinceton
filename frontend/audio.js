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

  /** Rebuild the impulse response for a room. */
  setRoom(rt60, volumeM3 = 500) {
    this.room = { rt60, volume: volumeM3 };
    if (!this.ctx) return;
    this.convolver.buffer = makeImpulse(this.ctx, rt60, volumeM3);
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
    const dur = 1.1;
    chords.forEach((chord, i) => {
      chord.forEach((note, v) => {
        const len = i === chords.length - 1 ? dur * 2.2 : dur * 0.92;
        this.voices.push(sing(this.ctx, this.input, midiToHz(note), t0 + i * dur, len, vowels[i], v));
      });
    });
    return (chords.length + 1.2) * dur;
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

// Formant frequencies (Hz) and bandwidths for sung vowels.
const FORMANTS = {
  ah: [[730, 90], [1090, 110], [2440, 170]],
  oh: [[570, 80], [840, 100], [2410, 170]],
  ee: [[300, 70], [2200, 140], [2960, 180]],
};

/** One sung note: sawtooth glottal source + vibrato + vowel formant filters. */
function sing(ctx, dest, hz, start, len, vowel, voiceIndex) {
  const osc = ctx.createOscillator();
  osc.type = "sawtooth";
  osc.frequency.value = hz;
  // Natural vibrato that grows into the note, slightly different per voice.
  const vib = ctx.createOscillator();
  vib.frequency.value = 5.2 + voiceIndex * 0.23;
  const vibAmt = ctx.createGain();
  vibAmt.gain.setValueAtTime(0, start);
  vibAmt.gain.linearRampToValueAtTime(hz * 0.012, start + 0.35);
  vib.connect(vibAmt).connect(osc.frequency);
  osc.detune.value = (Math.random() - 0.5) * 8;

  const env = ctx.createGain();
  const level = [0.22, 0.16, 0.15, 0.14][voiceIndex];
  env.gain.setValueAtTime(0, start);
  env.gain.linearRampToValueAtTime(level, start + 0.09);
  env.gain.setValueAtTime(level, start + len - 0.12);
  env.gain.linearRampToValueAtTime(0, start + len);

  const mix = ctx.createGain();
  mix.gain.value = 1;
  FORMANTS[vowel].forEach(([f, bw], k) => {
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = f;
    bp.Q.value = f / bw;
    const g = ctx.createGain();
    g.gain.value = [1.0, 0.55, 0.25][k] * 6;
    osc.connect(bp).connect(g).connect(mix);
  });
  mix.connect(env).connect(dest);

  osc.start(start);
  vib.start(start);
  osc.stop(start + len + 0.05);
  vib.stop(start + len + 0.05);
  return () => {
    try { osc.stop(); vib.stop(); } catch (_) { /* already stopped */ }
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
