import { RoomSound } from "./audio.js";
import { sunPosition, dayTimeline, utcOffsetFor, localToUtc, fmtMinute } from "./sun.js";
import { createHero } from "./hero3d.js";
import { createVinylHero } from "./vinyl.js";
import { loadTour, sdkUsable } from "./tour.js";
import { drawRoomMap } from "./roommap.js";
import { createRoomViewer } from "./roomview.js";
import { createDaylight } from "./daylight.js";
import { createPlayRoom } from "./playroom.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtMoney = (n, digits) => {
  const v = Number(n || 0);
  const body = Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return (v < 0 ? "\u2212$" : "$") + body;
};
const money = (n) => fmtMoney(n, 0);
const money2 = (n) => fmtMoney(n, 2);
const sound = new RoomSound();

const DEFAULT_VENUE = 9530669; // 3033 Wilshire, Los Angeles: the hero before the first search

const state = {
  config: null, brief: null, search: null,
  analyses: {}, housing: {}, outreach: {}, site: {},
  venue: null, spaceIndex: 0, crowd: "full", roomOverride: null,
};

const EXAMPLES = [
  ["A cappella in LA", "14 singers touring LA on March 14. A show for 80 guests, 2 nights, same building if we can."],
  ["Rehearsal retreat", "We need a rehearsal space in Houston for 12 singers for a 3 day retreat, about 20 people in the room, plus somewhere to sleep."],
  ["Choir concert", "A 30-voice choir wants a resonant space in Los Angeles for a concert for 150 guests on April 2, staying 1 night."],
  ["Film shoot", "Indie film crew of 25 needs a quiet location in Los Angeles with good dialogue sound for a 3 week shoot, 40 people on set."],
];

const AGENT_LABEL = { claude: "Claude", deepagents: "Deep Agents", planner: "Built-in planner" };
const TOOL_LABEL = {
  search_venues: "Search scanned rooms",
  analyze_venue: "Measure the acoustics",
  site_check: "Check the site from the air",
  find_housing: "Find somewhere to stay",
  tour_budget: "Check the tour fund",
  draft_outreach: "Draft the ask",
};

let hero = null;
let lightScene = null;

// ------------------------------------------------------------------ boot

// Fast planner (fixed steps, a few seconds) or the AI agent (plans its own steps, a minute or two).
function wireScoutMode() {
  const ai = state.config?.ai_agent;
  if (!ai || !$("scout-mode")) return;
  state.mode = "planner";
  $("scout-mode").hidden = false;
  $("mode-ai").textContent = `AI agent (${AGENT_LABEL[ai] || ai})`;
  const notes = { planner: "A few seconds. Fixed steps.", ai: "A minute or two. It plans its own steps and hands work to two helper agents." };
  document.querySelectorAll("[data-mode]").forEach((b) => {
    b.onclick = () => {
      state.mode = b.dataset.mode;
      document.querySelectorAll("[data-mode]").forEach((x) => x.classList.toggle("on", x === b));
      $("mode-note").textContent = notes[state.mode];
    };
  });
}

async function boot() {
  EXAMPLES.forEach(([label, text], i) => {
    if (i) $("examples").insertAdjacentHTML("beforeend", `<span class="sep">·</span>`);
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.onclick = () => { $("brief").value = text; $("brief").focus(); };
    $("examples").appendChild(b);
  });
  $("ask").onsubmit = (e) => { e.preventDefault(); runScout(); };
  $("brief").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); runScout(); }
  });
  $("nav-cta").onclick = (e) => {
    e.preventDefault();
    window.scrollTo({ top: 0, behavior: "smooth" });
    setTimeout(() => $("brief").focus(), 500);
  };

  if ($("hero3d")) {
    try { hero = createVinylHero($("hero3d")); } catch (err) { console.warn("Hero unavailable", err); }
    $("hero3d").addEventListener("click", onRecordTap);
  }
  $("hero-record")?.addEventListener("click", playHeroRecord);
  try { state.config = await (await fetch("/api/config")).json(); } catch { /* offline */ }
  wireScoutMode();
  loadValidation();

  wireStage();
  wireListen();
  wireSun();
  wireTour();

  const params = new URLSearchParams(location.search);
  const venueId = Number(params.get("venue"));
  if (venueId) {
    await openVenue(venueId);
    if (params.get("listen")) {
      $("sound").scrollIntoView({ behavior: "smooth" });
      $("play-choir").classList.add("pulse");
    }
  } else {
    showHeroVenue(DEFAULT_VENUE);
  }
}

async function loadValidation() {
  try {
    const v = await (await fetch("/api/validation")).json();
    $("d-validation").innerHTML = dlRows(v.halls.map((h) => [
      `${esc(h.hall)}, ${esc(h.city)}`,
      `Measured ${h.published_rt60_s}s, we estimate ${h.estimated_rt60_s}s (${h.error_pct > 0 ? "+" : ""}${h.error_pct}%)`,
    ])) + `<div><dt>Source</dt><dd>${esc(v.source)}</dd></div>`;
  } catch { /* optional */ }
}

