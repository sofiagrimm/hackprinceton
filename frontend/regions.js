// Estimated venues outside Los Angeles and Houston.
//
// The main scout only knows the two scanned metros. This module listens to the
// same brief box first: if the brief is about Northern California or the
// Florida Panhandle, it runs /api/regions/scout instead and shows the results
// in its own section, with an "Estimated" note and no Matterport tour (nobody
// has scanned these rooms).

import { RoomSound } from "./audio.js";
import { createHero } from "./hero3d.js";
import { sunPosition, localToUtc, utcOffsetFor } from "./sun.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const MAIN_SECTIONS = ["plan", "pick", "sound", "light", "walk", "stay", "fund", "reach", "more"];
const MAIN_ALIASES = {
  "los angeles": "Los Angeles", "la": "Los Angeles", "l.a.": "Los Angeles", "hollywood": "Los Angeles",
  "houston": "Houston", "htx": "Houston",
};
const DEMO = "Our Berkeley group wants to sing in San Francisco for 120 people";

const state = { overview: null, aliases: {}, search: null, current: null, hero: null, crowd: "full", busy: false };
const sound = new RoomSound();

// ------------------------------------------------------------------ city detection
// Mirrors region_cities.find_in_text: the city after "in", "at" or "to" wins,
// and "our Berkeley group" doesn't count as a destination.

export function detectCity(text) {
  const t = ` ${text.toLowerCase()} `;
  const all = { ...MAIN_ALIASES, ...state.aliases };
  const hits = [];
  for (const [alias, city] of Object.entries(all).sort((a, b) => b[0].length - a[0].length)) {
    if (alias.length <= 3 && !["sf", "sac", "la", "htx"].includes(alias)) continue;
    const re = new RegExp(`(?<![a-z])${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z])`, "g");
    for (const m of t.matchAll(re)) {
      const before = t.slice(Math.max(0, m.index - 14), m.index);
      let w = /\b(in|at|to|near|around|visiting|touring)\s+(the\s+)?$/.test(before) ? 2 : 1;
      if (/\b(our|from|my)\s+$/.test(before)) w = 0;
      hits.push({ w, at: m.index, city });
    }
  }
  if (!hits.length) return null;
  hits.sort((a, b) => b.w - a.w || a.at - b.at);
  const city = hits[0].city;
  return city === "Los Angeles" || city === "Houston" ? null : city;
}

// ------------------------------------------------------------------ boot

async function boot() {
  try {
    state.overview = await (await fetch("/api/regions")).json();
    state.aliases = state.overview.aliases || {};
  } catch { return; }
  renderPicker();
  addExample();
  interceptBrief();
}

function addExample() {
  const row = $("examples");
  if (!row) return;
  row.insertAdjacentHTML("beforeend", `<span class="sep">·</span>`);
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = "Bay Area";
  b.onclick = () => { $("brief").value = DEMO; $("brief").focus(); };
  row.appendChild(b);
}

function interceptBrief() {
  // Capture phase, so this runs before app.js sees the submit or the Enter key.
  const take = (e) => {
    const brief = $("brief").value.trim();
    if (!brief || !detectCity(brief)) { showIntro(); return; }
    e.preventDefault();
    e.stopImmediatePropagation();
    run(brief);
  };
  document.addEventListener("submit", (e) => { if (e.target.id === "ask") take(e); }, true);
  document.addEventListener("keydown", (e) => {
    if (e.target.id === "brief" && e.key === "Enter" && !e.shiftKey) take(e);
  }, true);
}

function showIntro() {
  ["rg-results", "rg-3d-wrap", "rg-more"].forEach((id) => ($(id).hidden = true));
  $("rg-intro").hidden = false;
}

function renderPicker() {
  const byRegion = {};
  for (const c of state.overview.cities) (byRegion[c.region] ||= []).push(c);
  $("rg-picker").innerHTML = Object.entries(byRegion).map(([region, cities]) => `
    <li>
      <span class="rg-region">${esc(region)}</span>
      <span class="rg-cities">${cities.map((c) => `<button type="button" data-city="${esc(c.name)}">${esc(c.name)}</button>`).join("")}</span>
    </li>`).join("");
  document.querySelectorAll("#rg-picker [data-city]").forEach((b) => {
    b.onclick = () => {
      const brief = `14 singers in ${b.dataset.city}. A show for 80 guests, 2 nights.`;
      $("brief").value = brief;
      run(brief);
    };
  });
  if (!state.overview.ready) {
    $("rg-status").textContent = "The region data hasn't been built yet. Run scripts/build_regions.py.";
  }
}

