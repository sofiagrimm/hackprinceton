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
