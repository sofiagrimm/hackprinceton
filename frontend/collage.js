// Opening page: scale the 1440 x 810 collage to the screen.
// Wide screens: fill the screen (cover), centred. Narrow screens: fit the width so the name is never cut.
const stage = document.getElementById("collage");
const art = document.getElementById("collage-art");

function fit() {
  if (!stage || !art || !stage.clientWidth) return;
  stage.style.height = "";
  const w = stage.clientWidth, h = stage.clientHeight;
  let s, x = 0, y = 0;
  if (w / h >= 1.2) {
    s = Math.max(w / 1440, h / 810);
    x = (w - 1440 * s) / 2;
    y = (h - 810 * s) / 2;
  } else {
    s = w / 1440;
    stage.style.height = `${Math.round(810 * s)}px`;
    stage.style.minHeight = "0";
  }
  art.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
}

if (stage) {
  new ResizeObserver(fit).observe(stage);
  window.addEventListener("resize", fit);
  fit();
}

// The two staves flow: a slow wave travels along each one, left to right, carrying the notes.
// Each staff image is redrawn onto a canvas in thin columns, each column lifted by a sine
// wave that moves with time. The ends are held still so the staff stays where the design puts it.
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

function flowStaff(img, phase) {
  const W = img.naturalWidth, H = img.naturalHeight;
  const pad = Math.round(H * 0.14);              // room for the wave above and below
  const cssW = parseFloat(img.style.width), cssH = parseFloat(img.style.height);
  const scale = cssH / H;                          // design px per image px
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H + 2 * pad;
  cv.className = img.className;
  cv.setAttribute("aria-hidden", "true");
  // Same matrix as the image; the canvas is taller by the padding, so start it higher by the same amount.
  const m = img.style.transform.match(/matrix\(([^)]+)\)/)[1].split(",").map(Number);
  const [a, b, c, d, e, f] = m;
  const up = pad * scale;
  cv.style.cssText = `transform:matrix(${a},${b},${c},${d},${e - c * up},${f - d * up});width:${cssW}px;height:${cssH + 2 * up}px`;
  img.replaceWith(cv);
  const g = cv.getContext("2d");
  const step = 3, amp = pad * 0.8, wavelength = W / 2.2, period = 5.5;
  function draw(t) {
    g.clearRect(0, 0, cv.width, cv.height);
    for (let x = 0; x < W; x += step) {
      const hold = Math.min(1, x / (W * 0.12), (W - x) / (W * 0.12));   // ends stay put
      const y = pad + amp * hold * Math.sin((2 * Math.PI * x) / wavelength - (2 * Math.PI * t) / period + phase);
      g.drawImage(img, x, 0, step, H, x, y, step, H);
    }
  }
  let running = false;
  function frame(now) {
    draw(now / 1000);
    if (running) requestAnimationFrame(frame);
  }
  function setMotion() {
    const go = !reduceMotion.matches && document.body.dataset.view === "home";
    if (go && !running) { running = true; requestAnimationFrame(frame); }
    if (!go) { running = false; draw(0); }
  }
  setMotion();
  reduceMotion.addEventListener?.("change", setMotion);
  new MutationObserver(setMotion).observe(document.body, { attributes: true, attributeFilter: ["data-view"] });
}

document.querySelectorAll(".collage img.cl-staff").forEach((img, i) => {
  const start = () => flowStaff(img, i * Math.PI * 0.8);
  if (img.complete && img.naturalWidth) start(); else img.addEventListener("load", start, { once: true });
});
