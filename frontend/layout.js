// Page structure: one HTML file, several views, switched by the tabs at the top.
//
//   #/            the opening page: the name, the glowing "Find your space", the collage
//   #/search      the search engine: the cassette brief, example briefs, a shelf of real rooms
//   #/results     search results for the last brief
//   #/venue/ID    one property: the pick, the sound, the room viewer, stay, budget, the ask
//   #/tour  #/film  #/bookings  #/cities   the other modes
//
// The opening page zooms into the search page: the blob grows from its own box to the
// whole screen (a FLIP scale, transform and opacity only). Esc or Back zooms out again.
//
// This file never touches the search or venue logic in app.js. It reads results through the
// "scout:results" event and opens a venue by pressing that venue's card in #cards.

import { detectCity } from "./regions.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const VIEWS = ["home", "search", "results", "property", "explore", "book", "tour", "film", "bookings", "cities"];
const TAB_OF = { home: "concerts", search: "concerts", results: "concerts", property: "concerts", explore: "concerts", book: "concerts", tour: "tour", film: "film", bookings: "bookings", cities: "cities" };
const TITLES = {
  home: "Stagehand", search: "Find your space · Stagehand", results: "Results · Stagehand",
  property: "Stagehand", tour: "Plan a tour · Stagehand", film: "Film mode · Stagehand",
  explore: "Explore in 3D · Stagehand", book: "Book · Stagehand", bookings: "Bookings · Stagehand", cities: "New cities · Stagehand",
};
const ZOOM_MS = 600;
const CHERRY = "#8e1424"; // the button
const OLIVE = "#4a5140"; // the search page

const state = { search: null, venueId: null, scouting: false, zooming: false, cameFromHome: false };
const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ------------------------------------------------------------------ views

