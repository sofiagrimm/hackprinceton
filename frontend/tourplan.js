// Whole-tour planner: one brief, several shows, one plan the group can share and vote on.
// Talks to /api/tour (NDJSON stream), /api/tour/{id}, /api/tour/{id}/vote and /api/tour/{id}/dues.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => "$" + Math.round(Number(n || 0)).toLocaleString();
const EXAMPLE = "Our 14 singers want to do 3 shows: LA March 14, LA March 16, Houston March 20. About 80 guests each, budget $6,000.";
const NAME_KEY = "tourplan.voter";

const STEP = {
  search_venues: (i) => `Ranking rooms in ${i.metro}`,
  analyze_venue: () => "Measuring the best room",
  find_housing: () => "Looking for beds nearby",
};

let plan = null;

function voterName() {
  try { return localStorage.getItem(NAME_KEY) || ""; } catch { return ""; }
}
function rememberName(name) {
  try { localStorage.setItem(NAME_KEY, name); } catch { /* private window */ }
}

function niceDate(iso) {
  if (!iso) return "";
  const d = new Date(iso + "T12:00:00");
  return d.toLocaleDateString(undefined, { month: "long", day: "numeric" });
}
function weekday(iso) {
  if (!iso) return "";
  return new Date(iso + "T12:00:00").toLocaleDateString(undefined, { weekday: "long" });
}

// ------------------------------------------------------------------ run

async function runTour(brief) {
  const btn = $("tp-go");
  btn.disabled = true;
  btn.textContent = "Planning";
  $("tp-status").textContent = "Reading the brief.";
  $("tp-result").hidden = true;
  $("tp-stops").innerHTML = "";
  try {
    const res = await fetch("/api/tour", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ brief }),
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) onEvent(JSON.parse(line));
      }
    }
  } catch (err) {
    $("tp-status").textContent = "Something went wrong. Try again in a moment.";
    console.error(err);
  } finally {
    btn.disabled = false;
    btn.textContent = "Plan the tour";
  }
}

function onEvent(ev) {
  if (ev.type === "plan") $("tp-status").textContent = ev.text;
  else if (ev.type === "tool") $("tp-status").textContent = (STEP[ev.name] || (() => "Working"))(ev.input) + ".";
  else if (ev.type === "stop") $("tp-status").textContent = `${ev.stop.city} on ${niceDate(ev.stop.date)}: ${ev.stop.venue ? ev.stop.venue.name : "nothing fits"}.`;
  else if (ev.type === "message") $("tp-summary").textContent = ev.text;
  else if (ev.type === "error") $("tp-status").textContent = "Something went wrong: " + ev.text;
  else if (ev.type === "tour") {
    $("tp-status").textContent = "";
    show(ev.plan, true);
  }
}

// ------------------------------------------------------------------ render

function show(p, fresh = false) {
  plan = p;
  const url = new URL(p.share_url, location.origin);
  if (fresh) history.replaceState(null, "", "?tour=" + p.id + "#tour-plan");
  $("tp-result").hidden = false;
  if (!fresh && !$("tp-summary").textContent) $("tp-summary").textContent = summaryLine(p);
  renderStops(p);
  renderTotals(p);
  const link = $("tp-share");
  link.href = url.pathname + url.search;
  link.textContent = "Share with the group";
  $("tp-share-url").textContent = url.href;
  $("tp-dues-out").innerHTML = p.dues
    ? `<li>Dues collected ${money(p.dues.collected)}. ${money(p.dues.billed)} held as bills on the tour fund.</li>` : "";
}

function summaryLine(p) {
  const t = p.totals;
  return `The whole tour comes to about ${money(t.total)}, or ${money(t.per_member)} each for ${p.group_size} singers.`;
}

function renderStops(p) {
  const out = [];
  p.stops.forEach((s, i) => {
    out.push(stopRow(s, i, p.tallies?.[i]));
    const leg = p.legs.find((l) => l.after_stop === i);
    if (leg) out.push(legRow(leg));
  });
  $("tp-stops").innerHTML = out.join("");
  $("tp-stops").querySelectorAll("button[data-vote]").forEach((b) => {
    b.onclick = () => vote(Number(b.dataset.stop), b.dataset.vote);
  });
}