async function getSite(id) {
  if (!state.site[id]) state.site[id] = await (await fetch(`/api/venues/${id}/site`)).json();
  return state.site[id];
}

async function showHeroVenue(id, name) {
  if (!hero) return;
  try {
    const site = await getSite(id);
    const photo = state.venue?.photo || state.search?.results?.find((r) => r.venue_id === id)?.photo;
    await hero.showVenue(site, site.aerial_image_url, photo);
  } catch (err) { console.warn(err); }
}

// ------------------------------------------------------------------ the hero records

function wireStage() {
  let queued = false;
  window.addEventListener("scroll", () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      hero?.setScroll(Math.min(1, window.scrollY / Math.max(window.innerHeight, 1)));
    });
  }, { passive: true });
}

// The record in the opening collage: tap to hear a chord in a real scanned room, tap again to stop.
async function playHeroRecord() {
  const rec = $("hero-record");
  if (Date.now() < recordPlayingUntil) { sound.stopChoir(); recordPlayingUntil = 0; rec.classList.remove("playing"); return; }
  if (!state.venue) await openVenue(DEFAULT_VENUE);
  applyRoomSound();
  const seconds = await sound.playChoir();
  recordPlayingUntil = Date.now() + seconds * 1000;
  rec.classList.add("playing");
  setTimeout(() => { if (Date.now() >= recordPlayingUntil - 50) rec.classList.remove("playing"); }, seconds * 1000);
}

async function onRecordTap(e) {
  if (e.target.closest("form, button, textarea, a")) return;
  const rect = $("hero3d").getBoundingClientRect();
  if (!hero?.hitTest(e.clientX - rect.left, e.clientY - rect.top)) return;
  // A second tap while the chord is still playing stops it.
  if (Date.now() < recordPlayingUntil) { sound.stopChoir(); recordPlayingUntil = 0; return; }
  if (!state.venue) await openVenue(DEFAULT_VENUE);
  applyRoomSound();
  const seconds = await sound.playChoir();
  recordPlayingUntil = Date.now() + seconds * 1000;
  hero?.pulse(seconds);
}
let recordPlayingUntil = 0;

// ------------------------------------------------------------------ agent run

async function runScout() {
  const brief = $("brief").value.trim();
  if (!brief || $("go").disabled) return;
  $("go").disabled = true;
  $("go").textContent = "Scouting…";
  $("ask").classList.add("scouting");
  $("timeline").innerHTML = "";
  $("report").innerHTML = "";
  $("plan-title").textContent = "Scouting.";
  ["pick", "sound", "light", "walk", "stay", "fund", "reach", "more"].forEach((s) => ($(s).hidden = true));
  $("plan").hidden = false;
  $("plan").scrollIntoView({ behavior: "smooth" });
  Object.assign(state, { search: null, none: null, analyses: {}, housing: {}, outreach: {} });

  try {
    const res = await fetch("/api/scout", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brief, mode: state.mode === "ai" ? null : "planner" }),
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
        if (line) handleEvent(JSON.parse(line));
      }
    }
  } catch (err) {
    step("err", "Something went wrong", String(err));
  }
  document.querySelectorAll(".steps li.live").forEach((li) => li.classList.replace("live", "done"));
  $("plan-title").textContent = state.search?.results?.length ? "Done." : "Nothing fit yet.";
  // nothing to show: tell the results page so it says so instead of waiting
  if (!state.search?.results?.length) {
    window.dispatchEvent(new CustomEvent("scout:results", { detail: {
      results: [], none: state.none || "audience", metro: state.brief?.metro, place: state.brief?.elsewhere, audience: state.brief?.audience } }));
  }
  $("go").disabled = false;
  $("go").textContent = "Scout";
  $("ask").classList.remove("scouting");
}

function step(cls, title, detail = "") {
  document.querySelectorAll(".steps li.live").forEach((li) => li.classList.replace("live", "done"));
  const li = document.createElement("li");
  li.className = cls;
  li.innerHTML = `<span class="dot"></span><div><div class="t">${esc(title)}</div><div class="d">${detail}</div></div>`;
  $("timeline").appendChild(li);
  return li;
}

function detail(text) {
  const li = $("timeline").lastElementChild;
  if (li) li.querySelector(".d").innerHTML = esc(text);
}

function handleEvent(ev) {
  switch (ev.type) {
    case "agent": $("agent-name").textContent = `Planned by ${ev.name === "planner" ? "the built-in planner" : AGENT_LABEL[ev.name] || ev.name}.`; break;
    case "plan": step("done", "Plan", esc(ev.text)); break;
    case "delegate": step("live", `Ask the ${ev.agent}`, esc(ev.text)); break;
    case "file": step("done", "Write the report", esc(ev.path)); break;
    case "tool": step("live", TOOL_LABEL[ev.name] || ev.name, esc(summarizeInput(ev.input))); break;
    case "tool_result": onToolResult(ev.name, ev.result); break;
    case "message": $("report").innerHTML += md(ev.text); break;
    case "done": state.brief = ev.brief; state.none = ev.none || null; break;
    case "error": step("err", "Error", esc(ev.text)); break;
  }
}