function show(view, { keepScroll = false } = {}) {
  if (!VIEWS.includes(view)) view = "home";
  const from = document.body.dataset.view;
  if (from === "search" && view === "home" && !state.zooming) zoomOut();
  document.body.dataset.view = view;
  document.querySelectorAll(".modes a").forEach((a) => {
    const on = a.dataset.mode === TAB_OF[view];
    a.classList.toggle("on", on);
    if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  if (view !== "property") document.title = TITLES[view];
  if (from !== view && !keepScroll) window.scrollTo(0, 0);
}

function go(hash) {
  if (location.hash !== hash) history.pushState(null, "", hash);
  route();
}

/** Work out the view from the address bar. */
function route() {
  const h = location.hash;
  const m = h.match(/^#\/venue\/(\d+)(?:\/(3d|book))?/);
  if (m && m[2]) { showNextPage(Number(m[1]), m[2] === "3d" ? "explore" : "book"); return; }
  if (m) { show("property"); openVenue(Number(m[1])); return; }
  if (h.startsWith("#/") || !h) {
    const name = h.slice(2) || "home";
    show(name === "results" && !state.search && !state.scouting ? "search" : name);
    return;
  }
  // A plain anchor (#sound, #tour-plan): show the view that holds it, leave the scroll to the browser.
  const el = h.length > 1 && document.getElementById(h.slice(1));
  const holder = el?.closest("[data-view]");
  if (holder && holder.dataset.view !== document.body.dataset.view) {
    show(holder.dataset.view, { keepScroll: true });
    requestAnimationFrame(() => el.scrollIntoView());
  }
}

function firstView() {
  const q = new URLSearchParams(location.search);
  if (q.get("tour")) return show("tour");
  if (q.get("film")) return show("film");
  if (q.get("venue")) {
    state.venueId = Number(q.get("venue"));
    setPhoto(state.venueId);
    return show("property", { keepScroll: true });
  }
  if (location.hash) return route();
  show("home");
}

// ------------------------------------------------------------------ the zoom

/** A full-screen sheet the colour of the search page, used for both directions of the zoom. */
function veil() {
  const v = document.createElement("div");
  v.className = "zoom-veil";
  v.setAttribute("aria-hidden", "true");
  document.body.appendChild(v);
  return v;
}

/** The transform that shrinks a full-screen box onto the blob's box (the "First" in FLIP). */
function blobTransform() {
  const r = $("hero-cta").getBoundingClientRect();
  const W = window.innerWidth, H = window.innerHeight;
  const dx = r.left + r.width / 2 - W / 2, dy = r.top + r.height / 2 - H / 2;
  return `translate(${dx}px, ${dy}px) scale(${r.width / W}, ${r.height / H})`;
}

function zoomIn() {
  if (state.zooming || document.body.dataset.view !== "home") return;
  state.cameFromHome = true;
  if (reduced()) { crossFade(() => { go("#/search"); focusBrief(); }); return; }
  state.zooming = true;
  const v = veil();
  // Starts as the button itself (same cherry), fills the screen, then turns the search page's olive.
  const grow = v.animate([
    { transform: blobTransform(), borderRadius: "48%", backgroundColor: CHERRY },
    { transform: "none", borderRadius: "0%", backgroundColor: CHERRY, offset: 0.62 },
    { transform: "none", borderRadius: "0%", backgroundColor: OLIVE },
  ], { duration: ZOOM_MS + 250, easing: "cubic-bezier(.2,.7,.2,1)", fill: "forwards" });
  grow.onfinish = () => {
    go("#/search");
    focusBrief();
    v.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 260, easing: "ease-out", fill: "forwards" }).onfinish = () => {
      v.remove();
      state.zooming = false;
    };
  };
}

/** Back out of the search page: the sheet shrinks back into the blob. Runs as the home view appears. */
function zoomOut() {
  if (reduced()) return;
  state.zooming = true;
  const v = veil();
  requestAnimationFrame(() => {
    v.animate([
      { transform: "none", borderRadius: "0%", backgroundColor: OLIVE, opacity: 1 },
      { transform: "none", borderRadius: "0%", backgroundColor: CHERRY, opacity: 1, offset: 0.35 },
      { transform: blobTransform(), borderRadius: "48%", backgroundColor: CHERRY, opacity: 1, offset: 0.95 },
      { transform: blobTransform(), borderRadius: "48%", backgroundColor: CHERRY, opacity: 0 },
    ], { duration: ZOOM_MS + 250, easing: "cubic-bezier(.2,.7,.2,1)", fill: "forwards" }).onfinish = () => {
      v.remove();
      state.zooming = false;
    };
  });
}

function crossFade(swap) {
  const v = veil();
  v.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, fill: "forwards" }).onfinish = () => {
    swap();
    v.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, fill: "forwards" }).onfinish = () => v.remove();
  };
}

function leaveSearch() {
  if (state.cameFromHome) { state.cameFromHome = false; history.back(); }
  else go("#/");
}

function wireZoom() {
  $("hero-cta").addEventListener("click", (e) => { e.preventDefault(); zoomIn(); });
  // Scrolling, swiping or paging down on the opening page also opens the search.
  const onHome = () => document.body.dataset.view === "home";
  window.addEventListener("wheel", (e) => { if (onHome() && e.deltaY > 12) zoomIn(); }, { passive: true });
  let touchY = null;
  window.addEventListener("touchstart", (e) => { touchY = onHome() ? e.touches[0].clientY : null; }, { passive: true });
  window.addEventListener("touchmove", (e) => {
    if (touchY != null && touchY - e.touches[0].clientY > 50) { touchY = null; zoomIn(); }
  }, { passive: true });
  window.addEventListener("keydown", (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if (onHome() && !typing && ["ArrowDown", "PageDown", " "].includes(e.key)) { e.preventDefault(); zoomIn(); }
    if (e.key === "Escape" && document.body.dataset.view === "search") { e.preventDefault(); leaveSearch(); }
  });
}

function focusBrief() {
  const brief = $("brief");
  brief.focus({ preventScroll: true });
  brief.setSelectionRange(brief.value.length, brief.value.length);
}

// ------------------------------------------------------------------ search

function onBriefSubmit() {
  const brief = $("brief").value.trim();
  if (!brief || $("go").disabled) return;
  if (detectCity(brief)) { go("#/cities"); return; }
  state.search = null;
  state.scouting = true;
  $("rs-title").textContent = "Scouting.";
  $("rs-sub").textContent = `“${brief}”`;
  $("rs-list").innerHTML = `<p class="rs-wait">Listening to every scanned room that could fit you. This takes a few seconds.</p>`;
  go("#/results");
}

