// Sounds for the opening page's collage, made in the browser (no audio files):
//   - the gramophone plays a little ragtime tune as if from a worn 78: a slightly out-of-tune
//     upright piano, squeezed through a horn (a narrow band), with surface crackle and a wobble;
//   - the camera makes a mechanical shutter click and a short film-advance whirr.

let ctx = null;
function audio() {
  ctx ||= new (window.AudioContext || window.webkitAudioContext)();
  return ctx;
}

const hz = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

// A ragtime-ish tune in C: melody (midi, beats) over an oom-pah bass (root, chord) per bar.
const MELODY = [
  [72, 0.5], [76, 0.5], [79, 0.5], [76, 0.5], [77, 0.75], [76, 0.25], [74, 1],
  [71, 0.5], [74, 0.5], [77, 0.5], [74, 0.5], [76, 0.75], [74, 0.25], [72, 1],
  [72, 0.5], [76, 0.5], [79, 0.5], [81, 0.5], [79, 0.5], [76, 0.5], [77, 0.5], [74, 0.5],
  [72, 0.5], [71, 0.5], [74, 0.5], [79, 0.5], [76, 1], [72, 1],
];
const BARS = [
  [48, [64, 67, 72]], [43, [65, 67, 71]], [43, [65, 67, 71]], [48, [64, 67, 72]],
  [45, [64, 69, 72]], [41, [65, 69, 72]], [43, [65, 67, 71]], [48, [64, 67, 72]],
];
const BEAT = 0.3; // seconds: a lively two-step

/** One piano note: two slightly detuned strings, a hard attack and a long fall. */
function piano(dest, midi, t, len, vel) {
  const c = audio();
  const out = c.createGain();
  out.gain.setValueAtTime(0, t);
  out.gain.linearRampToValueAtTime(vel, t + 0.005);
  out.gain.exponentialRampToValueAtTime(vel * 0.35, t + 0.18);
  out.gain.exponentialRampToValueAtTime(0.0005, t + len + 0.6);
  out.connect(dest);
  const nodes = [];
  for (const cents of [-9, 7]) { // the honky-tonk: two strings never quite agree
    for (const [mult, amp, type] of [[1, 1, "triangle"], [2, 0.35, "sine"], [3, 0.12, "sine"]]) {
      const o = c.createOscillator();
      o.type = type;
      o.frequency.value = hz(midi) * mult;
      o.detune.value = cents;
      const g = c.createGain();
      g.gain.value = amp * 0.5;
      o.connect(g).connect(out);
      o.start(t);
      o.stop(t + len + 0.7);
      nodes.push(o);
    }
  }
  return nodes;
}