function summarizeInput(input) {
  const parts = [];
  if (input.venue_id && state.search) {
    const v = state.search.results.find((r) => r.venue_id === input.venue_id);
    if (v) parts.push(v.name);
  }
  if (input.metro) parts.push(input.metro);
  if (input.audience) parts.push(`${input.audience} guests`);
  if (input.group_size) parts.push(`${input.group_size} people`);
  if (input.nights) parts.push(`${input.nights} nights`);
  return parts.join(" · ");
}

function venueIdByName(name) {
  return state.search?.results.find((r) => r.name === name)?.venue_id;
}

function onToolResult(name, result) {
  if (result.error) { detail(result.error); return; }
  if (name === "search_venues") {
    state.search = result;
    detail(`${result.results.length} strong matches across ${result.venues_scanned.toLocaleString()} scanned buildings in ${result.metro}.`);
    renderCards();
  } else if (name === "analyze_venue") {
    state.analyses[result.venue_id] = result;
    const s = result.spaces?.[0];
    if (s) detail(`${result.name} · ${s.space_name}: ${s.acoustics.rt60_occupied_s}s with a full house.`);
  } else if (name === "site_check") {
    state.site[result.venue_id] = result;
    detail(result.notes.slice(0, 2).join(" "));
  } else if (name === "find_housing") {
    const vid = venueIdByName(result.venue);
    if (vid) state.housing[vid] = result;
    const o = result.options?.[0];
    if (o) detail(`${o.name}, ${o.distance_miles} mi away, about ${money(o.estimated_total)}.`);
  } else if (name === "tour_budget") {
    if (result.costs) detail(`About ${money(result.costs.total)} for this stop · break-even ticket ${money2(result.break_even_ticket)}.`);
  } else if (name === "draft_outreach") {
    const vid = venueIdByName(result.venue);
    if (vid) state.outreach[vid] = result;
    detail(`To ${result.to?.name || "the venue"}${result.to?.firm ? ", " + result.to.firm : ""}.`);
    if (vid) openVenue(vid);
  }
}

// ------------------------------------------------------------------ other rooms

function renderCards() {
  const r = state.search;
  if (!r?.results.length) return;
  $("cards").innerHTML = r.results.map((v) => {
    const a = v.best_space.acoustics;
    return `
      <button class="card" data-id="${v.venue_id}">
        <img src="${esc(v.photo || "")}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
        <div class="name">${esc(v.name)}</div>
        <div class="meta">${esc(v.best_space.space_name)}. ${a.rt60_occupied_s}s, ${a.capacity_seated} seats.</div>
      </button>`;
  }).join("");
  document.querySelectorAll(".card").forEach((el) => (el.onclick = () => openVenue(Number(el.dataset.id), true)));
  window.dispatchEvent(new CustomEvent("scout:results", { detail: r })); // layout.js renders the results page
}

function scoreColor(score) {
  return score >= 85 ? "var(--good-ink)" : score >= 50 ? "var(--warn)" : "var(--bad)";
}

// ------------------------------------------------------------------ the pick

async function openVenue(id, scroll = false) {
  const use = state.search?.use || "a_cappella_performance";
  const audience = state.search?.audience || 60;
  let v = state.analyses[id];
  if (!v) {
    v = await (await fetch(`/api/venues/${id}?use=${use}&audience=${audience}`)).json();
    state.analyses[id] = v;
  }
  state.venue = v;
  state.spaceIndex = 0;
  state.roomOverride = null;
  ["pick", "sound", "light", "walk", "stay", "fund", "reach"].forEach((s) => ($(s).hidden = false));
  $("more").hidden = !state.search?.results?.length;
  $("nav-links").hidden = false;

  $("d-name").textContent = v.name;
  $("d-address").textContent = `${v.address}.`;
  const eventDate = parseEventDate(state.brief?.event_date);
  if (eventDate) $("sun-date").value = eventDate;

  $("d-spaces").innerHTML = (v.spaces || []).length > 1 ? (v.spaces || []).map((s, i) =>
    `<button data-i="${i}" class="${i === 0 ? "on" : ""}">${esc(cleanSpace(s.space_name, v.name))}</button>`).join("") : "";
  document.querySelectorAll("#d-spaces button").forEach((b) => (b.onclick = () => selectSpace(Number(b.dataset.i))));
  selectSpace(0);

  showHeroVenue(id, v.name);
  loadLight(id);
  const brief = state.brief || {};
  loadHousing(id, brief.group_size || 14, brief.nights || 2).then(() => { renderStats(); loadBudget(id); });
  renderEmail(id);
  resetTour();
  if (scroll) $("pick").scrollIntoView({ behavior: "smooth" });
}

function currentSpace() { return state.venue?.spaces?.[state.spaceIndex]; }

function currentAcoustics() { return state.roomOverride || currentSpace()?.acoustics; }