function wireSearch() {
  // Capture on window, so the view is in place before app.js and regions.js handle the same submit.
  window.addEventListener("submit", (e) => { if (e.target.id === "ask") onBriefSubmit(); }, true);
  window.addEventListener("keydown", (e) => {
    if (e.target.id === "brief" && e.key === "Enter" && !e.shiftKey) onBriefSubmit();
  }, true);
  window.addEventListener("scout:results", (e) => renderResults(e.detail));
  $("nav-cta").onclick = (e) => { e.preventDefault(); go("#/search"); focusBrief(); }; // replaces app.js's handler
}

// ------------------------------------------------------------------ shared bits for room cards

function feeEstimate(v) {
  // Same rough evening rate the treasurer uses (treasury.venue_fee_estimate).
  const area = v.best_space?.area_sqft || 1500;
  const fee = v.hotel || v.is_hotel ? Math.max(400, area * 0.35)
    : v.property_type === "Multifamily" ? Math.max(250, area * 0.15) : Math.max(350, area * 0.25);
  return Math.round(fee / 10) * 10;
}

// ------------------------------------------------------------------ pictures of a property
// Never the straight-down aerial. In order: the room you'd perform in (its 360 photo), CoStar's
// photo of the outside, then Vexcel's 45-degree obliques that show the front and back.

const venueInfo = {}; // id -> { photo, model } from whatever list we've seen it in
const roomsCache = {};

function remember(v) {
  if (!v?.venue_id) return;
  venueInfo[v.venue_id] = { photo: v.photo || venueInfo[v.venue_id]?.photo, model: v.best_space?.model_id || venueInfo[v.venue_id]?.model };
}

function rooms(id) {
  roomsCache[id] ||= fetch(`/api/venues/${id}/rooms`).then((r) => (r.ok ? r.json() : { rooms: [] })).then((d) => d.rooms || []).catch(() => []);
  return roomsCache[id];
}

// Rooms worth showing: big, open, made for people. Never a bathroom or a back corridor.
const DULL = /bath|rest ?room|toilet|\bwc\b|powder|closet|laundry|storage|utility|mechanical|electrical|elevator|stair|corridor|hallway|garage|janitor|trash|locker|shower|server|mail|bedroom|kitchen(?!.*living)/i;
const SHOWY = /ballroom|lounge|rooftop|roof|terrace|hall\b|theat|stage|studio|gallery|atrium|chapel|sanctuary|auditorium|event|great room|club|courtyard|pool|bar\b|library|lobby|living|loft|music|dance|ballet|meeting|conference/i;

function rankRooms(list, model) {
  return list
    .filter((r) => !DULL.test(`${r.room || ""} ${r.scan || ""}`))
    .map((r) => ({ r, score: Math.log10((r.area_sqft || 100) + 10) * 2 + (SHOWY.test(`${r.room || ""} ${r.scan || ""}`) ? 2 : 0) + (r.model_id === model ? 1.5 : 0) }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.r);
}

/** How good one photo looks: colourful, bright enough, with depth and detail rather than a blank wall. */
function photoScore(img) {
  const N = 48, c = document.createElement("canvas");
  c.width = c.height = N;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, N, N);
  const d = ctx.getImageData(0, 0, N, N).data;
  let sumL = 0, sumL2 = 0, rg = 0, rg2 = 0, yb = 0, yb2 = 0, edges = 0;
  const L = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) {
    const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    L[i] = l; sumL += l; sumL2 += l * l;
    const a = r - g, y = 0.5 * (r + g) - b;
    rg += a; rg2 += a * a; yb += y; yb2 += y * y;
  }
  for (let y = 0; y < N; y++) for (let x = 1; x < N; x++) edges += Math.abs(L[y * N + x] - L[y * N + x - 1]);
  const n = N * N, mean = sumL / n, std = Math.sqrt(Math.max(0, sumL2 / n - mean * mean));
  const sRG = Math.sqrt(Math.max(0, rg2 / n - (rg / n) ** 2)), sYB = Math.sqrt(Math.max(0, yb2 / n - (yb / n) ** 2));
  const colour = Math.hypot(sRG, sYB) + 0.3 * Math.hypot(rg / n, yb / n);
  const exposure = mean < 55 ? (55 - mean) * 1.5 : mean > 215 ? (mean - 215) * 1.5 : 0;
  return colour + std * 0.6 + (edges / (N * (N - 1))) * 2 - exposure;
}

