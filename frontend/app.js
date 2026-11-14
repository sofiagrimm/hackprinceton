import { RoomSound } from "./audio.js";
import { sunPosition, dayTimeline, utcOffsetFor, localToUtc, fmtMinute, drawShadow, litFacades } from "./sun.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const sound = new RoomSound();
const money = (n) => "$" + Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
const money2 = (n) => "$" + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const state = {
  config: null,
  brief: null,
  search: null,
  analyses: {},
  housing: {},
  outreach: {},
  site: {},
  venue: null,
  spaceIndex: 0,
  crowd: "full",
};

const EXAMPLES = [
  ["LA a cappella stop", "Our 14-singer a cappella group is touring LA on March 14. We want to perform for about 80 guests and stay 2 nights, ideally in the same building."],
  ["Houston rehearsal", "We need a rehearsal space in Houston for 12 singers for a 3 day retreat, about 20 people in the room, plus somewhere to sleep."],
  ["Choir concert", "A 30-voice choir wants a resonant space in Los Angeles for a concert for 150 guests on April 2, staying 1 night."],
  ["Film shoot", "Indie film crew of 25 needs a quiet location in Los Angeles with good dialogue sound for a 3 week shoot, 40 people on set."],
];

// ------------------------------------------------------------------ boot

async function boot() {
  const chips = $("examples");
  EXAMPLES.forEach(([label, text]) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = () => { $("brief").value = text; };
    chips.appendChild(b);
  });
  $("go").onclick = runScout;
  $("d-close").onclick = () => { $("detail").hidden = true; sound.stopChoir(); };
  try {
    state.config = await (await fetch("/api/config")).json();
    $("status").textContent = `${state.config.venues.toLocaleString()} scanned buildings · ${state.config.housing.toLocaleString()} apartment communities · agent: ${AGENT_LABEL[state.config.agent] || state.config.agent}`;
  } catch {
    $("status").textContent = "API not reachable";
  }
  wireListen();
  wireSun();
}

// ------------------------------------------------------------------ agent run