function renderStats() {
  const s = currentSpace();
  if (!s) return;
  const a = s.acoustics;
  const stay = state.housing[state.venue.venue_id]?.options?.[0];
  const stats = [
    { n: `${a.rt60_occupied_s}<small>sec</small>`, l: "of reverb with a full house", good: a.score >= 85 },
    { n: a.capacity_seated, l: `seats in the ${esc(cleanSpace(s.space_name, state.venue.name).toLowerCase())}` },
    { n: stay ? `${stay.distance_miles}<small>mi</small>` : "None", l: stay ? `to ${esc(stay.name)}` : "lodging found nearby" },
    { n: stay?.estimated_total ? money(stay.estimated_total) : "Ask", l: stay ? `for the group, ${state.brief?.nights || 2} nights` : "" },
  ];
  $("d-stats").innerHTML = stats.map((x) => `<div class="fig ${x.good ? "good" : ""}"><div class="n">${x.n}</div><div class="l">${x.l}</div></div>`).join("");
}

function selectSpace(i) {
  const v = state.venue;
  const s = v.spaces?.[i];
  state.spaceIndex = i;
  state.roomOverride = null;
  document.querySelectorAll("#d-spaces button").forEach((b) => b.classList.toggle("on", Number(b.dataset.i) === i));
  renderStats();
  renderAcoustics();
  resetTour();
}

function renderAcoustics() {
  const s = currentSpace();
  const a = currentAcoustics();
  if (!a) {
    $("d-verdict").textContent = "No measurable room in this scan.";
    return;
  }
  $("d-verdict").textContent = a.verdict;
  $("d-acoustics").innerHTML = dl([
    ["Room", state.roomOverride ? `${esc(state.roomOverride.label)}, from the 3D tour` : roomLabel(cleanSpace(s.space_name, state.venue.name), a.space_label)],
    ["Size", state.roomOverride ? `${Math.round(state.roomOverride.areaSqft).toLocaleString()} sq ft` : `${s.area_sqft.toLocaleString()} sq ft${s.height_ft ? `, ${s.height_ft} ft ceiling` : ""}`],
    ["Reverb", `${a.rt60_empty_s}s empty, ${a.rt60_occupied_s}s with ${a.audience} guests`],
    ["Warmth", a.bass_ratio != null ? `Bass ratio ${a.bass_ratio}. ${a.bass_ratio >= 1.1 ? "Low voices bloom." : a.bass_ratio < 0.9 ? "Bright, a little light in the low end." : "Balanced."}` : "Unknown"],
    ["Clarity", a.c80_db != null ? `C80 ${a.c80_db > 0 ? "+" : ""}${a.c80_db} dB. ${a.c80_db > 3 ? "Every line stays distinct." : a.c80_db < -2 ? "Lines run together; slow arrangements suit it." : "Clear without sounding dry."}` : "Unknown"],
    ["Words", a.sti != null ? `Speech index ${a.sti}. ${a.sti >= 0.6 ? "Lyrics and dialogue come through." : a.sti >= 0.45 ? "Lyrics are understandable if you sing them clearly." : "Words get lost; skip the patter between songs."}` : "Unknown"],
    ["Capacity", `${a.capacity_seated} seated, ${a.capacity_standing} standing`],
    ["Finishes", finishesLine(a)],
  ]);
  renderRtChart(a);
  renderBands(a);
  if (a.dims_m) $("d-mapnote").textContent = drawRoomMap($("roommap"), a);
  applyRoomSound();
  loadPlayRoom();
}

// "Play the room": the current room first, then the venue's other rooms and the other picks to compare with.
let playRoom = null;
function loadPlayRoom() {
  const a = currentAcoustics();
  if (!a?.dims_m || !$("playroom")) return;
  playRoom ||= createPlayRoom($("playroom"));
  const v = state.venue;
  const list = [{ label: state.roomOverride?.label || cleanSpace(currentSpace()?.space_name, v.name) || v.name, acoustics: a }];
  (v.spaces || []).forEach((s, i) => {
    if (i !== state.spaceIndex && s.acoustics?.dims_m) list.push({ label: cleanSpace(s.space_name, v.name), acoustics: s.acoustics });
  });
  (state.search?.results || []).forEach((r) => {
    if (r.venue_id !== v.venue_id && r.best_space?.acoustics?.dims_m) list.push({ label: r.name, acoustics: r.best_space.acoustics });
  });
  playRoom.load(list.slice(0, 12), state.crowd);
}

const FINISH = {
  wood_floor: "wood", polished_stone: "polished stone", acoustic_tile: "acoustic tile", metal_deck: "exposed deck",
  rubber_floor: "rubber", wood_panel: "wood paneling", gypsum: "drywall", open: "open sky",
};
const finish = (m) => FINISH[m] || String(m).replaceAll("_", " ");