const faceCache = {};
/** Of a 360 photo's four walls, the one that looks best. */
function bestFace(r) {
  const key = `${r.model_id}/${r.pano_id}`;
  faceCache[key] ||= Promise.all([1, 2, 3, 4].map((f) => new Promise((done) => {
    const img = new Image();
    img.onload = () => { try { done({ f, s: photoScore(img) }); } catch { done({ f, s: 0 }); } };
    img.onerror = () => done(null);
    img.src = `/api/pano/${key}/${f}.jpg`;
  }))).then((faces) => {
    const ok = faces.filter(Boolean).sort((a, b) => b.s - a.s);
    return ok.length ? { url: `/api/pano/${key}/${ok[0].f}.jpg`, score: ok[0].s } : null;
  });
  return faceCache[key];
}

const listCache = {};
function pictureList(id) {
  listCache[id] ||= (async () => {
    const info = venueInfo[id] || {};
    const ranked = rankRooms(await rooms(id), info.model);
    // Look at the three most promising rooms and lead with the best-looking view among them.
    const views = (await Promise.all(ranked.slice(0, 3).map(bestFace))).filter(Boolean);
    const inside = views.sort((a, b) => b.score - a.score).map((v) => v.url);
    return [
      ...inside.slice(0, 1),
      info.photo,
      `/api/film/${id}/oblique/s.jpg`,
      ...inside.slice(1),
      `/api/film/${id}/oblique/n.jpg`,
      `/api/film/${id}/oblique/e.jpg`,
    ].filter(Boolean);
  })();
  return listCache[id];
}

/** Point an <img> at a property's best picture, stepping down the list when one doesn't load. */
async function showPicture(img, id) {
  img.dataset.pic = id;
  const urls = await pictureList(id);
  if (img.dataset.pic !== String(id)) return; // reused for another venue meanwhile
  let k = 0;
  img.onerror = () => {
    k += 1;
    if (k < urls.length) img.src = urls[k];
    else { img.onerror = null; img.style.visibility = "hidden"; }
  };
  img.onload = () => { img.style.visibility = ""; };
  if (urls.length) img.src = urls[0];
}

function photoTag(v) {
  remember(v);
  return `<img alt="${esc(v.name)}" loading="lazy" data-venue="${v.venue_id}">`;
}

/** Fill every placeholder <img data-venue> inside a container. */
function hydrate(root) {
  root.querySelectorAll("img[data-venue]").forEach((img) => showPicture(img, Number(img.dataset.venue)));
}

function roomCard(v, n, extra = "") {
  const s = v.best_space, a = s.acoustics || {};
  return `
    <a class="polaroid rs-card" href="#/venue/${v.venue_id}" style="--tilt:${[-1.4, 1.1, -0.6, 1.6, -1.1, 0.7][n % 6]}deg;--tag:${["#742d36", "#2d5a8a", "#b8862b", "#4a5140", "#b4532a"][n % 5]}">
      
      ${photoTag(v)}
      <span class="rs-card-body">
        <span class="rs-kind">${esc(a.space_label || s.space_name)}</span>
        <span class="rs-card-name">${esc(v.name)}</span>
        <span class="rs-card-meta">${extra}${esc(s.space_name)}. ${a.rt60_occupied_s ?? "?"}s with a full house, ${a.capacity_seated ?? "?"} seats.</span>
        <span class="rs-card-foot"><b>$${feeEstimate(v).toLocaleString()}</b> <small>an evening</small><span class="rs-view">View</span></span>
      </span>
    </a>`;
}

// ------------------------------------------------------------------ the shelf of real rooms (search page)

// Scanned rooms across both cities, to browse before you search.
const FEATURED = [6531330, 9956355, 8917689, 9530669, 275472, 9169656, 4029966, 9168400, 406577, 11445467];