function stopRow(s, i, tally = { venue: [], backup: [] }) {
  const me = voterName().toLowerCase();
  const mine = tally.venue.some((n) => n.toLowerCase() === me) ? "venue"
    : tally.backup.some((n) => n.toLowerCase() === me) ? "backup" : "";
  const when = s.date ? `<div class="tp-date">${esc(niceDate(s.date))}</div><div class="tp-day">${esc(weekday(s.date))}</div>` : "";
  if (!s.venue) {
    return `<li class="tp-stop"><div class="tp-when">${when}</div><div class="tp-what">
      <div class="tp-city">${esc(s.city)}</div><p class="tp-line">No scanned room here fits ${s.audience} people.</p></div></li>`;
  }
  const v = s.venue;
  const room = v.space ? `the ${esc(v.space.toLowerCase())}` : "the main room";
  const reverb = v.rt60_occupied_s ? `${v.rt60_occupied_s} seconds of reverb with a full house.` : "";
  const stay = s.lodging
    ? (s.lodging.same_building
      ? `Sleep in the same building, ${s.nights} night${s.nights > 1 ? "s" : ""}, about ${money(s.lodging.estimated_total)}.`
      : `Sleep at ${esc(s.lodging.name)}, ${s.lodging.distance_miles} miles away, ${s.nights} night${s.nights > 1 ? "s" : ""}, about ${money(s.lodging.estimated_total)}.`)
    : "No lodging found nearby yet.";
  const count = (n) => (n ? ` <span class="tp-count">${n}</span>` : "");
  const backup = s.backup
    ? `<button type="button" class="tp-vote${mine === "backup" ? " on" : ""}" data-stop="${i}" data-vote="${mine === "backup" ? "none" : "backup"}">${mine === "backup" ? "You picked" : "Vote for"} ${esc(s.backup.name)}${count(tally.backup.length)}</button>`
    : "";
  const voters = [...tally.venue, ...tally.backup];
  return `<li class="tp-stop">
    <div class="tp-when">${when}</div>
    <div class="tp-what">
      <div class="tp-city">${esc(s.city)}</div>
      <div class="tp-venue">${esc(v.name)}</div>
      <p class="tp-line">Sing in ${room}. ${reverb} Room for about ${v.capacity_seated ?? s.audience} seated, you expect ${s.audience}.</p>
      <p class="tp-line">${stay}</p>
      <div class="tp-votes">
        <button type="button" class="tp-vote${mine === "venue" ? " on" : ""}" data-stop="${i}" data-vote="${mine === "venue" ? "none" : "venue"}">${mine === "venue" ? "You picked this" : "Vote for this room"}${count(tally.venue.length)}</button>
        ${backup}
      </div>
      ${voters.length ? `<p class="tp-voters">${esc(tallyLine(tally, s))}</p>` : ""}
    </div>
    <div class="tp-cost">${money(s.costs.total)}<small>${money(s.costs.venue_fee)} room, ${money(s.costs.lodging)} beds</small></div>
  </li>`;
}

function tallyLine(tally, s) {
  const parts = [];
  if (tally.venue.length) parts.push(`${tally.venue.join(", ")} for ${s.venue.name}`);
  if (tally.backup.length && s.backup) parts.push(`${tally.backup.join(", ")} for ${s.backup.name}`);
  return parts.join(". ") + ".";
}

function legRow(l) {
  const how = l.fly ? `Fly ${esc(l.airports)}` : (l.road_miles < 30 ? "Short drive" : "Drive");
  return `<li class="tp-leg"><div class="tp-when"></div><div class="tp-what"><span class="tp-how">${how}.</span> ${esc(l.why)}</div><div class="tp-cost tp-leg-cost">${money(l.cost)}</div></li>`;
}