function finishesLine(a) {
  const f = `${finish(a.assumptions.floor)} floor, ${finish(a.assumptions.walls)} walls, ${finish(a.assumptions.ceiling)} ceiling`;
  if (a.materials_evidence?.length) {
    return `${esc(f)}. Read from the scan: "${a.materials_evidence.slice(0, 3).map(esc).join('", "')}".`;
  }
  return `${esc(f)}. Assumed from the type of room.`;
}

function renderBands(a) {
  const bands = a.rt60_bands_occupied_s;
  if (!bands) { $("d-bands").innerHTML = ""; return; }
  const W = 1000, H = 220, max = Math.max(...bands, a.target_s[1]) * 1.15;
  const bw = (W - 120) / bands.length;
  const y = (v) => H - 40 - (v / max) * (H - 70);
  const bars = bands.map((v, i) => `
      <rect x="${70 + i * bw + bw * 0.22}" y="${y(v)}" width="${bw * 0.56}" height="${H - 40 - y(v)}" rx="6" fill="#2997ff"/>
      <text x="${70 + i * bw + bw / 2}" y="${H - 16}" font-size="15" fill="#86868b" text-anchor="middle">${a.bands_hz[i] >= 1000 ? a.bands_hz[i] / 1000 + "k" : a.bands_hz[i]}</text>
      <text x="${70 + i * bw + bw / 2}" y="${y(v) - 10}" font-size="15" fill="#f5f5f7" text-anchor="middle">${v}s</text>`).join("");
  $("d-bands").innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Reverberation time in each octave band">
      <rect x="70" y="${y(a.target_s[1])}" width="${W - 120}" height="${y(a.target_s[0]) - y(a.target_s[1])}" fill="rgba(48,209,88,0.12)"/>
      <text x="62" y="${y(a.target_s[1]) + 14}" font-size="13" fill="#30d158" text-anchor="end">target</text>
      ${bars}
      <text x="${W - 50}" y="${H - 16}" font-size="13" fill="#86868b" text-anchor="end">Hz</text>
    </svg>`;
}

function renderRtChart(a) {
  const max = Math.max(3, a.rt60_empty_s * 1.1, a.target_s[1] * 1.3);
  const W = 1000, x = (s) => 20 + (s / max) * (W - 160);
  const row = (y, val, label, color) => `
    <rect x="20" y="${y}" width="${x(val) - 20}" height="22" rx="11" fill="${color}"/>
    <text x="${x(val) + 12}" y="${y + 16}" font-size="15" fill="#f5f5f7">${label} · ${val}s</text>`;
  $("d-rtchart").innerHTML = `
    <svg viewBox="0 0 ${W} 120" role="img" aria-label="Reverberation time against the target band">
      <rect x="${x(a.target_s[0])}" y="6" width="${x(a.target_s[1]) - x(a.target_s[0])}" height="84" rx="10" fill="rgba(48,209,88,0.14)"/>
      <text x="${x(a.target_s[0])}" y="112" font-size="13" fill="#30d158">Target ${a.target_s[0]} to ${a.target_s[1]}s</text>
      ${row(18, a.rt60_empty_s, "Empty", "#48484a")}
      ${row(56, a.rt60_occupied_s, "Full house", "#2997ff")}
    </svg>`;
}

// ------------------------------------------------------------------ listen

function applyRoomSound() {
  const a = currentAcoustics();
  if (!a) return;
  const full = state.crowd === "full";
  const rt = full ? a.rt60_occupied_s : a.rt60_empty_s;
  const bands = full ? a.rt60_bands_occupied_s : a.rt60_bands_empty_s;
  sound.setRoom(rt, a.volume_m3, bands && a.dims_m ? { bands, dims: a.dims_m } : null);
  hero?.setReverb(rt);
  lightScene?.setReverb(rt);
}

function wireListen() {
  document.querySelectorAll("[data-crowd]").forEach((b) => {
    b.onclick = () => {
      state.crowd = b.dataset.crowd;
      document.querySelectorAll("[data-crowd]").forEach((x) => x.classList.toggle("on", x === b));
      applyRoomSound();
      loadPlayRoom();
    };
  });
  $("play-choir").onclick = async () => {
    $("play-choir").classList.remove("pulse");
    applyRoomSound();
    const seconds = await sound.playChoir();
    applyRoomSound();
    hero?.pulse(seconds);
    lightScene?.pulse(seconds);
    drawScope();
  };
  $("clap").onclick = async () => { applyRoomSound(); await sound.clap(); applyRoomSound(); hero?.pulse(2); drawScope(); };
  $("mic").onclick = async () => {
    if (sound.mic) {
      sound.stopMic();
      $("mic").classList.remove("live");
      $("mic").textContent = "Sing into the room";
      return;
    }
    try {
      applyRoomSound();
      await sound.startMic();
      applyRoomSound();
      $("mic").classList.add("live");
      $("mic").textContent = "Stop singing";
      drawScope();
    } catch (e) { alert("Microphone not available: " + e.message); }
  };
}

function drawScope() {
  const canvas = $("scope");
  canvas.classList.add("on");
  if (!sound.analyser || canvas.dataset.running) return;
  canvas.dataset.running = "1";
  const ctx = canvas.getContext("2d");
  const data = new Uint8Array(sound.analyser.fftSize);
  const tick = () => {
    canvas.width = canvas.clientWidth * devicePixelRatio;
    canvas.height = 80 * devicePixelRatio;
    sound.analyser.getByteTimeDomainData(data);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = "#2997ff";
    ctx.lineWidth = 2 * devicePixelRatio;
    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const px = (i / data.length) * canvas.width;
      const py = (data[i] / 255) * canvas.height;
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.stroke();
    requestAnimationFrame(tick);
  };
  tick();
}

// ------------------------------------------------------------------ light

function wireSun() {
  $("sun-date").value = new Date().toISOString().slice(0, 10);
  $("sun-date").oninput = () => { renderSun(); loadDaylight(); };
  $("sun-time").oninput = renderSun;
}

// Daylight: windows found in the 360 photo, the sun for the date, shade from neighbours.
let daylight = null;
let daylightRoom = null;
function loadDaylight(room = daylightRoom) {
  const v = state.venue;
  if (!room || !v || !$("daylight")) return;
  daylightRoom = room;
  daylight ||= createDaylight($("daylight"), { viewer: () => roomViewer });
  daylight.load({
    venueId: v.venue_id, modelId: room.model_id, panoId: room.pano_id, area: room.area_sqft, height: room.height_ft,
    name: `${room.scan || ""} ${room.room || ""}`, date: $("sun-date").value, rotation: room.rotation ?? null,
    onNeighbours: (list) => lightScene?.setNeighbours?.(list, state.site[v.venue_id]),
  });
}

function currentSun(site, metro) {
  const dateStr = $("sun-date").value;
  const minute = Number($("sun-time").value);
  return sunPosition(localToUtc(dateStr, minute, utcOffsetFor(metro, dateStr)), site.lat, site.lon);
}

let roomViewer = null;

async function loadRooms(id) {
  $("room-picker").innerHTML = "";
  $("roomview-empty").hidden = false;
  $("roomview-empty").textContent = "Loading the rooms…";
  let rooms = [];
  try { rooms = (await (await fetch(`/api/venues/${id}/rooms`)).json()).rooms || []; } catch { /* none */ }
  if (state.venue?.venue_id !== id) return;
  if (!rooms.length) { $("roomview-empty").textContent = "No 360 photos for this building."; return; }
  rooms = rooms.slice(0, 14);
  const prefer = currentSpace()?.model_id;
  const first = Math.max(0, rooms.findIndex((r) => r.model_id === prefer));
  $("room-picker").innerHTML = rooms.map((r, i) =>
    `<button data-i="${i}">${esc(r.scan)}${r.room ? `, ${esc(r.room.toLowerCase())}` : ""}<small>${r.area_sqft ? r.area_sqft.toLocaleString() + " sq ft" : ""}</small></button>`).join("");
  const pick = async (i) => {
    document.querySelectorAll("#room-picker button").forEach((b) => b.classList.toggle("on", Number(b.dataset.i) === i));
    if (!roomViewer) roomViewer = createRoomViewer($("roomview"));
    try {
      await roomViewer.load(rooms[i].model_id, rooms[i].pano_id);
      $("roomview-empty").hidden = true;
      loadDaylight(rooms[i]);
      renderSun();
    } catch { $("roomview-empty").textContent = "That photo didn't load. Try another room."; }
  };
  document.querySelectorAll("#room-picker button").forEach((b) => (b.onclick = () => pick(Number(b.dataset.i))));
  pick(first);
}

async function loadLight(id) {
  loadRooms(id);
  const site = await getSite(id);
  if (!lightScene) {
    try { lightScene = createHero($("light3d")); } catch (err) { console.warn(err); }
  }
  await lightScene?.showVenue(site, site.aerial_image_url);
  applyRoomSound();
  renderSun();
  const a = site.aerial || {};
  $("d-site").innerHTML = dl([
    ["Parking (CoStar)", site.parking_spaces ? `${site.parking_spaces} spaces` : "Not recorded"],
    ["Vehicles seen from the air", a.vehicles_on_parcel ?? "None"],
    ["Footprint", a.footprint_sqft ? `${Math.round(a.footprint_sqft).toLocaleString()} sq ft` : "None"],
    ["Roof", [a.roof_shape, a.roof_material].filter(Boolean).join(", ") || "None"],
    ["Building height", `${Math.round(site.building_height_ft)} ft`],
    ["Aerial capture", a.collection ? `${(a.capture_date || "").slice(0, 10)}` : "Unknown"],
  ].map(([k, v]) => [k, esc(v)]));
}

function renderSun() {
  const v = state.venue;
  const site = v && state.site[v.venue_id];
  if (!site) return;
  const dateStr = $("sun-date").value;
  const minute = Number($("sun-time").value);
  const offset = utcOffsetFor(v.metro, dateStr);
  const sun = currentSun(site, v.metro);
  lightScene?.setSun(sun);
  const glassy = currentAcoustics()?.assumptions?.walls === "glass" ? 1 : 0.45;
  roomViewer?.setLight(sun, glassy);
  daylight?.update(minute, sun);
  const day = dayTimeline(dateStr, site.lat, site.lon, offset);
  $("sun-clock").textContent = fmtMinute(minute);
  $("sun-facts").innerHTML = dl([
    ["Sun", sun.altitude > 0 ? `${sun.altitude.toFixed(0)}° from the ${compass(sun.azimuth)}` : "Below the horizon"],
    ["Sunrise", fmtMinute(day.sunrise)],
    ["Golden hour", `${fmtMinute(day.goldenEveningStart)}`],
    ["Sunset", fmtMinute(day.sunset)],
  ].map(([k, val]) => [k, esc(val)]));
}

function compass(az) {
  return ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"][Math.round(az / 45) % 8];
}

function parseEventDate(text) {
  if (!text) return null;
  const now = new Date();
  const d = new Date(`${text} ${now.getFullYear()}`);
  if (isNaN(d)) return null;
  if (d < now) d.setFullYear(now.getFullYear() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ------------------------------------------------------------------ walk through (Matterport)

function wireTour() {
  $("tour-poster").onclick = startTour;
}

function currentModel() {
  return currentSpace()?.model_id || state.venue?.matterport_models?.[0];
}

function resetTour() {
  const model = currentModel();
  $("d-tour").hidden = true;
  $("d-tour").src = "about:blank";
  $("tour-poster").hidden = !model;
  const site = state.venue && state.site[state.venue.venue_id];
  $("tour-poster").style.backgroundImage = site ? `linear-gradient(rgba(0,0,0,.45), rgba(0,0,0,.55)), url(${site.aerial_image_url})` : "";
  $("d-tour-link").href = model ? `https://my.matterport.com/show/?m=${model}` : "#";
  $("d-tour-link").hidden = !model;
  const smart = sdkUsable(state.config?.matterport_sdk_key);
  $("walk-sub").textContent = smart
    ? "Walk the building. Every room you enter changes its sound on the Acoustics page."
    : "The full 3D scan, room by room.";
  $("walk-status").innerHTML = "";
}