// ------------------------------------------------------------------ run a brief

async function run(brief) {
  if (state.busy) return;
  state.busy = true;
  MAIN_SECTIONS.forEach((id) => { if ($(id)) $(id).hidden = true; });
  if ($("nav-links")) $("nav-links").hidden = true;
  showIntro();
  $("rg-status").textContent = `Looking for rooms in ${detectCity(brief) || "that city"}…`;
  $("regions").scrollIntoView({ behavior: "smooth" });
  const go = $("go");
  if (go) { go.disabled = true; go.textContent = "Scouting…"; }

  let summary = "";
  try {
    const res = await fetch("/api/regions/scout", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ brief }),
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const ev = JSON.parse(line);
        if (ev.type === "tool_result" && ev.name === "search_region_venues") onSearch(ev.result);
        if (ev.type === "tool_result" && ev.name === "region_site_check" && state.current) state.current.site = ev.result;
        if (ev.type === "message") summary = ev.text;
        if (ev.type === "error") $("rg-status").textContent = ev.text;
      }
    }
  } catch (err) {
    $("rg-status").textContent = `Something went wrong. ${err}`;
  }
  if (go) { go.disabled = false; go.textContent = "Scout"; }
  state.busy = false;
  if (state.search?.results?.length) {
    $("rg-summary").textContent = summary;
    ["rg-results", "rg-3d-wrap", "rg-more"].forEach((id) => ($(id).hidden = false));
    $("rg-intro").hidden = true;
    await showVenue(state.search.results[0], state.search.lodging);
  } else if (!state.search?.error) {
    $("rg-status").textContent = summary || "Nothing big enough turned up there. Try a smaller audience.";
  }
}

function onSearch(result) {
  state.search = result;
  if (result.error) { $("rg-status").textContent = result.error; return; }
  state.current = { card: result.results[0] };
  $("rg-status").textContent = `Estimated ${result.venues_considered} buildings in ${result.metro}.`;
}

// ------------------------------------------------------------------ one venue

async function showVenue(card, lodging) {
  state.current = { ...(state.current?.card?.venue_id === card.venue_id ? state.current : {}), card };
  const a = card.best_space.acoustics;
  const b = card.building;

  $("rg-name").textContent = card.name;
  $("rg-address").textContent = [card.address, card.metro].filter(Boolean).join(", ") + ".";
  $("rg-figures").innerHTML = [
    { n: `${a.rt60_occupied_s}<small>sec</small>`, l: `of reverb with ${a.audience} people in, estimated`, good: a.score >= 85 },
    { n: a.capacity_seated, l: `seats in the ${esc(card.best_space.space_name.toLowerCase())}, roughly` },
    { n: `${Math.round(b.footprint_sqft / 1000)}k<small>sq ft</small>`, l: "building footprint" },
    { n: `${Math.round(b.height_ft)}<small>ft</small>`, l: "to the top of the roof" },
  ].map((x) => `<div class="fig ${x.good ? "good" : ""}"><div class="n">${x.n}</div><div class="l">${x.l}</div></div>`).join("");
  $("rg-verdict").textContent = a.verdict;
  $("rg-basis").textContent = [
    `We guessed the ${card.best_space.space_name.toLowerCase()} is about ${card.best_space.area_sqft.toLocaleString()} sq ft with a ${Math.round(card.best_space.height_ft)} ft ceiling.`,
    ...card.best_space.basis,
    `Finishes assumed for a ${card.kind_label}: ${a.assumptions.floor} floor, ${a.assumptions.walls} walls, ${a.assumptions.ceiling} ceiling.`.replaceAll("_", " "),
  ].join(" ");

  renderList();
  renderListen();

  const site = state.current.site?.venue_id === card.venue_id
    ? state.current.site
    : await (await fetch(`/api/regions/venues/${encodeURIComponent(card.venue_id)}/site`)).json();
  state.current.site = site;
  $("rg-model-note").textContent = site.vexcel_covered && site.aerial_image_url
    ? "The building from Vexcel's aerial survey."
    : site.vexcel_covered
      ? "The building outline from OpenStreetMap. Vexcel covers this city but had no footprint here."
      : `The building outline from OpenStreetMap. Vexcel's imagery doesn't reach ${card.metro}.`;
  draw3d(site, card);

  const stay = lodging && lodging.venue_id === card.venue_id ? lodging
    : await (await fetch(`/api/regions/venues/${encodeURIComponent(card.venue_id)}/housing?group_size=14&nights=2`)).json();
  renderLodging(stay);
}

