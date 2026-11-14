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
import { createLightLab, fixturesFor, KINDS, EYE } from "./lightlab.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const VIEWS = ["home", "search", "results", "property", "explore", "acoustics", "lighting", "walk3d", "book", "saved", "tour", "film", "bookings", "cities"];
const TAB_OF = { home: "concerts", search: "concerts", results: "concerts", property: "concerts", explore: "concerts", acoustics: "concerts", lighting: "concerts", walk3d: "concerts", saved: "saved", book: "concerts", tour: "tour", film: "film", bookings: "bookings", cities: "cities" };
const TITLES = {
  home: "Stagehand", search: "Find your space · Stagehand", results: "Results · Stagehand",
  property: "Stagehand", tour: "Plan a tour · Stagehand", film: "Film mode · Stagehand",
  explore: "Explore in 3D · Stagehand", walk3d: "3D walkthrough · Stagehand", acoustics: "Acoustics · Stagehand", lighting: "Lighting · Stagehand", saved: "Saved · Stagehand", book: "Book · Stagehand", bookings: "Bookings · Stagehand", cities: "New cities · Stagehand",
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
  if (view === "saved") renderSaved();
  if (from !== view && !keepScroll) window.scrollTo(0, 0);
}

function go(hash) {
  // Keep ?venue= only while you're still on that venue's pages; otherwise drop it so a refresh doesn't bring it back.
  const v = addressVenue();
  const keep = v && hash.startsWith(`#/venue/${v}`);
  const url = location.pathname + (keep ? location.search : "") + hash;
  if (location.pathname + location.search + location.hash !== url) history.pushState(null, "", url);
  route();
}

