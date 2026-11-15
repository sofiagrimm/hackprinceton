// Ransom-note headings, like the "stagehand" logo: every letter cut from a different magazine.
//
// Each letter gets its own paper tile: near-white paper and faded plum ink (sampled from the logo),
// about one in five inverted, a different font from its neighbours, its own tilt, size and baseline.
// The look is worked out from the letter and its position, so a heading always comes out the same.
// The real words stay on the heading as its accessible name; the tiles are hidden from screen readers.
// Headings whose text changes later (venue names) are re-cut when they change.

// single quotes inside: these go into a double-quoted style attribute
const FONTS = [
  "'Playfair Display', serif", "'IM Fell English', serif", "'Abril Fatface', serif", "'Alfa Slab One', serif",
  "'Special Elite', monospace", "'Syne', sans-serif", "'Old Standard TT', serif", "'Bodoni Moda', serif",
  "'Rozha One', serif", "'Oswald', sans-serif", "'Rubik', sans-serif", "'Cormorant Garamond', serif",
];
const WEIGHT = { "'Syne', sans-serif": 800, "'Oswald', sans-serif": 600, "'Rubik', sans-serif": 800, "'Cormorant Garamond', serif": 700, "'Playfair Display', serif": 800, "'Bodoni Moda', serif": 700 };
const ITALIC = new Set(["'Playfair Display', serif", "'Cormorant Garamond', serif"]);

const SELECTOR = [
  "h1.browse-title", "h1.page-title", "h1.walk-title", "h1.display", "h2.display", "h2.sv-h", "h2.featured-title",
  "h2.ac-h", "h2#plan-title", ".ransom-me",
].join(",");

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rand(seed) {
  let t = seed + 0x6d2b79f5;
  return () => {
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function cut(el, given) {
  // the app replaced the whole heading (textContent = ...): start over from its new text
  if (el.querySelector(":scope > .rn") && !el.querySelector(":scope > .rn-src")) el.querySelector(":scope > .rn").remove();
  [...el.childNodes].forEach((n) => { if (n.nodeType === 3 && n.textContent.trim() && el.querySelector(":scope > .rn-src")) { el.querySelector(":scope > .rn-src").replaceChildren(n); } });
  const text = given || realText(el) || el.textContent.replace(/\s+/g, " ").trim();
  if (!text || el.dataset.ransom === text) return;
  el.dataset.ransom = text;
  const r = rand(hash(text + (el.id || "")));
  let prevFont = -1, i = 0;
  // a heading made of separate lines (e.g. ".sb-line" + ".sb-em") keeps those lines; "\n" marks a break
  const parts = el.querySelectorAll(":scope > .rn-src > .sb-line, :scope > .rn-src > .sb-em, :scope > .sb-line, :scope > .sb-em");
  const lineText = parts.length > 1 ? [...parts].map((p) => p.textContent.replace(/\s+/g, " ").trim()).join(" \n ") : text;
  const words = lineText.toLowerCase().split(" ").filter(Boolean).map((word) => {
    if (word === "\n") return "\n";
    const tiles = [...word].map((ch) => {
      let f;
      do { f = Math.floor(r() * FONTS.length); } while (f === prevFont);
      prevFont = f;
      const font = FONTS[f];
      const inv = r() < 0.2 && /[a-z0-9]/.test(ch);
      const tilt = (r() * 2 - 1) * 7;
      const size = 0.86 + r() * 0.34;
      const lift = (r() * 2 - 1) * 0.07;
      const padX = 0.06 + r() * 0.1, padT = 0.02 + r() * 0.06, padB = 0.06 + r() * 0.08;
      const italic = ITALIC.has(font) && r() < 0.3 ? "italic" : "normal";
      const grey = r() < 0.25;
      const style = `font-family:${font};font-weight:${WEIGHT[font] || 400};font-style:${italic};--t:${tilt.toFixed(1)}deg;`
        + `font-size:${size.toFixed(2)}em;--y:${lift.toFixed(2)}em;padding:${padT.toFixed(2)}em ${padX.toFixed(2)}em ${padB.toFixed(2)}em;`
        + `--d:${(i++ * 0.025).toFixed(3)}s`;
      const cls = `rn-t${inv ? " inv" : grey ? " grey" : ""}${/[.,'’!?]/.test(ch) ? " punct" : ""}`;
      return `<span class="${cls}" style="${style}">${ch.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</span>`;
    }).join("");
    return `<span class="rn-w">${tiles}</span>`;
  });
  // keep the heading's own markup (the app writes venue names into it) as the readable text
  let src = el.querySelector(":scope > .rn-src");
  if (!src) {
    src = document.createElement("span");
    src.className = "rn-src";
    while (el.firstChild) src.appendChild(el.firstChild);
    el.appendChild(src);
  }
  el.querySelector(":scope > .rn")?.remove();
  el.removeAttribute("aria-label");
  const lines = words.join(" ").split(" \n ").map((l) => `<span class="rn-line">${l}</span>`).join("");
  el.insertAdjacentHTML("beforeend", `<span class="rn" aria-hidden="true">${lines}</span>`);
  el.classList.add("ransom");
  watch?.takeRecords(); // our own rewrite is not a change to react to
}

/** The heading's real words: its text outside the tiles (the app writes new text there). */
function realText(el) {
  const src = el.querySelector(":scope > .rn-src");
  let t = src ? src.textContent : "";
  // text the app wrote straight into the heading (replacing everything) also counts
  el.childNodes.forEach((n) => { if (!(n.nodeType === 1 && (n.classList.contains("rn") || n.classList.contains("rn-src")))) t += n.textContent; });
  return t.replace(/\s+/g, " ").trim();
}

function cutAll(root = document) {
  root.querySelectorAll(SELECTOR).forEach((h) => cut(h));
}

// Re-cut a heading when the app changes its words (a venue name arriving, results counting up).
var watch = new MutationObserver((list) => {
  const seen = new Set();
  list.forEach((m) => {
    const h = (m.target.nodeType === 1 ? m.target : m.target.parentElement)?.closest?.(SELECTOR);
    if (!h || seen.has(h)) return;
    seen.add(h);
    const t = realText(h);
    if (t && t !== h.dataset.ransom) cut(h, t);
  });
});

cutAll();
document.querySelectorAll(SELECTOR).forEach((h) => watch.observe(h, { childList: true, characterData: true, subtree: true }));
// headings added later (results, saved items)
let pending = false;
new MutationObserver(() => {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    document.querySelectorAll(SELECTOR).forEach((h) => {
      if (!h.dataset.watched) { h.dataset.watched = "1"; watch.observe(h, { childList: true, characterData: true, subtree: true }); }
      if (!h.querySelector(".rn")) cut(h);
    });
  });
}).observe(document.body, { childList: true, subtree: true });

export { cutAll };
