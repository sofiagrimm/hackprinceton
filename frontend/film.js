// Film mode: location scouting for a film crew on the same buildings.
// Self-contained: it only talks to /api/film and only touches #film.

const root = document.getElementById("film");
const $ = (sel) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (n) => Number(n || 0).toLocaleString();

const DIRS = [["n", "From the north"], ["e", "From the east"], ["s", "From the south"], ["w", "From the west"]];
const LABELS = {
  parcel_sqft: "Parcel",
  building_footprint_sqft: "Building footprint",
  unbuilt_sqft: "Open ground",
  paved_sqft: "Paved",
  truck_width_paved_sqft: "Paved and wide enough for a trailer",
  tree_cover_percent: "Tree cover",
  vehicles_at_capture: "Cars parked at capture",
  costar_parking_spaces: "Parking spaces on record",
};
const SOURCE = { measured: "Measured", estimated: "Estimated" };

let brief = null;
let results = [];

function boot() {
  $("#film-ask").addEventListener("submit", (e) => { e.preventDefault(); search(); });
  $("#film-brief").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); search(); }
  });
  const params = new URLSearchParams(location.search);
  if (params.get("film")) {
    $("#film-brief").value = params.get("film");
    search().then(() => root.scrollIntoView());
  }
}

async function search() {
  const text = $("#film-brief").value.trim();
  if (!text) return;
  const btn = $("#film-go");
  btn.disabled = true;
  $("#film-status").textContent = "Looking through every scanned room.";
  $("#film-results").hidden = true;
  $("#film-detail").hidden = true;
  try {
    const res = await fetch(`/api/film/search?brief=${encodeURIComponent(text)}&max_results=6`);
    const data = await res.json();
    brief = data.brief;
    results = data.results || [];
    renderList(data);
    if (results.length) await openLocation(0);
  } catch (err) {
    $("#film-status").textContent = "The search didn't go through. Try again in a moment.";
  } finally {
    btn.disabled = false;
  }
}

function renderList(data) {
  const b = data.brief;
  const start = new Date(b.start_date + "T12:00:00");
  const when = start.toLocaleDateString(undefined, { month: "long", day: "numeric" });
  const weeks = b.shoot_days >= 7 ? `${Math.round(b.shoot_days / 7)} week${b.shoot_days >= 14 ? "s" : ""}` : `${b.shoot_days} days`;
  $("#film-status").textContent = results.length
    ? `${b.crew} crew in ${b.metro}, ${weeks} from ${when}. We checked ${num(data.venues_with_rooms)} buildings with rooms big enough.`
    : "Nothing big enough came up. Try a smaller crew.";
  $("#film-list").innerHTML = results.map((r, i) => `
    <li>
      <button type="button" data-i="${i}" class="${i === 0 ? "on" : ""}">
        <span class="film-rank">${i + 1}</span>
        <span class="film-row-main">
          <span class="film-row-name">${esc(r.name)}</span>
          <span class="film-row-meta">${esc(cleanSpace(r.space.name, r.name))}. ${num(r.space.area_sqft)} sq ft, ${r.space.height_ft} ft ceiling, ${r.space.rt60_s} s reverb. ${esc(r.noise.label)} outside.</span>
        </span>
        <span class="film-row-score">${r.match_score}</span>
      </button>
    </li>`).join("");
  $("#film-list").querySelectorAll("button").forEach((b) => (b.onclick = () => openLocation(Number(b.dataset.i), true)));
  $("#film-results").hidden = !results.length;
}

async function openLocation(i, scroll = false) {
  const r = results[i];
  $("#film-list").querySelectorAll("button").forEach((b) => b.classList.toggle("on", Number(b.dataset.i) === i));
  const detail = $("#film-detail");
  detail.hidden = false;
  detail.classList.add("loading");
  $("#film-name").textContent = r.name;
  $("#film-address").textContent = r.address;
  if (scroll) detail.scrollIntoView({ behavior: "smooth", block: "start" });
  renderObliques(r.venue_id);

  const q = new URLSearchParams({ crew: brief.crew, start_date: brief.start_date, shoot_days: brief.shoot_days });
  const rep = await (await fetch(`/api/film/${r.venue_id}/report?${q}`)).json();
  if (results[i] !== r || detail.hidden) return;
  detail.classList.remove("loading");
  renderFigures(r, rep);
  renderBaseCamp(rep.base_camp);
  renderNoise(rep.noise);
  renderLight(rep);
}

function renderFigures(r, rep) {
  const s = r.space;
  $("#film-room").textContent = `${cleanSpace(s.name, r.name)}. ${s.dialogue_verdict}`;
  const figs = [
    [s.rt60_s, "s", "Reverb with the crew in. Dialogue wants 0.3 to 0.6."],
    [num(s.area_sqft), "sq ft", "Floor area of the room"],
    [s.height_ft, "ft", s.height_source === "measured" ? "Ceiling, from the scan" : s.height_source === "costar" ? "Ceiling, from CoStar" : "Ceiling, assumed"],
    [rep.noise.score, "of 5", "Outside noise, 1 is quiet"],
  ];
  $("#film-figures").innerHTML = figs.map(([n, unit, l]) =>
    `<div class="fig"><div class="n">${esc(n)}<small>${esc(unit)}</small></div><div class="l">${esc(l)}</div></div>`).join("");
}