/** Work out the view from the address bar. */
function route() {
  const h = location.hash;
  const m = h.match(/^#\/venue\/(\d+)(?:\/(3d|book|walk|sound|light))?/);
  if (m && m[2]) { showNextPage(Number(m[1]), { "3d": "explore", book: "book", walk: "walk3d", sound: "acoustics", light: "lighting" }[m[2]]); return; }
  if (m) { show("property"); openVenue(Number(m[1])); return; }
  if (h.startsWith("#/") || !h) {
    const name = h.slice(2) || "home";
    show(name === "results" && !state.search && !state.scouting ? "search" : name);
    return;
  }
  // A plain anchor (#sound, #tour-plan): show the view that holds it, leave the scroll to the browser.
  const el = h.length > 1 && document.getElementById(h.slice(1));
  const holder = el?.closest("[data-view]");
  if (holder?.dataset.view === "walk3d" && state.venueId) { go(`#/venue/${state.venueId}/walk`); return; }
  if (holder?.dataset.view === "lighting" && state.venueId) {
    if (document.body.dataset.view !== "lighting") go(`#/venue/${state.venueId}/light`);
    requestAnimationFrame(() => el.scrollIntoView());
    return;
  }
  if (holder?.dataset.view === "acoustics" && state.venueId) {
    if (document.body.dataset.view !== "acoustics") go(`#/venue/${state.venueId}/sound`);
    requestAnimationFrame(() => el.scrollIntoView());
    return;
  }
  if (holder?.dataset.view === "explore") {
    const key = EXPLORE.find((k) => $(k).contains(el));
    if (holder.dataset.view !== document.body.dataset.view) show("explore", { keepScroll: true });
    if (key) selectExplore(key);
    return;
  }
  if (holder && holder.dataset.view !== document.body.dataset.view) {
    show(holder.dataset.view, { keepScroll: true });
    requestAnimationFrame(() => el.scrollIntoView());
  }
}

function firstView() {
  const q = new URLSearchParams(location.search);
  const venue = Number(q.get("venue"));
  if (venue) state.venueId = venue; // app.js opens it from the address
  // The #/ route says which page you were on, so a refresh lands there.
  if (location.hash.startsWith("#/")) return route();
  if (q.get("tour")) return show("tour");
  if (q.get("film")) return show("film");
  if (venue) {
    setPhoto(venue);
    return show("property", { keepScroll: true });
  }
  if (location.hash) return route();
  show("home");
}

/** The ?venue= app.js is opening from the address, if any. */
const addressVenue = () => Number(new URLSearchParams(location.search).get("venue")) || null;

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
  window.addEventListener("keydown", (e) => {
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
  state.brief = brief;
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
const DULL = /fitness|gym|bath|rest ?room|toilet|\bwc\b|powder|closet|laundry|storage|utility|mechanical|electrical|elevator|stair|corridor|hallway|garage|janitor|trash|locker|shower|server|mail|bedroom|kitchen(?!.*living)/i;
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
  // mostly white and colourless: bathrooms, corridors, blank walls
  const clinical = mean > 165 && colour < 26 ? 25 : 0;
  return colour + std * 0.6 + (edges / (N * (N - 1))) * 2 - exposure - clinical;
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
    // the biggest, showiest rooms get a head start over a merely colourful photo
    const views = (await Promise.all(ranked.slice(0, 4).map(bestFace)))
      .map((v, i) => v && { ...v, score: v.score + [14, 8, 3, 0][i] }).filter(Boolean);
    const inside = views.sort((a, b) => b.score - a.score).map((v) => v.url);
    return [
      ...inside.slice(0, 1),
      info.photo,
      ...inside.slice(1),
      `/api/film/${id}/oblique/s.jpg`,
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
const FEATURED = [6531330, 9438497, 9956355, 10183484, 9530669, 10064886, 5316122, 10610091, 9252592, 4029966];

async function renderShelf() {
  const list = $("featured");
  const venues = await Promise.all(FEATURED.map((id) =>
    // audience before use, so pipeline.js doesn't mistake these for the venue on screen
    fetch(`/api/venues/${id}?audience=80&use=a_cappella_performance`).then((r) => (r.ok ? r.json() : null)).catch(() => null)));
  list.innerHTML = venues.filter((v) => v?.best_space?.acoustics)
    .map((v, i) => `<li>${roomCard(v, i, `${esc(v.metro)}. `)}</li>`).join("");
  hydrate(list);
  // two whole cards at a time
  const items = [...list.children];
  let at = 0;
  const show2 = () => {
    at = Math.max(0, Math.min(at, items.length - 2));
    list.scrollTo({ left: items[at] ? items[at].offsetLeft - items[0].offsetLeft : 0, behavior: reduced() ? "auto" : "smooth" });
    $("feat-prev").disabled = at === 0;
    $("feat-next").disabled = at >= items.length - 2;
    items.forEach((li, i) => li.toggleAttribute("inert", i < at || i > at + 1));
  };
  $("feat-next").onclick = () => { at += 2; show2(); };
  $("feat-prev").onclick = () => { at -= 2; show2(); };
  show2();
}

// ------------------------------------------------------------------ results page

// What the brief is for, from its own words: a shoot, a show, or it doesn't say (then both).
const FILM_WORDS = /\b(film|filming|shoot|shooting|movie|video|crew|scene|commercial|music video|photo ?shoot|documentary|dialogue|cast)\b/i;
const SOUND_WORDS = /\b(sing|singers?|singing|choir|choral|a ?cappella|acapella|concert|recital|band|music(?!\s+video)|perform|performance|show|gig|rehears\w*|record(?:ing)?|vocal\w*|orchestra|quartet|trio|jazz|voices?)\b/i;

function briefIntent() {
  const text = state.brief || $("brief")?.value || "";
  const film = FILM_WORDS.test(text) || state.search?.use === "film_dialogue";
  const sound = SOUND_WORDS.test(text.replace(FILM_WORDS, " "));
  return film && !sound ? "film" : sound && !film ? "sound" : "both";
}

function whySound(v) {
  const a = v.best_space.acoustics;
  const [lo, hi] = a.target_s || [0, 0];
  // Say something the verdict on the venue page doesn't: fit for this crowd, and clarity.
  const fit = a.rt60_occupied_s < lo ? "a little dry" : a.rt60_occupied_s > hi ? "a little live" : `inside the ${lo} to ${hi}s range we aim for`;
  const room = a.capacity_seated >= (state.search.audience || 0) ? `seats ${a.capacity_seated}, so ${state.search.audience} fit` : `seats only ${a.capacity_seated}`;
  const clear = a.c80_db == null ? "" : a.c80_db > 3 ? " Each part stays distinct." : a.c80_db < -2 ? " The parts blend into one sound." : " Clear, with some warmth.";
  return `With ${state.search.audience} people in, it rings for ${a.rt60_occupied_s} seconds, ${fit}. It ${room}.${clear}`;
}

function whyFilm(v) {
  const s = v.best_space, a = s.acoustics;
  const rt = a.rt60_empty_s ?? a.rt60_occupied_s;
  const sound = rt <= 0.6
    ? `It rings for ${rt} seconds empty, quiet enough to record clean dialogue.`
    : rt <= 0.9
      ? `It rings for ${rt} seconds empty, a touch live for dialogue; a few sound blankets will fix it.`
      : `At ${rt} seconds of echo it's live for dialogue, so plan on blankets or keep it for scenes without lines.`;
  const space = `${s.area_sqft.toLocaleString()} sq ft${s.height_ft ? ` with a ${s.height_ft} ft ceiling` : ""} gives the crew room to work${s.height_ft >= 12 ? " and the lights room to fly" : s.height_ft ? ", though lights will sit low" : ""}.`;
  const park = v.parking_spaces ? ` ${v.parking_spaces} parking spaces on record for trucks and crew cars.` : "";
  return `${sound} ${space}${park}`;
}

function whyHTML(v) {
  const intent = briefIntent();
  if (intent === "film") return `<h3 class="script">Why it works for your shoot</h3><p>${esc(whyFilm(v))}</p>`;
  if (intent === "sound") return `<h3 class="script">Why it fits your show</h3><p>${esc(whySound(v))}</p>`;
  return `<h3 class="script">Why it works for you</h3>
    <p><b>For a show.</b> ${esc(whySound(v))}</p>
    <p><b>For a shoot.</b> ${esc(whyFilm(v))}</p>`;
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
    <div class="rs-why">${whyHTML(v)}</div>`;
}

// ------------------------------------------------------------------ property page

function openVenue(id) {
  setPhoto(id);
  if (state.venueId === id && (!$("pick").hidden || addressVenue() === id)) return;
  state.venueId = id;
  const card = document.querySelector(`#cards .card[data-id="${id}"]`);
  if (card) { card.click(); return; }
  // No card for it (the shelf, a shared link, a reload): let app.js open it from the address.
  location.href = `/?venue=${id}#/venue/${id}`;
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
  if (v) document.title = `${{ explore: "Explore", book: "Book", walk3d: "Walk through", acoustics: "How it sounds:", lighting: "Light" }[which]} ${v.name} · Stagehand`;
  const back = `#/venue/${id}`;
  ["ex-back", "bk-back"].forEach((b) => { $(b).href = back; });
  if (which === "book") startBooking(id, v);
  if (which === "explore") startExplore(id);
  if (which === "walk3d") startWalk(id);
  if (which === "acoustics") startAcoustics(id);
  if (which === "lighting") startLighting(id);
}

// ------------------------------------------------------------------ explore: acoustics, lighting, 3D walkthrough

const EXPLORE = [];

/** The evaluations are app.js's sections, so the venue must be open in app.js first. */
function ensureVenue(id, hash) {
  if (state.venueId === id && (!$("pick").hidden || addressVenue() === id)) return false;
  state.venueId = id;
  const card = document.querySelector(`#cards .card[data-id="${id}"]`);
  if (card) { state.quietCard = true; card.click(); state.quietCard = false; return false; }
  location.href = `/?venue=${id}${hash}`;
  return true; // the page is reloading; callers should stop here
}

function startExplore(id) {
  if (ensureVenue(id, `#/venue/${id}/3d`)) return;
  showPicture($("explore-photo"), id);
  EXPLORE.forEach((k) => $(k).classList.add("ex-off"));
  document.querySelectorAll(".ex-choice").forEach((b) => {
    b.setAttribute("aria-pressed", "false");
    b.onclick = () => go(`#/venue/${id}/${{ walk: "walk", sound: "sound", light: "light" }[b.dataset.ex]}`);
  });
}

// ------------------------------------------------------------------ the lighting lab

const lab = { viewer: null, id: null, kind: "wash", placed: [], rooms: [] };

function labLights() {
  const all = lab.placed.flatMap((x) => x.fixtures);
  lab.viewer.setLights(all);
  $("lab-count").textContent = `${lab.placed.length} light${lab.placed.length === 1 ? "" : "s"}`;
  $("lab-list").innerHTML = lab.placed.map((x, i) =>
    `<li><span class="sw" style="--c:${x.color}"></span>${esc(KINDS[x.kind].label)}<button type="button" data-i="${i}" aria-label="Remove ${esc(KINDS[x.kind].label)} ${i + 1}">&times;</button></li>`).join("");
  $("lab-list").querySelectorAll("button").forEach((b) => (b.onclick = () => { lab.placed.splice(Number(b.dataset.i), 1); labLights(); }));
  $("lab-undo").disabled = $("lab-clear").disabled = !lab.placed.length;
  if (all.length > 32) $("lab-count").textContent += " (only the first 32 bulbs light up)";
}

/** Remove the light nearest to where you clicked in the room (within about 12 degrees). */
function eraseNear(hit) {
  const eye = { x: 0, y: EYE, z: 0 };
  let best = -1, bestAngle = 0.21;
  // either the fixture itself or the spot it was aimed at
  lab.placed.forEach((x, i) => [...x.fixtures.map((f) => f.pos), x.at].filter(Boolean).forEach((pos) => {
    const f = { pos };
    const dx = f.pos.x - eye.x, dy = f.pos.y - eye.y, dz = f.pos.z - eye.z, len = Math.hypot(dx, dy, dz) || 1;
    const angle = Math.acos(Math.max(-1, Math.min(1, (dx * hit.d.x + dy * hit.d.y + dz * hit.d.z) / len)));
    if (angle < bestAngle) { bestAngle = angle; best = i; }
  }));
  if (best < 0) { $("lab-count").textContent = "No light there. Click right on one."; setTimeout(labLights, 1400); return; }
  lab.placed.splice(best, 1);
  labLights();
}

function placeLight(kind, hit, color, power) {
  const k = KINDS[kind];
  const fixtures = fixturesFor(kind, hit, lab.viewer.room(), color || $("lab-color").value, (power ?? Number($("lab-power").value)) * k.power);
  lab.placed.push({ kind, color: color || $("lab-color").value, fixtures, at: hit.p });
  labLights();
}

const PRESETS = {
  concert: { ambient: 0.1, lights: [["spot", [-0.3, -0.12, -1], "#fff1d6"], ["spot", [0.3, -0.12, -1], "#fff1d6"], ["wash", [0, 0.25, 1], "#ffb36b", 0.7], ["uplight", [0, 0.1, -1], "#ff8a3d", 0.8]] },
  candle: { ambient: 0.08, lights: [["string", [-0.35, 0.25, -1], "#ffcf7a"], ["string", [0.35, 0.25, -1], "#ffcf7a"], ["string", [-1, 0.25, -0.8], "#ffcf7a"], ["string", [1, 0.25, -0.8], "#ffcf7a"], ["wash", [0, -0.35, -1], "#ff9a4d", 0.7]] },
  gala: { ambient: 0.16, lights: [["uplight", [-1, -0.1, -0.9], "#ff3d8b"], ["uplight", [1, -0.1, -0.9], "#5a7bff"], ["uplight", [-0.3, -0.1, -1], "#d9a441"], ["uplight", [0.3, -0.1, -1], "#d9a441"], ["string", [0, 0.3, -1], "#ffe2a8"], ["spot", [0, -0.2, -1], "#fff1d6", 0.8]] },
};

function applyPreset(name) {
  const pr = PRESETS[name];
  lab.placed = [];
  $("lab-ambient").value = pr.ambient;
  lab.viewer.setAmbient(pr.ambient);
  pr.lights.forEach(([kind, dir, color, power = 1]) => {
    const [x, y, z] = dir, len = Math.hypot(x, y, z);
    const hit = lab.viewer.surfacePoint({ x: x / len, y: y / len, z: z / len, clone() { return { ...this }; } });
    placeLight(kind, hit, color, power);
  });
  lab.viewer.look(0, -0.05);
}

async function loadLabRoom(r) {
  lab.current = r;
  $("lab-rooms").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.key === `${r.model_id}/${r.pano_id}`)));
  $("lab-empty").hidden = false;
  $("lab-empty").textContent = "Loading the room…";
  $("lab-room-name").textContent = (r.room || r.scan).replace(/^.* - /, "");
  labLights();
  try {
    await lab.viewer.load(r.model_id, r.pano_id, r.area_sqft);
    $("lab-empty").hidden = true;
    labLights();
  } catch {
    $("lab-empty").textContent = "That room's photo didn't load. Try another.";
  }
}

async function startLighting(id) {
  $("lab-back").href = `#/venue/${id}/3d`;
  if (ensureVenue(id, `#/venue/${id}/light`)) return;
  if (!lab.viewer) {
    lab.viewer = createLightLab($("lab-view"));
    lab.viewer.onPick((hit) => (lab.kind === "erase" ? eraseNear(hit) : placeLight(lab.kind, hit)));
    $("lab-ambient").oninput = (e) => lab.viewer.setAmbient(Number(e.target.value));
    $("lab-kinds").querySelectorAll("button").forEach((b) => (b.onclick = () => {
      lab.kind = b.dataset.kind;
      $("lab-view").classList.toggle("erasing", lab.kind === "erase");
      if (KINDS[lab.kind]) $("lab-color").value = KINDS[lab.kind].color;
      $("lab-kinds").querySelectorAll("button").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
    }));
    $("lab-presets").querySelectorAll("button").forEach((b) => (b.onclick = () => applyPreset(b.dataset.preset)));
    $("lab-undo").onclick = () => { lab.placed.pop(); labLights(); };
    $("lab-clear").onclick = () => { lab.placed = []; labLights(); };
  }
  // while this venue's rooms are still loading, that first call will restore any saved design itself
  if (lab.id === id) { if (!lab.loading && hasPending("light")) restoreDesign(); return; }
  lab.id = id;
  lab.loading = true;
  lab.placed = [];
  const info = venueInfo[id] || {};
  lab.rooms = rankRooms(await rooms(id), info.model).slice(0, 6);
  lab.loading = false;
  $("lab-rooms").innerHTML = lab.rooms.map((r) =>
    `<button type="button" data-key="${r.model_id}/${r.pano_id}" aria-pressed="false">${esc((r.room || r.scan).replace(/^.* - /, ""))}${r.area_sqft ? ` <small>${r.area_sqft.toLocaleString()} sq ft</small>` : ""}</button>`).join("");
  $("lab-rooms").querySelectorAll("button").forEach((b, i) => (b.onclick = () => { lab.placed = []; loadLabRoom(lab.rooms[i]); }));
  if (!lab.rooms.length) { $("lab-empty").textContent = "No 360 photos for this building."; return; }
  if (hasPending("light")) { await restoreDesign(); return; }
  await loadLabRoom(lab.rooms[0]);
  applyPreset("concert");
}

// ------------------------------------------------------------------ saved favourites (kept in this browser)

const SAVED_KEY = "stagehand.saved";
// what to restore after opening a favourite; kept in session storage so it survives a page load
const PENDING_KEY = "stagehand.open";
function takePending(type) {
  try {
    const x = JSON.parse(sessionStorage.getItem(PENDING_KEY));
    if (x?.type !== type) return null;
    sessionStorage.removeItem(PENDING_KEY);
    return x;
  } catch { return null; }
}
function hasPending(type) { try { return JSON.parse(sessionStorage.getItem(PENDING_KEY))?.type === type; } catch { return false; } }

function loadSaved() {
  try { return JSON.parse(localStorage.getItem(SAVED_KEY)) || []; } catch { return []; }
}
function storeSaved(list) {
  try { localStorage.setItem(SAVED_KEY, JSON.stringify(list)); return true; } catch { return false; }
}
function updateSavedCount() {
  const n = loadSaved().length;
  $("saved-count").hidden = !n;
  $("saved-count").textContent = n;
}
function toast(html) {
  const t = $("toast");
  t.innerHTML = html;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 3200);
}
function addSaved(item) {
  const list = loadSaved();
  list.unshift({ ...item, at: Date.now(), key: `${item.type}-${Date.now()}` });
  if (!storeSaved(list.slice(0, 60))) { toast("Couldn't save: this browser's storage is full or turned off."); return false; }
  updateSavedCount();
  toast(`Saved to your favourites. <a href="#/saved">See them</a>`);
  return true;
}
function popButton(btn) {
  btn.setAttribute("aria-pressed", "true");
  btn.classList.add("pop");
  setTimeout(() => btn.classList.remove("pop"), 180);
}
const venueName = (id) => (state.venueId === id && $("d-name").textContent) || state.search?.results?.find((r) => r.venue_id === id)?.name || "This venue";