function draw3d(site, card) {
  if (!state.hero) {
    try { state.hero = createHero($("rg-3d"), { zoom: 1.6 }); } catch (err) { console.warn("WebGL unavailable", err); return; }
  }
  state.hero.showVenue(site, site.aerial_image_url || "data:,").then(() => {
    state.hero.setScroll(1);
    const city = state.overview.cities.find((c) => c.name === card.metro);
    const today = new Date().toISOString().slice(0, 10);
    const dst = utcOffsetFor("Los Angeles", today) + 8;
    const offset = (city?.utc_offset ?? -8) + dst;
    state.hero.setSun(sunPosition(localToUtc(today, 16 * 60, offset), site.lat, site.lon));
    state.hero.setReverb(card.best_space.acoustics.rt60_occupied_s);
  });
}

function renderList() {
  const results = state.search?.results || [];
  $("rg-list").innerHTML = results.map((r, i) => {
    const a = r.best_space.acoustics;
    const on = r.venue_id === state.current.card.venue_id;
    return `
      <li class="${on ? "on" : ""}">
        <button type="button" class="name" data-i="${i}">${esc(r.name)}</button>
        <span class="price">${a.rt60_occupied_s}s</span>
        <span class="meta">${esc(cap(r.kind_label))}${r.denomination ? `, ${esc(r.denomination)}` : ""}. About ${a.capacity_seated} seats. ${esc(shortVerdict(a))}</span>
      </li>`;
  }).join("");
  document.querySelectorAll("#rg-list [data-i]").forEach((b) => {
    b.onclick = () => {
      showVenue(results[Number(b.dataset.i)]);
      $("rg-name").scrollIntoView({ behavior: "smooth", block: "center" });
    };
  });
  $("rg-coverage").textContent = state.search?.coverage_note || "";
}

function renderLodging(stay) {
  const opts = stay?.options || [];
  $("rg-lodging").innerHTML = opts.map((o) => `
    <li>
      <span class="name">${o.website ? `<a href="${esc(o.website)}" target="_blank" rel="noopener">${esc(o.name)}</a>` : esc(o.name)}</span>
      <span class="price">${o.distance_miles} mi</span>
      <span class="meta">${o.stars ? `${o.stars} stars. ` : ""}${o.rooms ? `${o.rooms} rooms. ` : ""}No rate on file, so ask for a group rate.</span>
    </li>`).join("") || `<li><span class="meta">No hotels within three miles in OpenStreetMap.</span></li>`;
}

// ------------------------------------------------------------------ listen

function renderListen() {
  const a = state.current.card.best_space.acoustics;
  sound.setRoom(state.crowd === "full" ? a.rt60_occupied_s : a.rt60_empty_s, a.volume_m3);
}

function wireListen() {
  $("rg-play").onclick = async () => {
    renderListen();
    const seconds = await sound.playChoir();
    state.hero?.pulse(seconds);
  };
  document.querySelectorAll("[data-rg-crowd]").forEach((b) => {
    b.onclick = () => {
      state.crowd = b.dataset.rgCrowd;
      document.querySelectorAll("[data-rg-crowd]").forEach((x) => x.classList.toggle("on", x === b));
      if (state.current) renderListen();
    };
  });
}

// ------------------------------------------------------------------ helpers

function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : ""; }

function shortVerdict(a) {
  const [lo, hi] = a.target_s;
  if (a.rt60_occupied_s < lo) return "On the dry side.";
  if (a.rt60_occupied_s > hi * 1.6) return "Very live. Fast songs will blur.";
  if (a.rt60_occupied_s > hi) return "A little live.";
  return "About right for unamplified voices.";
}

wireListen();
boot();