function renderObliques(id) {
  $("#film-obliques").innerHTML = DIRS.map(([d, label]) => `
    <figure>
      <div class="film-shot" data-empty="No photo from this side yet."><img alt="${label}" loading="lazy" src="/api/film/${id}/oblique/${d}.jpg"></div>
      <figcaption>${label}</figcaption>
    </figure>`).join("");
  $("#film-obliques").querySelectorAll("img").forEach((img) => {
    img.onerror = () => {
      const frame = img.parentElement;
      img.remove();
      frame?.classList.add("empty");
    };
  });
}

function renderBaseCamp(bc) {
  const e = bc.estimated;
  $("#film-trailers").innerHTML = `${e.trailers_fit}<small>trailers</small>`;
  $("#film-camp-verdict").textContent = bc.verdict;
  const rows = [];
  for (const kind of ["measured", "estimated"]) {
    for (const [k, v] of Object.entries(bc[kind] || {})) {
      if (!(k in LABELS)) continue;
      const val = k.endsWith("_percent") ? `${v}%` : k.endsWith("_sqft") ? `${num(v)} sq ft` : num(v);
      rows.push(`<div><dt>${LABELS[k]}</dt><dd>${val} <span class="film-src">${SOURCE[kind]}</span></dd></div>`);
    }
  }
  rows.push(`<div><dt>Trailers you need</dt><dd>${e.trailers_needed} <span class="film-src">Estimated</span></dd></div>`);
  rows.push(`<div><dt>Crew cars that fit, you need ${e.crew_cars_needed}</dt><dd>${num(e.crew_cars_fit)} <span class="film-src">Estimated</span></dd></div>`);
  $("#film-camp-specs").innerHTML = rows.join("");
  const map = $("#film-camp-map");
  map.hidden = !bc.map_url;
  if (bc.map_url) map.querySelector("img").src = bc.map_url;
  const lots = bc.overflow_lots || [];
  $("#film-overflow").textContent = lots.length
    ? `If you need more room, ${lots.map((l) => `${l.name} has ${num(l.parking_spaces)} spaces ${l.distance_miles} miles away`).join(", and ")}.`
    : "";
  $("#film-camp-note").textContent = bc.assumptions + (bc.capture_date ? ` Aerial from ${bc.capture_date.slice(0, 7)}.` : "");
}

function renderNoise(n) {
  $("#film-noise").innerHTML = `
    <p class="film-big">${esc(n.label)}.</p>
    <p class="film-text">${esc(n.summary)}</p>
    <dl class="specs cols">
      <div><dt>Nearest freeway</dt><dd>${esc(n.nearest_freeway.name)}, ${dist(n.nearest_freeway.distance_m)}</dd></div>
      <div><dt>Nearest airport</dt><dd>${esc(n.nearest_airport.code)}, ${dist(n.nearest_airport.distance_m)}</dd></div>
      <div><dt>Nearest rail line</dt><dd>${esc(n.nearest_rail.name)}, ${dist(n.nearest_rail.distance_m)}</dd></div>
      <div><dt>Busy street out front</dt><dd>${esc(n.busy_street || "None")}</dd></div>
    </dl>`;
}

function renderLight(rep) {
  const rows = rep.light.map((d) => {
    const date = new Date(d.date + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    const walls = d.facades.map((f) => `${f.facade} ${f.sun.join(", ")}`).join("<br>");
    return `<tr><th scope="row">${date}</th><td>${d.sunrise}</td><td>${d.golden_morning}</td><td>${d.golden_evening}</td><td>${d.sunset}</td><td class="film-walls">${walls}</td></tr>`;
  }).join("");
  $("#film-light").innerHTML = `
    <table>
      <thead><tr><th scope="col">Shoot day</th><th scope="col">Sunrise</th><th scope="col">Morning golden hour</th><th scope="col">Evening golden hour</th><th scope="col">Sunset</th><th scope="col">Sun on each wall</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  $("#film-light-note").textContent = rep.facade_source === "Vexcel building footprint"
    ? "Walls come from the Vexcel building footprint. Times are local."
    : "We had no footprint for this building, so the walls are assumed to face north, east, south and west. Times are local.";
}

function dist(m) { return m < 1000 ? `${num(m)} m` : `${(m / 1000).toFixed(1)} km`; }

function cleanSpace(space, venue) {
  let s = String(space || "");
  if (s.toLowerCase().startsWith(String(venue).toLowerCase())) s = s.slice(venue.length).replace(/^[\s\-:]+/, "") || s;
  return s.replace(/\s+-\s+[\d,]+\s*RSF\s*$/i, "").trim();
}

boot();
