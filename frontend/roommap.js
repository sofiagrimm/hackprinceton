// Where to stand: a floor plan of the room coloured by how clear the music is at each seat.
//
// The singers stand near one short wall. For every point on the floor we work
// out the clarity index C80 from Barron's revised theory (direct sound plus
// early reflections against the late reverberant tail), using the room's own
// volume and reverberation time. Close to the singers the direct sound wins and
// everything is crisp; far back the reverberation takes over and lines blur.
// We shade the zone where C80 sits in the range that suits the chosen use.

// Ideal clarity (C80, dB) for each use; the best seats sit within 1.5 dB of it.
const IDEAL = {
  a_cappella_performance: 1,
  choral_performance: -1,
  rehearsal: 4,
  recording: 6,
  film_dialogue: 8,
  amplified_show: 3,
};

export function barronC80(rt, volume, r) {
  rt = Math.max(rt, 0.05);
  const direct = 100 / Math.max(r, 1) ** 2;
  const refl = (31200 * rt / volume) * Math.exp((-0.04 * r) / rt);
  const early = refl * (1 - Math.exp(-1.11 / rt));
  const late = refl * Math.exp(-1.11 / rt);
  return 10 * Math.log10((direct + early) / Math.max(late, 1e-9));
}

/** Draws the map and returns a sentence about where the good seats are. */
export function drawRoomMap(canvas, a) {
  const dims = a.dims_m || {};
  const L = Math.max(dims.length || 10, 3), W = Math.max(dims.width || 8, 3);
  const rt = a.rt60_occupied_s, V = a.volume_m3;
  const ideal = IDEAL[a.use] ?? 1;
  const lo = ideal - 1.5, hi = ideal + 1.5;

  const cssW = canvas.clientWidth || 900;
  const scale = Math.min((cssW - 40) / L, 420 / W);
  const pw = L * scale, ph = W * scale, pad = 20;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = (pw + pad * 2) * dpr;
  canvas.height = (ph + pad * 2 + 28) * dpr;
  canvas.style.height = `${ph + pad * 2 + 28}px`;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const sx = 0.12 * L, sy = W / 2;
  const step = Math.max(L, W) / 70;
  let goodNear = Infinity, goodFar = 0, goodCount = 0, total = 0;
  for (let x = step / 2; x < L; x += step) {
    for (let y = step / 2; y < W; y += step) {
      const r = Math.hypot(x - sx, y - sy);
      if (r < 1.0 || x < sx) continue; // where the singers stand
      const c80 = barronC80(rt, V, r);
      total++;
      let color;
      if (c80 >= lo && c80 <= hi) {
        // best seats: brightest green at the ideal, fading to the edges of the band
        const t = 1 - Math.abs(c80 - ideal) / 1.5;
        color = `rgba(48, 209, 88, ${0.45 + 0.5 * t})`;
        goodCount++;
        goodNear = Math.min(goodNear, r);
        goodFar = Math.max(goodFar, r);
      } else if (c80 > hi) {
        // closer than ideal: very present, a little dry
        const t = Math.min(1, (c80 - hi) / 5);
        color = `rgba(41, 151, 255, ${0.3 + 0.55 * t})`;
      } else {
        // further than ideal: the room takes over
        const t = Math.min(1, (lo - c80) / 3);
        color = `rgba(255, 159, 10, ${0.3 + 0.55 * t})`;
      }
      ctx.fillStyle = color;
      ctx.fillRect(pad + (x - step / 2) * scale, pad + (y - step / 2) * scale, step * scale + 0.5, step * scale + 0.5);
    }
  }

  // Walls
  ctx.strokeStyle = "#f5f5f7";
  ctx.lineWidth = 2;
  ctx.strokeRect(pad, pad, pw, ph);
  // Singers: a shallow arc
  ctx.fillStyle = "#f5f5f7";
  for (let i = -3; i <= 3; i++) {
    const ang = (i / 3) * 0.6;
    const px = pad + (sx - Math.cos(ang) * 0.9 + 0.9) * scale;
    const py = pad + (sy + Math.sin(ang) * Math.min(W * 0.3, 3)) * scale;
    ctx.beginPath();
    ctx.arc(px, py, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  // Scale bar
  ctx.fillStyle = "#86868b";
  ctx.font = "12px -apple-system, Helvetica, Arial, sans-serif";
  const meters = L > 30 ? 10 : 5;
  ctx.fillRect(pad, ph + pad + 14, meters * scale, 2);
  ctx.fillText(`${meters} m`, pad + meters * scale + 8, ph + pad + 19);
  ctx.fillText(`${(L * 3.281).toFixed(0)} x ${(W * 3.281).toFixed(0)} ft`, pad + pw - 70, ph + pad + 19);

  if (!goodCount) {
    const c80Back = barronC80(rt, V, L * 0.85);
    return c80Back < lo
      ? "No seat is in the sweet spot: the reverberation swamps the music everywhere past the front rows."
      : "The whole room is very clear. Good for speech; music will sound dry.";
  }
  const ft = (m) => Math.round(m * 3.281);
  const share = Math.round((100 * goodCount) / total);
  return `The sweet spot runs from about ${ft(goodNear)} to ${ft(goodFar)} feet from the singers, about ${share}% of the floor.`;
}