/** A small picture of the lit room for the favourites page. */
function labThumb() {
  const src = $("lab-view").querySelector("canvas");
  if (!src) return "";
  lab.viewer.snapshot();
  const c = document.createElement("canvas");
  c.width = 360; c.height = Math.round(360 * src.height / src.width);
  c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.72);
}

function wireSaving() {
  $("save-light").onclick = () => {
    if (!lab.current) return;
    const ok = addSaved({
      type: "light", venue: lab.id, name: venueName(lab.id), room: $("lab-room-name").textContent,
      roomKey: `${lab.current.model_id}/${lab.current.pano_id}`, ambient: Number($("lab-ambient").value),
      lights: lab.placed.map((x) => ({ kind: x.kind, color: x.color, at: x.at, fixtures: x.fixtures })), thumb: labThumb(),
    });
    if (ok) popButton($("save-light"));
  };
  $("save-sound").onclick = () => {
    const a = readAcoustics();
    if (a.full == null) return;
    const room = document.querySelector("#d-spaces button.on")?.textContent || "";
    const crowd = document.querySelector("#sound [data-crowd].on")?.dataset.crowd || "full";
    const ok = addSaved({ type: "sound", venue: state.venueId, name: venueName(state.venueId), room, crowd, numbers: a, verdict: $("d-verdict").textContent });
    if (ok) popButton($("save-sound"));
  };
  $("save-space").onclick = () => {
    const id = state.venueId;
    const list = loadSaved();
    const existing = list.find((x) => x.type === "space" && x.venue === id);
    if (existing) {
      storeSaved(list.filter((x) => x !== existing));
      $("save-space").setAttribute("aria-pressed", "false");
      $("save-space").querySelector("span").textContent = "Save this space";
      updateSavedCount();
      toast("Removed from your favourites.");
      return;
    }
    if (addSaved({ type: "space", venue: id, name: venueName(id), address: $("d-address").textContent })) {
      popButton($("save-space"));
      $("save-space").querySelector("span").textContent = "Saved";
    }
  };
  // the space button shows whether this venue is already saved
  new MutationObserver(() => {
    const on = loadSaved().some((x) => x.type === "space" && x.venue === state.venueId);
    $("save-space").setAttribute("aria-pressed", String(on));
    $("save-space").querySelector("span").textContent = on ? "Saved" : "Save this space";
  }).observe($("d-name"), { childList: true, characterData: true, subtree: true });
  // a fresh design or sound can be saved again
  $("lab-view").addEventListener("pointerup", () => $("save-light").setAttribute("aria-pressed", "false"));
  $("lab-list").addEventListener("click", () => $("save-light").setAttribute("aria-pressed", "false"));
  $("d-spaces").addEventListener("click", () => $("save-sound").setAttribute("aria-pressed", "false"));
  updateSavedCount();
}

