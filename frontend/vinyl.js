// The hero: two black records with cream labels on warm paper.
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
function renderDisc(size, { seed = 1, marble = 0.6, hue = [22, 20, 20] } = {}) {
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
      img.data[i] = hue[0] * shade + 4;
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
    ctx.strokeStyle = gap ? "rgba(255,255,255,0.10)" : (r % 3.2 < 1.6 ? "rgba(0,0,0,0.30)" : "rgba(255,255,255,0.05)");
    ctx.lineWidth = gap ? 2.2 : 0.8;
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
    left: { tex: null, label: null, angle: 0.4, seed: 7, marble: 0.15, color: "#7a2b35", title: "Side B" },
    right: { tex: null, label: null, angle: 2.1, seed: 21, marble: 0.1, color: "#ece4d4", title: "Limited Edition" },
  };
  let speed = 0.12, boost = 0, scroll = 0, W = 0, H = 0, dpr = 1;

  function layout() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = root.clientWidth; H = root.clientHeight;
    if (!W || !H) return; // the hero is on a view that isn't showing
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
    const narrow = W < 760;
    const rl = narrow ? W * 0.3 : Math.min(W * 0.13, H * 0.24);
    const rr = narrow ? W * 0.42 : Math.min(W * 0.2, H * 0.36);
    discs.left.r = rl; discs.left.x = narrow ? -rl * 0.3 : W * 0.05; discs.left.y = narrow ? H * 0.06 : H * 0.2;
    discs.right.r = rr; discs.right.x = narrow ? W - rr * 0.45 : W - rr * 0.62; discs.right.y = narrow ? H - rr * 0.35 : H - rr * 0.5;
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
    if (photo.complete && photo.naturalWidth) {
      // The photographed record, cut out along its rim. Its own label stays as printed.
      const w = photo.naturalWidth, s = R / (PHOTO.r * w);
      ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.clip();
      ctx.drawImage(photo, -PHOTO.cx * w * s, -PHOTO.cy * photo.naturalHeight * s, w * s, photo.naturalHeight * s);
      ctx.restore();
      drawSheen(d);
      return;
    }
    ctx.drawImage(d.tex, -R, -R, R * 2, R * 2);
    // Label: printed paper, cream on the big record and wine on the small one.
    const lr = R * 0.34;
    ctx.save();
    ctx.beginPath(); ctx.arc(0, 0, lr, 0, Math.PI * 2); ctx.clip();
    ctx.fillStyle = d.color;
    ctx.fillRect(-lr, -lr, lr * 2, lr * 2);
    const ink = d.color === "#ece4d4" ? "rgba(29,27,22,0.86)" : "rgba(239,232,220,0.9)";
    ctx.fillStyle = ink; ctx.strokeStyle = ink;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.font = `600 ${Math.max(8, lr * 0.15)}px "DM Sans", Helvetica, sans-serif`;
    ctx.fillText(String(d.title).toUpperCase().split("").join("\u200a"), 0, -lr * 0.42);
    ctx.font = `${Math.max(6, lr * 0.07)}px "Special Elite", Courier, monospace`;
    const lines = d.lines || ["1. Sound check", "2. Full house", "3. Encore"];
    lines.forEach((t, k) => { ctx.textAlign = "left"; ctx.fillText(t, -lr * 0.72, -lr * 0.12 + k * lr * 0.12); });
    ctx.textAlign = "center";
    ctx.fillText("BACKSTAGE SPACES", 0, lr * 0.62);
    ctx.lineWidth = Math.max(0.6, lr * 0.008);
    ctx.beginPath(); ctx.arc(0, 0, lr * 0.93, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
    // Spindle hole.
    ctx.beginPath(); ctx.arc(0, 0, R * 0.022, 0, Math.PI * 2); ctx.fillStyle = "#efe6dc"; ctx.fill();
    ctx.restore();
    drawSheen(d);
  }

  const still = window.matchMedia("(prefers-reduced-motion: reduce)");
  // The licensed record photo. Where the disc sits in the photo, as fractions of its width.
  const PHOTO = { src: "img/record.jpg", cx: 0.5, cy: 0.497, r: 0.488 };
  const photo = new Image();
  photo.src = PHOTO.src;
  function drawSheen(d) {
    const R = d.r;
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
    const idle = still.matches ? 0 : speed;
    discs.left.angle += dt * (idle + boost) * 0.8;
    discs.right.angle -= dt * (idle + boost);
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

  return {
    /** Same surface as the old 3D hero, so the rest of the app doesn't care which one runs. */
    async showVenue(site, imageUrl, photoUrl) {
      if (site?.name) {
        discs.right.title = site.name.length > 22 ? site.name.slice(0, 21) + "." : site.name;
        discs.right.lines = ["1. " + (site.name.split(",")[0]).slice(0, 18), "2. Full house", "3. Encore"];
      }
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