/** The gramophone: returns stop(). */
export function playGramophone(onEnd) {
  const c = audio();
  c.resume();
  // the horn: a narrow, nasal band, plus a little saturation
  const horn = c.createBiquadFilter(); horn.type = "bandpass"; horn.frequency.value = 1400; horn.Q.value = 0.9;
  const low = c.createBiquadFilter(); low.type = "highpass"; low.frequency.value = 280;
  const high = c.createBiquadFilter(); high.type = "lowpass"; high.frequency.value = 3600;
  const shaper = c.createWaveShaper();
  const curve = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) { const x = i / 512 - 1; curve[i] = Math.tanh(2.2 * x); }
  shaper.curve = curve;
  const master = c.createGain();
  master.gain.setValueAtTime(0, c.currentTime);
  master.gain.linearRampToValueAtTime(0.55, c.currentTime + 0.4);
  // the wobble of a warped record: a slow delay modulation bends every pitch a little
  const wow = c.createDelay(0.05); wow.delayTime.value = 0.012;
  const lfo = c.createOscillator(); lfo.frequency.value = 0.55;
  const lfoAmt = c.createGain(); lfoAmt.gain.value = 0.0025;
  lfo.connect(lfoAmt).connect(wow.delayTime);
  lfo.start();
  const bus = c.createGain();
  bus.connect(wow).connect(low).connect(horn).connect(shaper).connect(high).connect(master).connect(c.destination);

  // surface noise: a soft hiss with random pops
  const len = c.sampleRate * 2, buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    d[i] = (Math.random() * 2 - 1) * 0.018 + (Math.random() < 0.0009 ? (Math.random() * 2 - 1) * 0.6 : 0);
  }
  const crackle = c.createBufferSource(); crackle.buffer = buf; crackle.loop = true;
  const crackleTone = c.createBiquadFilter(); crackleTone.type = "bandpass"; crackleTone.frequency.value = 2500; crackleTone.Q.value = 0.6;
  crackle.connect(crackleTone).connect(master);
  crackle.start();

  let nodes = [], stopped = false, timer = null;
  // a short phrase, played once: the first two bars and a closing chord (about 3 seconds)
  const t0 = c.currentTime + 0.15;
  const SHORT = MELODY.slice(0, 7); // four beats of tune
  BARS.slice(0, 2).forEach(([root, chord], bar) => {
    const t = t0 + bar * 2 * BEAT;
    nodes.push(...piano(bus, root, t, BEAT * 0.9, 0.22));
    chord.forEach((m) => nodes.push(...piano(bus, m, t + BEAT, BEAT * 0.6, 0.09)));
  });
  let t = t0;
  SHORT.forEach(([m, beats]) => { nodes.push(...piano(bus, m, t, beats * BEAT * 0.9, 0.2)); t += beats * BEAT; });
  [48, 64, 67, 72].forEach((m) => nodes.push(...piano(bus, m, t, BEAT * 2.5, 0.16))); // the tonic, to end
  const total = t - c.currentTime + BEAT * 2.5 + 0.6;
  timer = setTimeout(() => { stop(); onEnd?.(); }, total * 1000);

  return stop;

  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    const now = c.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(master.gain.value, now);
    master.gain.linearRampToValueAtTime(0, now + 0.25);
    setTimeout(() => {
      nodes.forEach((n) => { try { n.stop(); } catch { /* already done */ } });
      try { crackle.stop(); lfo.stop(); } catch { /* already done */ }
      master.disconnect();
    }, 320);
  };
}

/** A camera shutter: two sharp clicks and a short film-advance whirr. */
export function playShutter() {
  const c = audio();
  c.resume();
  const t = c.currentTime + 0.01;
  const out = c.createGain(); out.gain.value = 0.9; out.connect(c.destination);
  const noise = (dur) => {
    const n = Math.floor(c.sampleRate * dur), b = c.createBuffer(1, n, c.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    const s = c.createBufferSource(); s.buffer = b; return s;
  };
  const click = (at, freq, level) => {
    const s = noise(0.05);
    const f = c.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = freq; f.Q.value = 1.4;
    const g = c.createGain();
    g.gain.setValueAtTime(level, at);
    g.gain.exponentialRampToValueAtTime(0.001, at + 0.04);
    s.connect(f).connect(g).connect(out);
    s.start(at); s.stop(at + 0.05);
    // the body of the camera rings for an instant
    const o = c.createOscillator(); o.type = "square"; o.frequency.value = freq / 3.2;
    const og = c.createGain();
    og.gain.setValueAtTime(level * 0.12, at);
    og.gain.exponentialRampToValueAtTime(0.001, at + 0.03);
    o.connect(og).connect(out); o.start(at); o.stop(at + 0.04);
  };
  click(t, 3200, 1.0);         // shutter opens
  click(t + 0.075, 2400, 0.8); // and closes
  // film advance: a ratchety whirr
  const w = noise(0.32);
  const wf = c.createBiquadFilter(); wf.type = "bandpass"; wf.frequency.value = 1100; wf.Q.value = 3;
  const wg = c.createGain();
  const start = t + 0.2;
  wg.gain.setValueAtTime(0, start);
  for (let k = 0; k < 9; k++) {
    wg.gain.setValueAtTime(0.35, start + k * 0.03);
    wg.gain.setValueAtTime(0.08, start + k * 0.03 + 0.015);
  }
  wg.gain.linearRampToValueAtTime(0, start + 0.3);
  w.connect(wf).connect(wg).connect(out);
  w.start(start); w.stop(start + 0.32);
}