function renderSaved() {
  const list = loadSaved();
  const when = (t) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const card = (x, i, face, kind, meta, open, openLabel) => `
    <li><div class="polaroid sv-card" style="--tilt:${[-1.2, 1, -0.6, 1.4][i % 4]}deg">
      ${face}
      <div class="sv-body">
        <span class="sv-kind">${kind} · ${when(x.at)}</span>
        <span class="sv-name">${esc(x.name)}</span>
        <span class="sv-meta">${meta}</span>
        <div class="sv-actions"><a href="${open}" data-open="${x.key}">${openLabel}</a><button type="button" data-remove="${x.key}">Remove</button></div>
      </div></div></li>`;
  const lights = list.filter((x) => x.type === "light");
  const sounds = list.filter((x) => x.type === "sound");
  const spaces = list.filter((x) => x.type === "space");
  $("sv-light").innerHTML = lights.map((x, i) => card(x, i,
    x.thumb ? `<img src="${x.thumb}" alt="The lighting design in ${esc(x.room)}">` : `<div class="sv-sound-face">${x.lights.length}<small>lights</small></div>`,
    "Lighting", `${esc(x.room)}. ${x.lights.length} light${x.lights.length === 1 ? "" : "s"}, house lights at ${Math.round(x.ambient * 100)}%.`,
    `#/venue/${x.venue}/light`, "Open the design")).join("");
  $("sv-sound").innerHTML = sounds.map((x, i) => card(x, i,
    `<div class="sv-sound-face"><span>${x.numbers.full}s<small>echo, ${x.crowd === "empty" ? "empty room" : "full house"}</small></span></div>`,
    "Sound", `${esc(x.room || "Main room")}. ${esc(x.verdict)}`, `#/venue/${x.venue}/sound`, "Listen again")).join("");
  $("sv-space").innerHTML = spaces.map((x, i) => card(x, i, `<img data-venue="${x.venue}" alt="${esc(x.name)}">`,
    "Space", esc(x.address || ""), `#/venue/${x.venue}`, "Open the space")).join("");
  $("sv-light").dataset.empty = "Nothing yet. In the lighting lab, press Save this lighting.";
  $("sv-sound").dataset.empty = "Nothing yet. On a room's Acoustics page, press Save this sound.";
  $("sv-space").dataset.empty = "Nothing yet. On a space's page, press Save this space.";
  hydrate($("sv-space"));
  document.querySelectorAll("[data-remove]").forEach((b) => (b.onclick = () => {
    storeSaved(loadSaved().filter((x) => x.key !== b.dataset.remove));
    updateSavedCount();
    renderSaved();
  }));
  document.querySelectorAll("[data-open]").forEach((a) => (a.onclick = () => {
    const x = loadSaved().find((y) => y.key === a.dataset.open);
    try { sessionStorage.setItem(PENDING_KEY, JSON.stringify({ ...x, thumb: undefined })); } catch { /* private window */ }
  }));
}