async function renderShelf() {
  const list = $("featured");
  const venues = await Promise.all(FEATURED.map((id) =>
    // audience before use, so pipeline.js doesn't mistake these for the venue on screen
    fetch(`/api/venues/${id}?audience=80&use=a_cappella_performance`).then((r) => (r.ok ? r.json() : null)).catch(() => null)));
  list.innerHTML = venues.filter((v) => v?.best_space?.acoustics)
    .map((v, i) => `<li>${roomCard(v, i, `${esc(v.metro)}. `)}</li>`).join("");
  hydrate(list);
  const step = () => Math.max(260, list.clientWidth * 0.8);
  const move = (dir) => list.scrollBy({ left: dir * step(), behavior: reduced() ? "auto" : "smooth" });
  $("feat-next").onclick = () => move(1);
  $("feat-prev").onclick = () => move(-1);
}

// ------------------------------------------------------------------ results page

function why(v) {
  const a = v.best_space.acoustics;
  const [lo, hi] = a.target_s || [0, 0];
  // Say something the verdict on the venue page doesn't: fit for this crowd, and clarity.
  const fit = a.rt60_occupied_s < lo ? "a little dry" : a.rt60_occupied_s > hi ? "a little live" : `inside the ${lo} to ${hi}s range we aim for`;
  const room = a.capacity_seated >= (state.search.audience || 0) ? `seats ${a.capacity_seated}, so ${state.search.audience} fit` : `seats only ${a.capacity_seated}`;
  const clear = a.c80_db == null ? "" : a.c80_db > 3 ? " Each part stays distinct." : a.c80_db < -2 ? " The parts blend into one sound." : " Clear, with some warmth.";
  return `With ${state.search.audience} people in, it rings for ${a.rt60_occupied_s} seconds, ${fit}. It ${room}.${clear}`;
}

function renderResults(r) {
  state.search = r;
  r.results.forEach(remember);
  $("last-results").hidden = false;
  const n = r.results.length;
  $("rs-title").innerHTML = n
    ? `${n} rooms in ${esc(r.metro)} <span class="script">that sing back.</span>`
    : "Nothing fit yet.";
  $("rs-sub").textContent = n
    ? `Out of ${r.venues_scanned.toLocaleString()} scanned buildings, ranked by how they'd sound with ${r.audience} people in.`
    : "Try a smaller audience or another date.";
  if (!n) { $("rs-list").innerHTML = ""; return; }

  // A slider: the current room big, the next ones smaller to its right. Its details sit below.
  $("rs-list").innerHTML = `
    <div class="rs-slider">
      <ol class="rs-track" id="rs-track" aria-label="Rooms we found. Use the arrows or swipe to see more.">
        ${r.results.map((v, i) => `
          <li class="rs-slide" data-i="${i}">
            <a class="rs-shot" href="#/venue/${v.venue_id}" aria-label="${i + 1} of ${n}: ${esc(v.name)}. Open the room.">
              ${photoTag(v)}
              
              <span class="rs-shot-name" aria-hidden="true">${esc(v.name)}</span>
            </a>
          </li>`).join("")}
      </ol>
      <div class="rs-controls">
        <button type="button" class="arrow" id="rs-prev" aria-label="Previous room"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12H5m6-6-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        <span class="rs-count" id="rs-count"></span>
        <button type="button" class="arrow" id="rs-next" aria-label="Next room"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h15m-6-6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      </div>
    </div>
    <div class="rs-detail" id="rs-detail" aria-live="polite"></div>
    <p class="note">Prices are rough evening rates from the room's size and type. The email to the venue asks for the real number.</p>`;
  hydrate($("rs-list"));
  // "Other rooms" on the property page: same pictures, not CoStar's photo alone.
  document.querySelectorAll("#cards .card").forEach((c) => showPicture(c.querySelector("img"), Number(c.dataset.id)));
  wireSlider(r.results);
}