function renderTotals(p) {
  const t = p.totals;
  let verdict = "";
  if (t.budget) {
    verdict = t.under_budget_by >= 0
      ? `<p class="tp-verdict ok">${money(t.under_budget_by)} under your ${money(t.budget)} budget.</p>`
      : `<p class="tp-verdict over">${money(-t.under_budget_by)} over your ${money(t.budget)} budget.</p>`;
  }
  $("tp-totals").innerHTML = `
    <div class="tp-total">${money(t.total)}</div>
    ${verdict}
    <dl class="specs tp-specs">
      <div><dt>Rooms</dt><dd>${money(t.venue_fees)}</dd></div>
      <div><dt>Beds, ${t.nights} nights</dt><dd>${money(t.lodging)}</dd></div>
      <div><dt>Getting there</dt><dd>${money(t.travel)}</dd></div>
      <div><dt>Each singer pays</dt><dd>${money(t.per_member)}</dd></div>
      <div><dt>Ticket to break even</dt><dd>${money(Math.ceil(t.break_even_ticket))}</dd></div>
    </dl>
    <p class="note">That ticket price assumes ${t.tickets_sold} seats sold across ${p.stops.length} shows. Room fees are estimates until each venue quotes, and beds use CoStar average rates.</p>`;
}

// ------------------------------------------------------------------ votes and dues

async function vote(stop, choice) {
  let name = voterName();
  if (!name) {
    $("tp-name-row").hidden = false;
    $("tp-name").focus();
    $("tp-name").dataset.pending = JSON.stringify({ stop, choice });
    return;
  }
  const res = await fetch(`/api/tour/${plan.id}/vote`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stop, name, choice }),
  });
  if (res.ok) show(await res.json());
}

async function collectDues() {
  const btn = $("tp-dues");
  btn.disabled = true;
  btn.textContent = "Collecting";
  try {
    const res = await fetch(`/api/tour/${plan.id}/dues`, { method: "POST" });
    const out = await res.json();
    if (!res.ok) throw new Error(out.detail || res.statusText);
    const rows = out.actions.map((a) => a.type === "bill"
      ? `<li>Held ${money(a.amount)} for ${esc(a.payee)}.</li>`
      : a.type === "transfer"
        ? `<li>${esc(a.from)} paid ${money(a.amount)}${a.owed > 0.5 ? `, still owes ${money(a.owed)}` : ""}.</li>`
        : `<li>${esc(a.from)} couldn't pay yet and owes ${money(a.owed)}.</li>`);
    const left = out.fund.available_after_bills;
    rows.push(left < 0
      ? `<li>The tour fund now has ${money(out.fund.balance)}, and its bills are ${money(-left)} more than that.</li>`
      : `<li>The tour fund now has ${money(out.fund.balance)}, ${money(left)} after bills.</li>`);
    $("tp-dues-out").innerHTML = rows.join("");
    btn.textContent = "Dues collected";
  } catch (err) {
    $("tp-dues-out").innerHTML = `<li>The bank isn't connected right now. ${esc(err.message)}</li>`;
    btn.disabled = false;
    btn.textContent = "Collect dues for the tour";
  }
}

// ------------------------------------------------------------------ boot

function boot() {
  const form = $("tp-form");
  if (!form) return;
  $("tp-example").onclick = () => { $("tp-brief").value = EXAMPLE; $("tp-brief").focus(); };
  form.onsubmit = (e) => {
    e.preventDefault();
    const brief = $("tp-brief").value.trim() || EXAMPLE;
    $("tp-brief").value = brief;
    $("tp-summary").textContent = "";
    runTour(brief);
  };
  $("tp-brief").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  });
  $("tp-name-form").onsubmit = (e) => {
    e.preventDefault();
    const name = $("tp-name").value.trim();
    if (!name) return;
    rememberName(name);
    $("tp-name-row").hidden = true;
    const pending = $("tp-name").dataset.pending;
    if (pending) { const { stop, choice } = JSON.parse(pending); vote(stop, choice); }
  };
  $("tp-share").onclick = async (e) => {
    try {
      await navigator.clipboard.writeText($("tp-share-url").textContent);
      e.preventDefault();
      $("tp-share").textContent = "Link copied";
      setTimeout(() => { $("tp-share").textContent = "Share with the group"; }, 1800);
    } catch { /* fall through to opening the link */ }
  };
  $("tp-dues").onclick = collectDues;

  const id = new URLSearchParams(location.search).get("tour");
  if (id) {
    fetch(`/api/tour/${encodeURIComponent(id)}`).then((r) => (r.ok ? r.json() : null)).then((p) => {
      if (!p) { $("tp-status").textContent = "That tour link has expired."; return; }
      $("tp-brief").value = p.brief;
      show(p);
      $("tour-plan").scrollIntoView();
    });
  }
}

boot();