async function startTour() {
  const model = currentModel();
  if (!model) return;
  const s = currentSpace();
  $("tour-poster").hidden = true;
  $("d-tour").hidden = false;
  $("walk-status").textContent = "Loading the tour…";
  const sdk = await loadTour($("d-tour"), model, state.config?.matterport_sdk_key, {
    targetAreaSqft: s?.area_sqft,
    label: s && { title: "Perform here", description: `${s.acoustics.rt60_occupied_s}s reverb with a full house · ${s.acoustics.capacity_seated} seats` },
    onRoomChange: onTourRoom,
  });
  $("walk-status").innerHTML = sdk
    ? "Walk into any room. <b>The sound follows you.</b>"
    : "";
}

async function onTourRoom(room) {
  const use = state.search?.use || "a_cappella_performance";
  const audience = state.search?.audience || 60;
  const type = currentSpace()?.acoustics.space_type || "generic";
  const q = new URLSearchParams({
    area_sqft: room.areaSqft.toFixed(0), height_ft: room.heightFt.toFixed(1),
    width_ft: room.widthFt.toFixed(1), depth_ft: room.depthFt.toFixed(1),
    space_type: type, use, audience,
  });
  const a = await (await fetch(`/api/acoustics?${q}`)).json();
  state.roomOverride = { ...a, label: room.label || "This room", areaSqft: room.areaSqft };
  renderAcoustics();
  $("walk-status").innerHTML = `You're in <b>${esc(room.label || "a new room")}</b>, ${Math.round(room.areaSqft).toLocaleString()} sq ft. <b>${a.rt60_occupied_s}s</b> of reverb with a full house.`;
}