function wireSlider(results) {
  const slides = [...document.querySelectorAll("#rs-track .rs-slide")];
  let at = 0;
  const select = (i) => {
    at = Math.max(0, Math.min(results.length - 1, i));
    slides.forEach((s, k) => {
      s.classList.toggle("on", k === at);
      s.classList.toggle("past", k < at);
      s.querySelector("a").tabIndex = k === at ? 0 : -1;
    });
    $("rs-count").textContent = `${at + 1} of ${results.length}`;
    $("rs-prev").disabled = at === 0;
    $("rs-next").disabled = at === results.length - 1;
    renderDetail(results[at], at);
  };
  $("rs-prev").onclick = () => select(at - 1);
  $("rs-next").onclick = () => select(at + 1);
  // A smaller room on the right comes forward when pressed; the big one opens the property.
  slides.forEach((s, k) => s.querySelector("a").addEventListener("click", (e) => {
    if (k !== at) { e.preventDefault(); select(k); }
  }));
  const track = $("rs-track");
  track.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") { e.preventDefault(); select(at + 1); slides[at].querySelector("a").focus(); }
    if (e.key === "ArrowLeft") { e.preventDefault(); select(at - 1); slides[at].querySelector("a").focus(); }
  });
  let x0 = null, swiped = false;
  track.addEventListener("pointerdown", (e) => { x0 = e.clientX; swiped = false; });
  track.addEventListener("pointerup", (e) => {
    if (x0 == null) return;
    const dx = e.clientX - x0;
    x0 = null;
    if (Math.abs(dx) > 40) { swiped = true; select(at + (dx < 0 ? 1 : -1)); }
  });
  track.addEventListener("click", (e) => { if (swiped) { e.preventDefault(); swiped = false; } }, true);
  select(0);
}

function renderDetail(v, i) {
  const s = v.best_space, a = s.acoustics;
  $("rs-detail").innerHTML = `
    <div class="rs-info">
      <p class="rs-tag">${i === 0 ? "Our pick" : esc(a.space_label || "Another option")}</p>
      <h2 class="rs-name"><a href="#/venue/${v.venue_id}">${esc(v.name)}</a></h2>
      <p class="rs-addr">${esc(v.address)}</p>
      <p class="rs-room">${esc(s.space_name)}, ${s.area_sqft.toLocaleString()} sq ft${s.height_ft ? `, ${s.height_ft} ft ceiling` : ""}.</p>
      <dl class="rs-facts">
        <div><dt>Reverb, full house</dt><dd>${a.rt60_occupied_s}s</dd></div>
        <div><dt>Seats</dt><dd>${a.capacity_seated}</dd></div>
        <div><dt>Parking</dt><dd>${v.parking_spaces || "Ask"}</dd></div>
      </dl>
    </div>
    <div class="rs-price"><b>$${feeEstimate(v).toLocaleString()}</b><span>an evening, our guess</span>
      <a class="btn" href="#/venue/${v.venue_id}">See the room</a></div>
    <div class="rs-why"><h3 class="script">Why it fits your show</h3><p>${esc(why(v))}</p></div>`;
}

// ------------------------------------------------------------------ property page

function openVenue(id) {
  setPhoto(id);
  if (state.venueId === id && !$("pick").hidden) return;
  state.venueId = id;
  const card = document.querySelector(`#cards .card[data-id="${id}"]`);
  if (card) { card.click(); return; }
  // No card for it (the shelf, a shared link, a reload): let app.js open it from the address.
  location.href = `/?venue=${id}`;
}

function setPhoto(id) {
  const v = state.search?.results?.find((r) => r.venue_id === id);
  const img = $("prop-photo");
  showPicture(img, id);
  img.alt = v ? `${v.name}, ${v.best_space.space_name}` : "The venue";
  $("prop-cap").textContent = v ? `${v.best_space.space_name.toLowerCase()} / ${v.metro}` : "the room";
  $("explore-3d").href = `#/venue/${id}/3d`;
  $("ready-book").href = `#/venue/${id}/book`;
  renderThumbs(id);
  venueFor(id).then((venue) => { if (venue && state.venueId === id) renderRent(venue); });
}

/** The venue record, from the last search or from the API. */
function venueFor(id) {
  const v = state.search?.results?.find((r) => r.venue_id === id);
  if (v) return Promise.resolve(v);
  // audience before use, so pipeline.js doesn't mistake this for the venue on screen
  return fetch(`/api/venues/${id}?audience=${state.search?.audience || 80}&use=${state.search?.use || "a_cappella_performance"}`)
    .then((r) => (r.ok ? r.json() : null)).then((x) => { remember(x); return x; }).catch(() => null);
}