async function runScout() {
  const brief = $("brief").value.trim();
  if (!brief) return;
  $("go").disabled = true;
  $("timeline").innerHTML = "";
  $("report").innerHTML = "";
  $("cards").innerHTML = `<p class="muted">Scouting…</p>`;
  $("detail").hidden = true;
  Object.assign(state, { search: null, analyses: {}, housing: {}, outreach: {}, site: {} });

  const res = await fetch("/api/scout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ brief }),
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
  $("go").disabled = false;
}

const AGENT_LABEL = { claude: "Claude", deepagents: "Deep Agents", planner: "built-in planner" };

const TOOL_LABEL = {
  search_venues: "Searching scanned spaces",
  analyze_venue: "Measuring rooms",
  site_check: "Checking the site from the air",
  find_housing: "Finding somewhere to stay",
  draft_outreach: "Drafting outreach",
};

function step(cls, html) {
  const li = document.createElement("li");
  li.className = cls;
  li.innerHTML = html;
  $("timeline").appendChild(li);
  li.scrollIntoView({ block: "nearest" });
  return li;
}

function handleEvent(ev) {
  switch (ev.type) {
    case "agent":
      $("agent-name").textContent = AGENT_LABEL[ev.name] || ev.name;
      break;
    case "delegate":
      step("plan", `<span class="k">Delegating to ${esc(ev.agent)}</span> <span class="muted">${esc(ev.text)}</span>`);
      break;
    case "file":
      step("plan", `<span class="k">Writing</span> <span class="muted">${esc(ev.path)}</span>`);
      break;
    case "plan":
      step("plan", `<span class="k">Plan</span> ${esc(ev.text)}`);
      break;
    case "tool":
      step("tool", `<span class="k">${esc(TOOL_LABEL[ev.name] || ev.name)}</span> <span class="muted">${esc(summarizeInput(ev.input))}</span>`);
      break;
    case "tool_result":
      onToolResult(ev.name, ev.result);
      break;
    case "message":
      $("report").innerHTML += md(ev.text);
      break;
    case "done":
      state.brief = ev.brief;
      break;
    case "error":
      step("err", `<span class="k">Error</span> ${esc(ev.text)}`);
      break;
  }
}

function summarizeInput(input) {
  const parts = [];
  if (input.metro) parts.push(input.metro);
  if (input.audience) parts.push(`${input.audience} guests`);
  if (input.use) parts.push(input.use.replaceAll("_", " "));
  if (input.stay_and_perform) parts.push("stay + perform");
  if (input.group_size) parts.push(`${input.group_size} people`);
  if (input.nights) parts.push(`${input.nights} nights`);
  if (input.venue_id && state.search) {
    const v = state.search.results.find((r) => r.venue_id === input.venue_id);
    if (v) parts.unshift(v.name);
  }
  return parts.join(" · ");
}

function onToolResult(name, result) {
  const last = $("timeline").lastElementChild;
  if (result.error) {
    step("err", esc(result.error));
    return;
  }
  if (name === "search_venues") {
    state.search = result;
    if (last) last.innerHTML += `<br><span class="muted">${result.results.length} matches from ${result.venues_scanned.toLocaleString()} scanned buildings · target ${result.target_rt60_s.join("-")}s</span>`;
    renderCards();
  } else if (name === "analyze_venue") {
    state.analyses[result.venue_id] = result;
    const s = result.spaces?.[0];
    if (last && s) last.innerHTML += `<br><span class="muted">${esc(s.space_name)}: ${s.acoustics.rt60_occupied_s}s with audience</span>`;
  } else if (name === "site_check") {
    state.site[result.venue_id] = result;
    if (last) last.innerHTML += `<br><span class="muted">${esc(result.notes.slice(0, 2).join(" "))}</span>`;
  } else if (name === "find_housing") {
    const vid = state.search?.results.find((r) => r.name === result.venue)?.venue_id;
    if (vid) state.housing[vid] = result;
    const o = result.options?.[0];
    if (last && o) last.innerHTML += `<br><span class="muted">${esc(o.name)} · ${o.distance_miles} mi · ~$${(o.estimated_total ?? 0).toLocaleString()}</span>`;
  } else if (name === "draft_outreach") {
    const vid = state.search?.results.find((r) => r.name === result.venue)?.venue_id;
    if (vid) state.outreach[vid] = result;
    if (last) last.innerHTML += `<br><span class="muted">To ${esc(result.to?.name || "venue")}${result.to?.firm ? ", " + esc(result.to.firm) : ""}</span>`;
    if (vid) openVenue(vid);
  }
}

// ------------------------------------------------------------------ cards

function renderCards() {
  const r = state.search;
  $("results-title").textContent = `Ranked spaces · ${r.metro} · ${r.use_label}`;
  if (!r.results.length) {
    $("cards").innerHTML = `<p class="muted">Nothing fits yet. Try a smaller audience or another use.</p>`;
    return;
  }
  $("cards").innerHTML = r.results.map((v, i) => {
    const a = v.best_space.acoustics;
    return `
      <article class="vcard" data-id="${v.venue_id}">
        <span class="rank">#${i + 1}</span>
        <img src="${esc(v.photo || "")}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
        <div class="body">
          <h3>${esc(v.name)}</h3>
          <div class="space">${esc(v.best_space.space_name)} · ${v.best_space.area_sqft.toLocaleString()} sq ft</div>
          <div class="row">
            <span><span class="score" style="color:${scoreColor(a.score)}">${a.rt60_occupied_s}s</span> <span class="muted">RT60 full</span></span>
            <span class="badge">${esc(v.property_type)}</span>
          </div>
          <div class="row">
            <span class="muted">${a.capacity_seated} seated · match ${v.match_score}</span>
            ${v.is_hotel || v.property_type === "Multifamily" ? `<span class="badge stay">stay on site</span>` : ""}
          </div>
        </div>
      </article>`;
  }).join("");
  document.querySelectorAll(".vcard").forEach((el) => (el.onclick = () => openVenue(Number(el.dataset.id))));
}

function scoreColor(score) {
  return score >= 85 ? "var(--good)" : score >= 50 ? "var(--warn)" : "var(--bad)";
}

// ------------------------------------------------------------------ detail

async function openVenue(id) {
  const brief = state.brief || {};
  const use = state.search?.use || "a_cappella_performance";
  const audience = state.search?.audience || 60;
  let v = state.analyses[id];
  if (!v) {
    v = await (await fetch(`/api/venues/${id}?use=${use}&audience=${audience}`)).json();
    state.analyses[id] = v;
  }
  state.venue = v;
  state.spaceIndex = 0;
  $("detail").hidden = false;
  $("d-name").textContent = v.name;
  $("d-address").textContent = v.address;
  const eventDate = parseEventDate(brief.event_date);
  if (eventDate) $("sun-date").value = eventDate;
  $("d-meta").textContent = `${v.metro} · ${v.property_type}${v.parking_spaces ? ` · ${v.parking_spaces} parking spaces` : ""}`;

  $("d-spaces").innerHTML = (v.spaces || []).map((s, i) =>
    `<button data-i="${i}" class="${i === 0 ? "on" : ""}">${esc(s.space_name)}</button>`).join("");
  document.querySelectorAll("#d-spaces button").forEach((b) => (b.onclick = () => selectSpace(Number(b.dataset.i))));
  selectSpace(0);

  loadSite(id);
  loadHousing(id, brief.group_size || 14, brief.nights || 2).then(() => loadBudget(id));
  renderEmail(id);
  $("detail").scrollIntoView({ behavior: "smooth", block: "start" });
}

function selectSpace(i) {
  const v = state.venue;
  const s = v.spaces?.[i];
  state.spaceIndex = i;
  document.querySelectorAll("#d-spaces button").forEach((b) => b.classList.toggle("on", Number(b.dataset.i) === i));
  // The hackathon scans are public/unlisted, so the standard Showcase embed needs no SDK key and works on
  // any domain. (The SDK key is limited to localhost and is only needed for scripting the viewer.)
  const model = s?.model_id || v.matterport_models?.[0];
  $("d-tour").src = model ? `https://my.matterport.com/show/?m=${model}&play=1&qs=1&brand=0` : "about:blank";
  $("d-tour-link").href = model ? `https://my.matterport.com/show/?m=${model}` : "#";
  $("d-tour-link").hidden = !model;
  if (!s) {
    $("d-acoustics").innerHTML = `<p class="muted">No measurable room in this scan.</p>`;
    return;
  }
  const a = s.acoustics;
  $("d-acoustics").innerHTML = `
    <p class="verdict"><b style="color:${scoreColor(a.score)}">${a.rt60_occupied_s}s</b> with ${a.audience} guests · ${a.rt60_empty_s}s empty</p>
    <p>${esc(a.verdict)}</p>
    <div class="facts">
      <div class="f"><span>Space</span><span>${esc(a.space_label)} · ${s.area_sqft.toLocaleString()} sq ft${s.height_ft ? ` · ${s.height_ft} ft ceiling` : ""}</span></div>
      <div class="f"><span>Capacity</span><span>${a.capacity_seated} seated · ${a.capacity_standing} standing</span></div>
      <div class="f"><span>Assumed finishes</span><span>${esc(a.assumptions.floor)} floor · ${esc(a.assumptions.walls)} walls · ${esc(a.assumptions.ceiling)} ceiling</span></div>
      ${a.notes.map((n) => `<div class="f"><span>Note</span><span>${esc(n)}</span></div>`).join("")}
    </div>`;
  renderRtChart(a);
  applyRoomSound();
}

function renderRtChart(a) {
  const max = Math.max(3, a.rt60_empty_s * 1.1, a.target_s[1] * 1.3);
  const x = (s) => 10 + (s / max) * 280;
  const row = (y, val, label, color) => `
    <rect x="10" y="${y}" width="${x(val) - 10}" height="16" rx="4" fill="${color}"/>
    <text x="${x(val) + 6}" y="${y + 12}" font-size="11" fill="currentColor">${label} ${val}s</text>`;
  $("d-rtchart").innerHTML = `
    <svg viewBox="0 0 360 92" role="img" aria-label="Reverberation time compared with the target">
      <rect x="${x(a.target_s[0])}" y="4" width="${x(a.target_s[1]) - x(a.target_s[0])}" height="64" fill="var(--band)" rx="4"/>
      <text x="${x(a.target_s[0])}" y="84" font-size="10" fill="var(--good)">target ${a.target_s[0]}-${a.target_s[1]}s</text>
      ${row(12, a.rt60_empty_s, "empty", "var(--muted)")}
      ${row(40, a.rt60_occupied_s, "full", scoreColor(a.score))}
    </svg>`;
}

// ------------------------------------------------------------------ listen

function currentAcoustics() {
  return state.venue?.spaces?.[state.spaceIndex]?.acoustics;
}

function applyRoomSound() {
  const a = currentAcoustics();
  if (!a) return;
  sound.setRoom(state.crowd === "full" ? a.rt60_occupied_s : a.rt60_empty_s, a.volume_m3);
}

function wireListen() {
  document.querySelectorAll("[data-crowd]").forEach((b) => {
    b.onclick = () => {
      state.crowd = b.dataset.crowd;
      document.querySelectorAll("[data-crowd]").forEach((x) => x.classList.toggle("on", x === b));
      applyRoomSound();
    };
  });
  $("play-choir").onclick = async () => {
    applyRoomSound();
    await sound.playChoir();
    applyRoomSound();
    drawScope();
  };
  $("clap").onclick = async () => { applyRoomSound(); await sound.clap(); applyRoomSound(); drawScope(); };
  $("mic").onclick = async () => {
    if (sound.mic) {
      sound.stopMic();
      $("mic").classList.remove("live");
      $("mic").textContent = "🎤 Sing into the room";
      return;
    }
    try {
      applyRoomSound();
      await sound.startMic();
      applyRoomSound();
      $("mic").classList.add("live");
      $("mic").textContent = "■ Stop mic";
      drawScope();
    } catch (e) {
      alert("Microphone not available: " + e.message);
    }
  };
}

function drawScope() {
  const canvas = $("scope");
  if (!sound.analyser || canvas.dataset.running) return;
  canvas.dataset.running = "1";
  const ctx = canvas.getContext("2d");
  const data = new Uint8Array(sound.analyser.fftSize);
  const color = getComputedStyle(document.documentElement).getPropertyValue("--accent");
  const tick = () => {
    canvas.width = canvas.clientWidth * devicePixelRatio;
    canvas.height = 60 * devicePixelRatio;
    sound.analyser.getByteTimeDomainData(data);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const x = (i / data.length) * canvas.width;
      const y = (data[i] / 255) * canvas.height;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
    requestAnimationFrame(tick);
  };
  tick();
}

// ------------------------------------------------------------------ site + sun

async function loadSite(id) {
  $("d-site").innerHTML = `<p class="muted">Loading aerial…</p>`;
  let site = state.site[id];
  if (!site) {
    site = await (await fetch(`/api/venues/${id}/site`)).json();
    state.site[id] = site;
  }
  const img = $("d-aerial");
  img.onload = () => renderSun();
  img.onerror = () => { img.alt = "No aerial imagery here"; };
  img.src = site.aerial_image_url;
  const a = site.aerial || {};
  $("d-site").innerHTML = [
    ["Parking (CoStar)", site.parking_spaces ? `${site.parking_spaces} spaces` : "not recorded"],
    ["Vehicles seen from the air", a.vehicles_on_parcel ?? "-"],
    ["Footprint", a.footprint_sqft ? `${Math.round(a.footprint_sqft).toLocaleString()} sq ft` : "-"],
    ["Roof", [a.roof_shape, a.roof_material].filter(Boolean).join(", ") || "-"],
    ["Building height used for shadows", `${Math.round(site.building_height_ft)} ft`],
    ["Imagery", a.collection ? `${a.collection} (${(a.capture_date || "").slice(0, 10)})` : "-"],
  ].map(([k, v]) => `<div class="f"><span>${k}</span><span>${esc(v)}</span></div>`).join("");
}

function wireSun() {
  const d = new Date();
  $("sun-date").value = d.toISOString().slice(0, 10);
  $("sun-date").oninput = renderSun;
  $("sun-time").oninput = renderSun;
}

function renderSun() {
  const v = state.venue;
  const site = v && state.site[v.venue_id];
  if (!site) return;
  const dateStr = $("sun-date").value;
  const minute = Number($("sun-time").value);
  const offset = utcOffsetFor(v.metro, dateStr);
  const sun = sunPosition(localToUtc(dateStr, minute, offset), site.lat, site.lon);
  const canvas = $("d-shadow");
  const img = $("d-aerial");
  canvas.width = img.naturalWidth || 800;
  canvas.height = img.naturalHeight || 600;
  const shadow = drawShadow(canvas, site.image_bounds, site.footprint, site.building_height_ft, sun);
  const day = dayTimeline(dateStr, site.lat, site.lon, offset);
  const faces = litFacades(site.footprint, sun);
  $("sun-clock").textContent = fmtMinute(minute);
  const lit = faces.filter((f) => f.lit).map((f) => f.label);
  $("sun-facts").innerHTML = [
    ["Sun", sun.altitude > 0 ? `${sun.altitude.toFixed(0)}° high, from the ${compass(sun.azimuth)}` : "below the horizon"],
    ["Sunrise · sunset", `${fmtMinute(day.sunrise)} · ${fmtMinute(day.sunset)}`],
    ["Golden hour", `${fmtMinute(day.goldenEveningStart)} - ${fmtMinute(day.sunset)}`],
    ["Shadow length", shadow.length ? `${Math.round(shadow.length * 3.281)} ft` : "-"],
    ["Walls in direct sun", lit.length ? lit.join(", ") : "none"],
  ].map(([k, val]) => `<div class="f"><span>${k}</span><span>${esc(val)}</span></div>`).join("");
}

function parseEventDate(text) {
  if (!text) return null;
  const now = new Date();
  const d = new Date(`${text} ${now.getFullYear()}`);
  if (isNaN(d)) return null;
  if (d < now) d.setFullYear(now.getFullYear() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function compass(az) {
  return ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"][Math.round(az / 45) % 8];
}

// ------------------------------------------------------------------ housing + email

async function loadHousing(id, groupSize, nights) {
  let h = state.housing[id];
  if (!h) {
    h = await (await fetch(`/api/venues/${id}/housing?group_size=${groupSize}&nights=${nights}`)).json();
    state.housing[id] = h;
  }
  $("d-housing").innerHTML = `<div class="stay">${(h.options || []).map((o) => `
    <div class="opt">
      <b>${esc(o.name)}</b> ${o.same_building ? `<span class="badge stay">same building</span>` : ""}
      <div class="muted">${o.kind === "hotel" ? "Hotel" : "Apartments"} · ${o.distance_miles} mi · ${esc(o.address)}</div>
      <div>${o.estimated_total ? `~$${o.estimated_total.toLocaleString()} total · ` : ""}${esc(o.why)}</div>
    </div>`).join("") || `<p class="muted">No lodging found nearby.</p>`}</div>
    <p class="hint">${esc(h.note || "")}</p>`;
}

function budgetParams() {
  const brief = state.brief || {};
  const space = state.venue?.spaces?.[state.spaceIndex];
  return {
    group_size: brief.group_size || 14,
    nights: brief.nights || 2,
    audience: state.search?.audience || 60,
    space_area_sqft: space?.area_sqft || null,
  };
}

async function loadBudget(id) {
  const p = budgetParams();
  const q = new URLSearchParams(Object.entries(p).filter(([, v]) => v != null));
  $("d-budget").innerHTML = `<p class="muted">Checking the tour fund…</p>`;
  const b = await (await fetch(`/api/venues/${id}/budget?${q}`)).json();
  if (b.error) { $("d-budget").innerHTML = `<p class="muted">${esc(b.error)}</p>`; return; }
  const c = b.costs, f = b.fund;
  let status = `<span class="muted">Bank not connected</span>`;
  if (b.affordable === true) status = `<span class="ok">Fits the fund</span>`;
  if (b.affordable === false) status = `<span class="over">${money(b.shortfall)} short</span>`;
  const fundText = f ? ` · fund ${money2(f.available_after_bills)} available` : "";
  $("d-budget").innerHTML = `
    <div class="budget">
      <div class="big">${status} · stop costs ~${money(c.total)}${fundText}</div>
      <div class="f"><span>Venue fee (estimate)</span><span>${money(c.venue_fee_estimate)} · ${esc(c.venue_fee_basis)}</span></div>
      <div class="f"><span>Lodging</span><span>${money(c.lodging_estimate)}</span></div>
      <div class="f"><span>Break-even ticket</span><span>${money2(b.break_even_ticket)} (suggest ${money(b.suggested_ticket)})</span></div>
      <div class="f"><span>Each member's share</span><span>${money2(b.per_member_share)}</span></div>
      ${f ? `<button id="approve" class="primary">Approve: hold ${money(c.venue_deposit_50pct)} deposit + lodging, collect dues</button>` : ""}
      <div id="ledger"></div>
    </div>`;
  const btn = $("approve");
  if (btn) btn.onclick = () => approveBudget(id, btn);
}

async function approveBudget(id, btn) {
  btn.disabled = true;
  btn.textContent = "Posting to Nessie…";
  const res = await fetch(`/api/venues/${id}/budget/commit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(budgetParams()),
  });
  const out = await res.json();
  if (!res.ok) { btn.textContent = "Failed: " + (out.detail || res.status); return; }
  btn.textContent = `Approved · fund ${money2(out.fund.balance)}, ${money2(out.fund.pending_bills)} in pending bills`;
  const items = out.actions.map((a) => a.type === "bill"
    ? `<li>Bill to ${esc(a.payee)}: ${money2(a.amount)} (pending)</li>`
    : `<li>${esc(a.from)} paid their ${money2(a.amount)} share</li>`).join("");
  $("ledger").innerHTML = `<ul class="ledger">${items}</ul><p class="hint">${esc(out.note)}</p>`;
}

async function renderEmail(id) {
  const e = state.outreach[id];
  if (!e) {
    $("d-email").innerHTML = `<p class="muted">The agent drafts outreach for its top pick.</p>`;
    return;
  }
  $("d-email").innerHTML = `
    <div class="email"><div class="subj">${esc(e.subject)}</div><div class="muted">To: ${esc(e.to?.name || "")} ${e.to?.firm ? "· " + esc(e.to.firm) : ""} ${e.to?.email ? "· " + esc(e.to.email) : ""}</div>
${esc(e.body)}</div>
    <p class="hint">${esc(e.note)}</p>`;
}

// ------------------------------------------------------------------ tiny markdown

function md(text) {
  const lines = esc(text).split("\n");
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