async function restoreDesign() {
  const d = takePending("light");
  if (!d || d.venue !== lab.id) return;
  const r = lab.rooms.find((x) => `${x.model_id}/${x.pano_id}` === d.roomKey) || lab.rooms[0];
  await loadLabRoom(r);
  $("lab-ambient").value = d.ambient;
  lab.viewer.setAmbient(d.ambient);
  lab.placed = d.lights.map((x) => ({ ...x }));
  labLights();
  $("save-light").setAttribute("aria-pressed", "true");
}

function restoreSound() {
  const s = takePending("sound");
  if (!s) return;
  const btn = [...document.querySelectorAll("#d-spaces button")].find((b) => b.textContent === s.room);
  if (btn && !btn.classList.contains("on")) btn.click();
  document.querySelector(`[data-ac-crowd="${s.crowd}"]`)?.click();
  $("save-sound").setAttribute("aria-pressed", "true");
}

// ------------------------------------------------------------------ the acoustics page

/** The numbers app.js shows for the room on screen (it re-renders them when the room changes). */
function readAcoustics() {
  const rows = {};
  $("d-acoustics").querySelectorAll("div").forEach((d) => { rows[d.querySelector("dt")?.textContent] = d.querySelector("dd")?.textContent || ""; });
  const num = (re, txt) => { const m = (txt || "").match(re); return m ? parseFloat(m[1]) : null; };
  const target = ($("d-rtchart").textContent.match(/Target ([\d.]+) to ([\d.]+)s/) || []).slice(1).map(Number);
  return {
    empty: num(/([\d.]+)s empty/, rows.Reverb), full: num(/([\d.]+)s with/, rows.Reverb), guests: num(/with (\d+) guests/, rows.Reverb),
    bass: num(/Bass ratio ([\d.]+)/, rows.Warmth), c80: num(/C80 \+?(-?[\d.]+)/, rows.Clarity), sti: num(/Speech index ([\d.]+)/, rows.Words),
    target: target.length === 2 ? target : null, room: rows.Room || "",
  };
}

function meter(value, min, max, lo, hi, left, right) {
  const pct = (v) => Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100));
  return `<div class="ac-meter" aria-hidden="true">
      <span class="ac-band" style="left:${pct(lo)}%;width:${pct(hi) - pct(lo)}%"></span>
      <span class="ac-dot" style="left:${pct(value)}%"></span>
    </div><div class="ac-ends" aria-hidden="true"><span>${left}</span><span>${right}</span></div>`;
}

function renderAcCards() {
  const a = readAcoustics();
  if (a.full == null) return;
  $("ac-verdict").textContent = $("d-verdict").textContent;
  const [lo, hi] = a.target || [1.2, 2];
  const echo = a.full < lo
    ? "Notes stop quickly. Tight harmony sounds exposed and close, so sing a little fuller than usual."
    : a.full > hi
      ? "Sound hangs around. Slow ballads bloom, but quick rhythms smear, so leave room between phrases."
      : "A held chord hangs in the air just long enough to blend the parts, and fast songs still sound clean.";
  const cards = [
    { k: "Echo", big: `${a.full}<small>s</small>`, m: meter(a.full, 0, 3.5, lo, hi, "dry", "cathedral"),
      t: `${echo} Empty, it rings for ${a.empty}s; ${a.guests || "your"} guests soak some of that up.` },
    a.bass != null && { k: "Warmth", big: a.bass.toFixed(2), m: meter(a.bass, 0.6, 1.6, 1.0, 1.3, "bright", "warm"),
      t: a.bass >= 1.1 ? "Low voices bloom. Basses carry without pushing." : a.bass < 0.9 ? "A bright room: sopranos sparkle, basses may need to lean in." : "Even from bass to soprano; nobody has to fight to be heard." },
    a.c80 != null && { k: "Clarity", big: `${a.c80 > 0 ? "+" : ""}${a.c80}<small>dB</small>`, m: meter(a.c80, -6, 8, 0, 4, "blended", "crisp"),
      t: a.c80 > 3 ? "Every line stays distinct, good for busy arrangements and vocal percussion." : a.c80 < -2 ? "The parts melt into one sound. Slow, chordal pieces suit it best." : "Each part is clear, with a little warmth around it." },
    a.sti != null && { k: "Words", big: a.sti.toFixed(2), m: meter(a.sti, 0, 1, 0.6, 1, "lost", "every word"),
      t: a.sti >= 0.6 ? "Lyrics and the talk between songs come through." : a.sti >= 0.45 ? "Lyrics carry if you sing them clearly." : "Words blur here; keep the patter short or bring a microphone." },
  ].filter(Boolean);
  $("ac-cards").innerHTML = cards.map((c, i) => `
    <article class="ac-card" style="--tilt:${[-1, 0.8, -0.6, 1.2][i]}deg">
      <h3>${c.k}</h3><p class="ac-big">${c.big}</p>${c.m}<p class="ac-text">${c.t}</p>
    </article>`).join("");
}

