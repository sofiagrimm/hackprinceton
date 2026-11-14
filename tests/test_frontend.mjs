// Checks on the browser-side signal processing that runs without a browser.
//     node tests/test_frontend.mjs
import assert from "node:assert/strict";
import { measureDecay } from "../frontend/playroom.js";

// Seeded generator so every run hears the same "room" (mulberry32).
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function syntheticClap(rt, sr = 48000, noise = 0.003, at = 0.8, seconds = 5, seed = 1) {
  const rand = rng(seed);
  const x = new Float32Array(sr * seconds);
  for (let i = 0; i < x.length; i++) {
    const t = i / sr - at;
    // Background noise and the room's decay are independent, so they add in energy, not amplitude.
    x[i] = (rand() * 2 - 1) * noise + (t >= 0 ? (rand() * 2 - 1) * 0.9 * Math.exp((-6.91 * t) / rt) : 0);
  }
  return x;
}

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log("ok  ", name); } catch (e) { failed++; console.log("FAIL", name, "-", e.message); }
};

for (const rt of [0.6, 1.2, 2.5]) {
  check(`clap measurement recovers a ${rt}s room within 10%`, () => {
    const r = measureDecay(syntheticClap(rt), 48000);
    assert.ok(!r.error, r.error);
    assert.ok(Math.abs(r.rt - rt) / rt < 0.1, `measured ${r.rt.toFixed(2)}s`);
  });
}

check("a clap buried in noise is refused, not guessed", () => {
  const r = measureDecay(syntheticClap(1.2, 48000, 0.5), 48000);
  assert.ok(r.error);
});

check("silence is refused", () => {
  const r = measureDecay(new Float32Array(48000 * 3), 48000);
  assert.ok(r.error);
});

process.exit(failed ? 1 : 0);