// ------------------------------------------------------------------ stay

async function loadHousing(id, groupSize, nights) {
  let h = state.housing[id];
  if (!h) {
    h = await (await fetch(`/api/venues/${id}/housing?group_size=${groupSize}&nights=${nights}`)).json();
    state.housing[id] = h;
  }
  $("d-housing").innerHTML = (h.options || []).map((o) => `
    <li>
      <span class="name">${esc(o.name)}</span>
      <span class="price">${o.estimated_total ? money(o.estimated_total) : "Ask"}</span>
      <span class="meta">${o.same_building ? `<span class="same">Same building.</span> ` : ""}${o.kind === "hotel" ? "Hotel" : "Apartments"}, ${o.distance_miles} mi away. ${esc(o.why)}.</span>
    </li>`).join("") || `<li><span class="meta">No lodging found nearby.</span></li>`;
  $("d-housing-note").textContent = h.note || "";
}

// ------------------------------------------------------------------ fund

function budgetParams() {
  const brief = state.brief || {};
  return {
    group_size: brief.group_size || 14,
    nights: brief.nights || 2,
    audience: state.search?.audience || 60,
    space_area_sqft: currentSpace()?.area_sqft || null,
  };
}

async function loadBudget(id) {
  const q = new URLSearchParams(Object.entries(budgetParams()).filter(([, v]) => v != null));
  $("d-budget").innerHTML = `<p class="sub">Checking the tour fund…</p>`;
  const b = await (await fetch(`/api/venues/${id}/budget?${q}`)).json();
  if (b.error) { $("d-budget").innerHTML = `<p class="sub">${esc(b.error)}</p>`; return; }
  const c = b.costs, f = b.fund;
  let verdict = `<span class="note">Connect the Nessie sandbox to check the fund.</span>`;
  if (b.affordable === true) verdict = `<span class="ok">The tour fund covers it, with ${money(f.available_after_bills - c.total)} left over.</span>`;
  if (b.affordable === false) verdict = `<span class="over">That's ${money(b.shortfall)} more than the tour fund has.</span>`;
  $("d-budget").innerHTML = `
    <h2 class="display">Price breakdown for on the road</h2>
    <p class="total">${money(c.total)}</p>
    <p class="verdict">${verdict}</p>
    <dl class="specs">${dlRows([
      ["Tour fund available", f ? money2(f.available_after_bills) : "Not connected"],
      ["Venue, estimated", money(c.venue_fee_estimate)],
      ["Lodging", money(c.lodging_estimate)],
      ["Break-even ticket", money2(b.break_even_ticket)],
      ["Each member's share", money2(b.per_member_share)],
    ])}</dl>
    ${f ? `<button id="approve" class="cta">Pay the deposit and collect dues</button>` : ""}
    <p class="note">Nothing moves until the treasurer presses the button. Payments run in Capital One's Nessie sandbox. The venue fee is a rough guess for ${esc(c.venue_fee_basis)}.</p>
    <ul class="ledger" id="ledger"></ul>`;
  const btn = $("approve");
  if (btn) btn.onclick = () => approveBudget(id, btn);
}