function playStatus(what) {
  const room = document.querySelector("#d-spaces button.on")?.textContent || $("d-name").textContent;
  const crowd = document.querySelector("#sound [data-crowd].on")?.dataset.crowd === "empty" ? "an empty room" : "a full house";
  $("ac-now").textContent = `Playing ${what} in the ${room.toLowerCase()} with ${crowd}.`;
}

let acWired = false;
function startAcoustics(id) {
  $("ac-back").href = `#/venue/${id}/3d`;
  if (ensureVenue(id, `#/venue/${id}/sound`)) return;
  if (!acWired) {
    acWired = true;
    const watch = new MutationObserver(() => renderAcCards());
    watch.observe($("d-acoustics"), { childList: true, subtree: true, characterData: true });
    watch.observe($("d-rtchart"), { childList: true, subtree: true });
    // the sample buttons drive app.js's own player
    $("ac-chord").onclick = () => { $("play-choir").click(); playStatus("a four-part chord"); };
    $("ac-clap").onclick = () => { $("clap").click(); playStatus("a clap"); };
    $("ac-mic").onclick = () => {
      $("mic").click();
      setTimeout(() => {
        const live = $("mic").classList.contains("live");
        $("ac-mic-label").textContent = live ? "Stop singing" : "Sing into the room";
        $("ac-mic").setAttribute("aria-pressed", String(live));
        $("ac-now").textContent = live ? "Listening. Sing, and you'll hear yourself back with the room around you." : "Microphone off.";
      }, 600);
    };
    document.querySelectorAll("[data-ac-crowd]").forEach((b) => (b.onclick = () => {
      document.querySelector(`#sound [data-crowd="${b.dataset.acCrowd}"]`)?.click();
      document.querySelectorAll("[data-ac-crowd]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    }));
  }
  whenVenueOpen(id, () => { renderAcCards(); if (hasPending("sound")) restoreSound(); });
}

// ------------------------------------------------------------------ the 3D walkthrough page

/** Wait until app.js has this venue open (it loads asynchronously), then run fn. */
function whenVenueOpen(id, fn, tries = 60) {
  const v = venueInfo[id];
  const ready = !$("pick").hidden && $("d-name").textContent && state.venueId === id;
  if (ready) { fn(); return; }
  if (tries > 0) setTimeout(() => whenVenueOpen(id, fn, tries - 1), 250);
}

function startWalk(id) {
  $("wk-back").href = `#/venue/${id}/3d`;
  if (ensureVenue(id, `#/venue/${id}/walk`)) return;
  whenVenueOpen(id, () => {
    // One button per scanned space, mirroring app.js's own room buttons, which switch the model.
    const spaces = [...document.querySelectorAll("#d-spaces button")];
    const on = () => document.querySelector("#d-spaces button.on")?.dataset.i;
    const draw = () => {
      $("walk-switch").innerHTML = spaces.length > 1
        ? spaces.map((b) => `<button type="button" data-i="${b.dataset.i}" aria-pressed="${b.dataset.i === on()}">${esc(b.textContent)}</button>`).join("")
        : `<span class="note">One scanned space: ${esc($("d-name").textContent)}</span>`;
      $("walk-switch").querySelectorAll("button").forEach((btn) => (btn.onclick = () => {
        spaces.find((b) => b.dataset.i === btn.dataset.i)?.click();
        draw();
        openModel();
      }));
    };
    draw();
    openModel();
  });
}

/** Load the 3D model straight away instead of waiting for a click on the poster. */
function openModel() {
  if (!$("tour-poster").hidden) $("tour-poster").click();
}

function selectExplore(key, scroll = true) {
  EXPLORE.forEach((k) => $(k).classList.toggle("ex-off", k !== key));
  document.querySelectorAll(".ex-choice").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.ex === key)));
  if (scroll) revealAndScroll($(key));
}

// ------------------------------------------------------------------ booking: pick dates, then the next step appears

const DAY = 86400000;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const nice = (d) => d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
const booking = { id: null, venue: null, month: null, start: null, end: null };

/**
 * Which days are taken. There's no venue calendar in the data yet, so this is a fixed sample per venue
 * (the page says so). Swap this for the venue's real calendar when one exists.
 */
function isTaken(id, d) {
  let h = (id * 2654435761) ^ (d.getFullYear() * 372 + d.getMonth() * 31 + d.getDate()) * 40503;
  h = (h ^ (h >>> 13)) * 1274126177;
  const r = ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  const weekend = d.getDay() === 5 || d.getDay() === 6;
  return r < (weekend ? 0.38 : 0.16);
}

function briefMonth() {
  const m = ($("brief")?.value || "").match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:\s+(\d{1,2}))?/i);
  const now = new Date();
  if (!m) return new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const mi = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(m[1].toLowerCase());
  let d = new Date(now.getFullYear(), mi, 1);
  if (d < new Date(now.getFullYear(), now.getMonth(), 1)) d = new Date(now.getFullYear() + 1, mi, 1);
  return d;
}

function startBooking(id, v) {
  if (booking.id !== id) Object.assign(booking, { id, venue: v, month: briefMonth(), start: null, end: null });
  booking.venue = v || booking.venue;
  $("book-next").hidden = true;
  $("book-done").hidden = true;
  wireBookForm();
  const img = $("book-photo");
  showPicture(img, id);
  $("cal-prev").onclick = () => { booking.month = new Date(booking.month.getFullYear(), booking.month.getMonth() - 1, 1); drawCalendar(); };
  $("cal-next").onclick = () => { booking.month = new Date(booking.month.getFullYear(), booking.month.getMonth() + 1, 1); drawCalendar(); };
  $("cal-confirm").onclick = confirmDates;
  $("bk-change").onclick = (e) => { e.preventDefault(); $("book-pick").scrollIntoView({ behavior: reduced() ? "auto" : "smooth" }); };
  drawCalendar();
}