/** Small pictures beside the big one; pressing one swaps it in. The 3D square gets an inside view. */
async function renderThumbs(id) {
  const urls = await pictureList(id);
  if (state.venueId !== id && state.venueId != null) return;
  $("explore-pic").style.backgroundImage = urls[0] ? `url("${urls[0]}")` : "";
  $("prop-thumbs").innerHTML = urls.slice(1, 5).map((u, i) =>
    `<li style="--tilt:${[-4, 3, -2, 5][i]}deg"><button type="button" aria-label="Show picture ${i + 2}"><img src="${esc(u)}" alt="" loading="lazy"></button></li>`).join("");
  $("prop-thumbs").querySelectorAll("li").forEach((li) => {
    const img = li.querySelector("img");
    img.onerror = () => li.remove(); // that picture doesn't exist for this building
    li.querySelector("button").onclick = () => {
      const main = $("prop-photo");
      const was = main.src;
      main.onerror = null;
      main.src = img.src;
      img.src = was;
    };
  });
}

function renderRent(v) {
  const s = v.best_space || {};
  const fee = feeEstimate(v);
  const kind = v.hotel || v.is_hotel ? "hotel event space" : v.property_type === "Multifamily" ? "a residential amenity room" : "commercial space";
  $("prop-rent").innerHTML = `
    <div class="rent-row"><span class="rent-label">Rent, one evening</span><b class="rent-price">$${fee.toLocaleString()}</b></div>
    <p class="note">Our estimate for ${esc(kind)} of ${(s.area_sqft || 1500).toLocaleString()} sq ft. The venue confirms the real rate when you book. Beds and the full budget are further down.</p>`;
}

// ------------------------------------------------------------------ the next pages (placeholders for now)

async function showNextPage(id, which) {
  show(which);
  const v = await venueFor(id);
  document.querySelectorAll(`.view[data-view="${which}"] .venue-name`).forEach((el) => { el.textContent = v?.name || "this venue"; });
  if (v && which !== "property") document.title = `${which === "explore" ? "Explore" : "Book"} ${v.name} · Stagehand`;
  const back = `#/venue/${id}`;
  ["ex-back", "bk-back"].forEach((b) => { $(b).href = back; });
  const jump = (target) => (e) => { e.preventDefault(); go(back); setTimeout(() => $(target).scrollIntoView(), 400); };
  $("ex-tour").href = back; $("ex-tour").onclick = jump("walk");
  $("bk-ask").href = back; $("bk-ask").onclick = jump("reach");
}

function watchVenueName() {
  const sync = () => {
    const name = $("d-name").textContent;
    if (!name) return;
    $("vf-title").textContent = name;
    if (document.body.dataset.view === "property") document.title = `${name} · Stagehand`;
    const v = state.search?.results?.find((r) => r.name === name);
    if (v && v.venue_id !== state.venueId) { state.venueId = v.venue_id; setPhoto(v.venue_id); }
  };
  new MutationObserver(sync).observe($("d-name"), { childList: true, characterData: true, subtree: true });
  // A card in "Other rooms" opens another venue in place; keep the address in step.
  $("cards").addEventListener("click", (e) => {
    const card = e.target.closest(".card");
    if (!card) return;
    const id = Number(card.dataset.id);
    state.venueId = id;
    setPhoto(id);
    if (location.hash !== `#/venue/${id}`) history.pushState(null, "", `#/venue/${id}`);
  });
}

// ------------------------------------------------------------------ boot

wireSearch();
wireZoom();
watchVenueName();
// The opening page and Side B: real buildings from the inside or from the side, never straight down.
[["snap-right", 6531330], ["snap-left", 9530669], ["snap-sticker", 9956355], ["sideb-photo", 6531330]]
  .forEach(([id, venue]) => $(id) && showPicture($(id), venue));
window.addEventListener("popstate", route);
window.addEventListener("hashchange", route);
firstView();
renderShelf();
