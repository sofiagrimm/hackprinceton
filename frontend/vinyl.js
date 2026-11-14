// The hero: two cherry-red records and a cassette on warm paper.
//
// Both records are drawn live on a canvas: marbled vinyl, fine grooves, a soft
// sheen that stays put while the disc turns. After a search, the right record's
// label becomes the aerial photo of the top venue and the left one shows the
// building, so the hero always shows the room you're about to hear.

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/** Smooth value noise for the marbling. */
function makeNoise(seed) {
  const r = rng(seed);
  const N = 64, grid = Array.from({ length: N * N }, r);
  const at = (x, y) => grid[((y % N + N) % N) * N + ((x % N + N) % N)];
  const smooth = (t) => t * t * (3 - 2 * t);
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = smooth(x - xi), yf = smooth(y - yi);
    const a = at(xi, yi), b = at(xi + 1, yi), c = at(xi, yi + 1), d = at(xi + 1, yi + 1);
    return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
  };
}

/** Render one record (without its label) to an offscreen canvas. */
function renderDisc(size, { seed = 1, marble = 0.6, hue = [128, 16, 28] } = {}) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(size, size);
  const noise = makeNoise(seed);
  const R = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - R, dy = y - R, d = Math.hypot(dx, dy);
      const i = (y * size + x) * 4;
      if (d > R) { img.data[i + 3] = 0; continue; }
      // Marbling: warped noise swirls dark streaks through the red.
      const u = x / size * 6, v = y / size * 6;
      const w = noise(u + 3 * noise(u * 0.7, v * 0.7), v + 3 * noise(v * 0.6 + 9, u * 0.6));
      const streak = Math.pow(Math.abs(Math.sin(w * 7)), 14) * marble;
      const shade = 0.84 + 0.16 * noise(u * 2.2, v * 2.2) - streak * 0.5;
      img.data[i] = hue[0] * shade + 10;
      img.data[i + 1] = hue[1] * shade;
      img.data[i + 2] = hue[2] * shade;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  // Grooves: hundreds of faint rings, with a few wider gaps between tracks.
  ctx.save();
  ctx.translate(R, R);
  for (let r = R * 0.36; r < R * 0.985; r += 1.6) {
    const gap = Math.sin(r * 0.031) > 0.97;
    ctx.strokeStyle = gap ? "rgba(0,0,0,0.35)" : (r % 3.2 < 1.6 ? "rgba(0,0,0,0.10)" : "rgba(255,255,255,0.035)");
    ctx.lineWidth = gap ? 2 : 0.8;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  // Raised rim and run-out area.
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.lineWidth = R * 0.012;
  ctx.beginPath(); ctx.arc(0, 0, R * 0.993, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
  return c;
}

export function createVinylHero(root) {
  const canvas = document.createElement("canvas");
  canvas.className = "vinyl-canvas";
  root.prepend(canvas);
  const ctx = canvas.getContext("2d");
  const discs = {
    left: { tex: null, label: null, angle: 0.4, seed: 7, marble: 0.7, color: "#3b0b10" },
    right: { tex: null, label: null, angle: 2.1, seed: 21, marble: 0.25, color: "#2a0a0d" },
  };
  let speed = 0.12, boost = 0, scroll = 0, W = 0, H = 0, dpr = 1;

  function layout() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = root.clientWidth; H = root.clientHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
    const narrow = W < 760;
    const rl = narrow ? W * 0.5 : Math.min(W * 0.27, H * 0.5);
    const rr = narrow ? W * 0.55 : Math.min(W * 0.28, H * 0.52);
    discs.left.r = rl; discs.left.x = narrow ? -rl * 0.45 : -rl * 0.38; discs.left.y = narrow ? H * 0.12 : H * 0.34;
    discs.right.r = rr; discs.right.x = narrow ? W + rr * 0.35 : W - rr * 0.3; discs.right.y = narrow ? H * 0.95 : H * 0.9;
    for (const d of Object.values(discs)) {
      const size = Math.round(d.r * 2 * dpr);
      if (!d.tex || d.tex.width !== size) d.tex = renderDisc(size, { seed: d.seed, marble: d.marble });
    }
  }

  function drawDisc(d) {
    const R = d.r;
    ctx.save();
    ctx.translate(d.x, d.y);
    // Soft paper shadow under the record.
    ctx.shadowColor = "rgba(60, 20, 10, 0.25)";
    ctx.shadowBlur = R * 0.08;
    ctx.shadowOffsetY = R * 0.03;
    ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.fillStyle = "#3a0a0f"; ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.rotate(d.angle);
    ctx.drawImage(d.tex, -R, -R, R * 2, R * 2);
    // Label: the venue photo when we have one, else a plain dark label.
    const lr = R * 0.33;
    ctx.save();
    ctx.beginPath(); ctx.arc(0, 0, lr, 0, Math.PI * 2); ctx.clip();
    if (d.label?.complete && d.label.naturalWidth) {
      const s = Math.max((lr * 2) / d.label.naturalWidth, (lr * 2) / d.label.naturalHeight);
      ctx.drawImage(d.label, -d.label.naturalWidth * s / 2, -d.label.naturalHeight * s / 2,
        d.label.naturalWidth * s, d.label.naturalHeight * s);
      ctx.fillStyle = "rgba(60, 10, 15, 0.18)";
      ctx.fillRect(-lr, -lr, lr * 2, lr * 2);
    } else {
      ctx.fillStyle = d.color;
      ctx.fillRect(-lr, -lr, lr * 2, lr * 2);
      ctx.fillStyle = "rgba(239, 230, 220, 0.75)";
      ctx.font = `${Math.max(9, lr * 0.11)}px Georgia, serif`;
      ctx.textAlign = "center";
      ctx.fillText("SIDE A", 0, -lr * 0.55);
    }
    ctx.restore();
    // Spindle hole.
    ctx.beginPath(); ctx.arc(0, 0, R * 0.022, 0, Math.PI * 2); ctx.fillStyle = "#efe6dc"; ctx.fill();
    ctx.restore();
    // Sheen: a fixed highlight that does not turn with the record.
    ctx.save();
    ctx.translate(d.x, d.y);
    ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.clip();
    const g = ctx.createConicGradient(-0.9, 0, 0);
    g.addColorStop(0, "rgba(255,255,255,0)");
    g.addColorStop(0.08, "rgba(255,235,230,0.10)");
    g.addColorStop(0.16, "rgba(255,255,255,0)");
    g.addColorStop(0.5, "rgba(255,255,255,0)");
    g.addColorStop(0.58, "rgba(255,235,230,0.07)");
    g.addColorStop(0.66, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(-R, -R, R * 2, R * 2);
    ctx.restore();
  }

  let last = performance.now();
  let onScreen = true;
  new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; }).observe(root);
  function frame(now) {
    requestAnimationFrame(frame);
    if (!onScreen) { last = now; return; }
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    boost *= Math.pow(0.35, dt);
    discs.left.angle += dt * (speed + boost) * 0.8;
    discs.right.angle -= dt * (speed + boost);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.translate(0, -scroll * H * 0.25);
    drawDisc(discs.left);
    drawDisc(discs.right);
    ctx.restore();
  }

  new ResizeObserver(layout).observe(root);
  layout();
  requestAnimationFrame(frame);

  function loadLabel(which, url) {
    if (!url) return;
    const img = new Image();
    img.onload = () => { discs[which].label = img; };
    img.src = url;
  }

  return {
    /** Same surface as the old 3D hero, so the rest of the app doesn't care which one runs. */
    async showVenue(site, imageUrl, photoUrl) {
      loadLabel("right", imageUrl);
      loadLabel("left", photoUrl);
    },
    setScroll(p) { scroll = Math.max(0, Math.min(1, p)); },
    setSun() {},
    setReverb(rt) { speed = 0.08 + Math.min(rt, 3) * 0.04; },
    pulse(seconds = 3) { boost = Math.max(boost, 2.5 + seconds * 0.2); },
    hitTest(x, y) {
      return Object.entries(discs).find(([, d]) => Math.hypot(x - d.x, y - d.y + scroll * H * 0.25) < d.r)?.[0] || null;
    },
  };
}