function rangeProblem() {
  const { start, end, id } = booking;
  if (!start) return null;
  for (let t = start.getTime(); t <= (end || start).getTime(); t += DAY) {
    const d = new Date(t);
    if (isTaken(id, d)) return d;
  }
  return null;
}

function drawCalendar() {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const first = booking.month;
  const firstAllowed = new Date(today.getFullYear(), today.getMonth(), 1);
  $("cal-prev").disabled = first <= firstAllowed;
  const bad = rangeProblem();
  const months = [0, 1].map((k) => new Date(first.getFullYear(), first.getMonth() + k, 1));
  $("cal-months").innerHTML = months.map((m) => {
    const lead = (m.getDay() + 6) % 7; // weeks start on Monday
    const days = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push(`<span aria-hidden="true"></span>`);
    for (let n = 1; n <= days; n++) {
      const d = new Date(m.getFullYear(), m.getMonth(), n);
      const past = d < today, taken = isTaken(booking.id, d);
      const t = d.getTime(), s = booking.start?.getTime(), e = (booking.end || booking.start)?.getTime();
      const cls = [past && "past", taken && "taken", s === t && "start", e === t && "end", s != null && t > s && t < e && "in", bad && t >= s && t <= e && "bad"].filter(Boolean).join(" ");
      const label = `${nice(d)}${taken ? ", taken" : past ? ", in the past" : ", open"}`;
      cells.push(`<button type="button" class="cal-day ${cls}" data-day="${iso(d)}" aria-label="${label}" aria-pressed="${s != null && t >= s && t <= e}" ${past || taken ? "disabled" : ""}>${n}</button>`);
    }
    return `<div class="cal-month"><h3>${MONTHS[m.getMonth()]} ${m.getFullYear()}</h3>
      <div class="cal-grid">${["M", "T", "W", "T", "F", "S", "S"].map((x) => `<span class="cal-dow" aria-hidden="true">${x}</span>`).join("")}${cells.join("")}</div></div>`;
  }).join("");
  $("cal-months").querySelectorAll("button[data-day]").forEach((b) => (b.onclick = () => pickDay(b.dataset.day)));
  renderStatus(bad);
}

function pickDay(dayIso) {
  const [y, m, d] = dayIso.split("-").map(Number);
  const day = new Date(y, m - 1, d);
  if (!booking.start || booking.end || day < booking.start) { booking.start = day; booking.end = null; }
  else booking.end = day;
  drawCalendar();
  $("cal-months").querySelector(`[data-day="${dayIso}"]`)?.focus();
}

function renderStatus(bad) {
  const st = $("cal-status"), btn = $("cal-confirm");
  st.classList.toggle("bad", !!bad);
  if (!booking.start) { st.textContent = "Pick the first day, then the last."; btn.disabled = true; return; }
  if (bad) {
    st.textContent = `${nice(bad)} is taken. Pick dates around it.`;
    btn.disabled = true;
    return;
  }
  const days = Math.round(((booking.end || booking.start) - booking.start) / DAY) + 1;
  st.textContent = booking.end
    ? `${nice(booking.start)} to ${nice(booking.end)}, ${days} days. All open.`
    : `${nice(booking.start)}, one day. Pick a last day too, or confirm just this one.`;
  btn.disabled = false;
}

function confirmDates() {
  if ($("cal-confirm").disabled) return;
  const { start, venue, id } = booking;
  const end = booking.end || start;
  const days = Math.round((end - start) / DAY) + 1;
  const fee = venue ? feeEstimate(venue) : null;
  $("book-stub").innerHTML = `
    <p class="stub-dates">${nice(start)}${days > 1 ? ` to<br>${nice(end)}` : ""}</p>
    <p class="stub-venue">${esc(venue?.name || "This venue")}${venue?.best_space ? `, ${esc(venue.best_space.space_name)}` : ""}</p>
    <dl class="specs">
      <div><dt>Days</dt><dd>${days}</dd></div>
      <div><dt>Rent, our estimate</dt><dd>${fee ? `$${(fee * days).toLocaleString()}` : "Ask"}</dd></div>
      <div><dt>Status</dt><dd>Pencilled in, not confirmed</dd></div>
    </dl>`;
  $("book-done").hidden = true;
  revealAndScroll($("book-next"));
  try { sessionStorage.setItem(`stagehand.dates.${id}`, JSON.stringify({ start: iso(start), end: iso(end) })); } catch { /* private window */ }
  prefillForm();
}

function revealAndScroll(el) {
  el.hidden = false;
  el.classList.remove("reveal");
  void el.offsetWidth;
  if (!reduced()) el.classList.add("reveal");
  requestAnimationFrame(() => el.scrollIntoView({ behavior: reduced() ? "auto" : "smooth", block: "start" }));
}

// ------------------------------------------------------------------ booking: the form

const digits = (v) => String(v || "").replace(/\D/g, "");

function luhn(num) {
  let sum = 0, dbl = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let d = Number(num[i]);
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d; dbl = !dbl;
  }
  return num.length >= 13 && num.length <= 19 && sum % 10 === 0;
}

function prefillForm() {
  const brief = $("brief")?.value || "";
  const audience = Number((brief.match(/(\d+)\s*(?:guests|people|audience|seats)/i) || [])[1]);
  const group = Number((brief.match(/(\d+)\s*(?:singers|members|voices|performers|crew)/i) || [])[1]);
  if (audience) $("bf-guests").value = audience;
  if (group) $("bf-crew").value = group;
}