async function approveBudget(id, btn) {
  btn.disabled = true;
  btn.textContent = "Posting to Nessie…";
  const res = await fetch(`/api/venues/${id}/budget/commit`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(budgetParams()),
  });
  const out = await res.json();
  if (!res.ok) { btn.textContent = "Failed: " + (out.detail || res.status); return; }
  btn.textContent = `Approved. Fund balance ${money2(out.fund.balance)}`;
  const items = out.actions.map((a) => {
    if (a.type === "bill") return `<li>Bill to ${esc(a.payee)}, ${money2(a.amount)}, pending.</li>`;
    if (a.type === "short") return `<li class="over">${esc(a.from)} can't cover their ${money2(a.owed)} share yet.</li>`;
    return `<li>${esc(a.from)} paid ${money2(a.amount)}${a.owed > 0 ? `, still owes ${money2(a.owed)}` : ""}.</li>`;
  }).join("");
  $("ledger").innerHTML = items;
}

// ------------------------------------------------------------------ reach

function renderEmail(id) {
  const e = state.outreach[id];
  if (!e) {
    $("d-email").innerHTML = `<p class="lede-dark">Run a brief and the scout drafts the email for its top pick.</p>`;
    return;
  }
  $("d-email").innerHTML = `
    <div class="email"><div class="subj">${esc(e.subject)}</div><div class="to">To ${esc(e.to?.name || "")}${e.to?.firm ? ", " + esc(e.to.firm) : ""}</div>${esc(e.body)}</div>
    <button class="cta" id="copy-email">Copy email</button>
    <p class="fine">${esc(e.note)}</p>`;
  $("copy-email").onclick = async () => {
    await navigator.clipboard.writeText(`Subject: ${e.subject}\n\n${e.body}`);
    $("copy-email").textContent = "Copied";
  };
}

// ------------------------------------------------------------------ helpers

function dlRows(rows) {
  return rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("");
}

function dl(rows) { return dlRows(rows); }

function roomLabel(name, kind) {
  const n = esc(name), k = esc(kind);
  const first = (kind || "").split(/[\s/]+/)[0].toLowerCase();
  return first && name.toLowerCase().includes(first) ? n : `${n}, ${k}`;
}

function cleanSpace(space, venue) {
  if (space && venue && space.toLowerCase().startsWith(venue.toLowerCase())) {
    return space.slice(venue.length).replace(/^[\s\-–:]+/, "") || space;
  }
  return space || "";
}

// ------------------------------------------------------------------ tiny markdown

function md(text) {
  // Some models end one paragraph and start the next with no newline ("curb.Lodging"): split there.
  const lines = esc(text).replace(/([a-z0-9][.!?])([A-Z][a-z])/g, "$1\n$2").split("\n");
  let html = "", inList = false;
  for (const raw of lines) {
    const line = raw.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
    if (/^\s*[-*] /.test(line)) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += `<li>${line.replace(/^\s*[-*] /, "")}</li>`;
    } else {
      if (inList) { html += "</ul>"; inList = false; }
      if (line.trim()) html += `<p>${line}</p>`;
    }
  }
  return html + (inList ? "</ul>" : "");
}

boot();