const CHECKS = {
  "bf-name": (v) => v.trim().length >= 2 || "Add your name.",
  "bf-email": (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim()) || "That email doesn't look right.",
  "bf-phone": (v) => digits(v).length >= 7 || "Add a phone number the venue can call.",
  "bf-ccname": (v) => v.trim().length >= 2 || "Add the name on the card.",
  "bf-cc": (v) => luhn(digits(v)) || "That card number doesn't check out.",
  "bf-exp": (v) => {
    const m = v.match(/^(\d{2})\s*\/\s*(\d{2})$/);
    if (!m || +m[1] < 1 || +m[1] > 12) return "Use MM/YY.";
    const end = new Date(2000 + +m[2], +m[1], 1);
    return end > new Date() || "That card has expired.";
  },
  "bf-cvc": (v) => /^\d{3,4}$/.test(v.trim()) || "3 or 4 digits.",
  "bf-zip": (v) => /^[A-Za-z0-9 -]{3,10}$/.test(v.trim()) || "Add the billing ZIP.",
  "bf-guests": (v) => (+v >= 1 && +v <= 5000) || "How many guests?",
  "bf-crew": (v) => (+v >= 1 && +v <= 500) || "How many performers?",
};

function check(id) {
  const el = $(id);
  const res = id === "bf-ok" ? (el.checked || "Tick this to send the request.") : CHECKS[id](el.value);
  const msg = res === true ? "" : res;
  $(`${id}-err`).textContent = msg;
  el.setAttribute("aria-invalid", msg ? "true" : "false");
  el.setAttribute("aria-describedby", `${id}-err`);
  return !msg;
}

let formWired = false;
function wireBookForm() {
  if (formWired) return;
  formWired = true;
  const form = $("book-form");
  Object.keys(CHECKS).forEach((id) => $(id).addEventListener("blur", () => { if ($(id).value) check(id); }));
  // the card picture fills in as you type
  $("bf-cc").addEventListener("input", (e) => {
    const d = digits(e.target.value).slice(0, 19);
    e.target.value = d.replace(/(.{4})/g, "$1 ").trim();
    $("card-num").textContent = (d + "\u2022".repeat(Math.max(0, 16 - d.length))).replace(/(.{4})/g, "$1 ").trim();
  });
  $("bf-ccname").addEventListener("input", (e) => { $("card-name").textContent = e.target.value.toUpperCase() || "YOUR NAME"; });
  $("bf-exp").addEventListener("input", (e) => {
    const d = digits(e.target.value).slice(0, 4);
    e.target.value = d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d;
    $("card-exp").textContent = e.target.value || "MM/YY";
  });
  $("bf-cvc").addEventListener("input", (e) => { e.target.value = digits(e.target.value).slice(0, 4); });
  // once a field has been flagged, re-check it as it's fixed
  const recheck = (e) => {
    const id = e.target.id;
    if ((CHECKS[id] || id === "bf-ok") && e.target.getAttribute("aria-invalid") === "true") check(id);
    if (!form.querySelector('[aria-invalid="true"]')) $("bf-status").textContent = "";
  };
  form.addEventListener("input", recheck);
  form.addEventListener("change", recheck);
  form.addEventListener("submit", submitBooking);
}

async function submitBooking(e) {
  e.preventDefault();
  const ids = [...Object.keys(CHECKS), "bf-ok"];
  const ok = ids.map(check).every(Boolean);
  if (!ok) {
    $("bf-status").textContent = "A few things need a look.";
    $(ids.find((id) => $(id).getAttribute("aria-invalid") === "true"))?.focus();
    return;
  }
  const { start, id, venue } = booking;
  const end = booking.end || start;
  const days = Math.round((end - start) / DAY) + 1;
  const when = days > 1 ? `${nice(start)} to ${nice(end)}` : nice(start);
  const name = $("bf-name").value.trim();
  const notes = [
    `Booking request for ${when}.`,
    `Contact: ${name}, ${$("bf-email").value.trim()}, ${$("bf-phone").value.trim()}.`,
    $("bf-time").value ? `Doors at ${$("bf-time").value}.` : "",
    $("bf-notes").value.trim(),
  ].filter(Boolean).join(" ");
  const btn = $("bf-go");
  btn.disabled = true;
  btn.textContent = "Sending";
  $("bf-status").textContent = "";
  // Only the booking details go to the server. Card fields are never sent anywhere.
  try {
    const res = await fetch("/api/pipeline", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        venue_id: id, event_date: when, audience: +$("bf-guests").value, group_size: +$("bf-crew").value,
        nights: Math.max(1, days), group_name: $("bf-group").value.trim() || name, status: "drafted", notes,
      }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.detail || `HTTP ${res.status}`);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = "Request booking";
    $("bf-status").textContent = `That didn't go through: ${err.message}. Try again in a moment.`;
    return;
  }
  const last4 = digits($("bf-cc").value).slice(-4);
  ["bf-cc", "bf-exp", "bf-cvc"].forEach((x) => { $(x).value = ""; });
  $("card-num").textContent = "\u2022\u2022\u2022\u2022 \u2022\u2022\u2022\u2022 \u2022\u2022\u2022\u2022 \u2022\u2022\u2022\u2022";
  $("card-exp").textContent = "MM/YY";
  btn.disabled = false;
  btn.textContent = "Request booking";
  window.dispatchEvent(new CustomEvent("pipeline:changed"));
  $("done-stub").innerHTML = $("book-stub").innerHTML.replace("Pencilled in, not confirmed", "Requested, waiting on the venue")
    + `<p class="stub-venue">For ${esc(name)}. Card ending ${esc(last4)} checked, not charged.</p>`;
  document.querySelectorAll("#book-done .venue-name").forEach((el) => { el.textContent = venue?.name || "the venue"; });
  revealAndScroll($("book-done"));
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
    if (!card || state.quietCard) return;
    const id = Number(card.dataset.id);
    state.venueId = id;
    setPhoto(id);
    if (location.hash !== `#/venue/${id}`) history.pushState(null, "", `#/venue/${id}`);
  });
}

// ------------------------------------------------------------------ film results open the property page

$("film-list").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-venue]");
  if (!b) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  go(`#/venue/${b.dataset.venue}`);
}, true);

// ------------------------------------------------------------------ boot

wireSearch();
wireZoom();
wireSaving();
watchVenueName();
// The opening page and Side B: real buildings from the inside or from the side, never straight down.
[["snap-right", 6531330], ["snap-left", 9530669], ["snap-sticker", 9956355], ["sideb-photo", 6531330],
  ["snap-left-a", 9438497], ["snap-left-b", 10183484], ["snap-left-c", 5316122]]
  .forEach(([id, venue]) => $(id) && showPicture($(id), venue));
window.addEventListener("popstate", route);
window.addEventListener("hashchange", route);
firstView();
renderShelf();
