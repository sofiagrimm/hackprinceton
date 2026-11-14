// The booking pipeline: every venue the group has written to, grouped by where it stands,
// a drafted follow-up for each, and an A/B view that plays the same chord in two rooms.

import { RoomSound } from "./audio.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => "$" + Math.round(Number(n || 0)).toLocaleString();

const LABEL = { drafted: "Drafted", sent: "Sent", replied: "Replied", holding: "On hold", booked: "Booked", declined: "Declined" };
const STATUSES = Object.keys(LABEL);

const sound = new RoomSound();
const state = { board: null, compare: null, open: null, playing: null, crowd: "full", stopTimer: null, current: null };

// The venue open on the page. app.js keeps its state private, so we note which venue it last loaded.
const realFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input?.url || "";
  const m = url.match(/\/api\/venues\/(\d+)\?use=/);
  if (m) {
    state.current = Number(m[1]);
    queueMicrotask(renderAddBar);
  }
  return realFetch(input, init);
};

async function api(path, opts = {}) {
  const res = await realFetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.detail || `HTTP ${res.status}`);
  return body;
}

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso.length === 10 ? iso + "T12:00:00" : iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function since(days) {
  if (days == null) return "";
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

// ------------------------------------------------------------------ board

async function loadBoard() {
  try {
    state.board = await api("/api/pipeline");
  } catch {
    state.board = { groups: [], count: 0 };
  }
  renderBoard();
  renderComparePickers();
}

function entryLine(e) {
  const bits = [];
  if (e.space_name) bits.push(e.space_name);
  if (e.event_date) bits.push(`for ${e.event_date}`);
  let when = "";
  if (e.status === "drafted") when = "Not sent yet.";
  else if (e.days_since_sent != null) when = `First email ${since(e.days_since_sent)}.`;
  let next = "";
  if (e.follow_up_due) next = " A follow-up is due.";
  else if (e.next_follow_up) next = ` Follow up ${fmtDate(e.next_follow_up)}.`;
  return `${esc(bits.join(", "))}. ${when}${next}`;
}

function renderBoard() {
  const b = state.board;
  const box = $("pl-board");
  if (!b.count) {
    box.innerHTML = `<p class="pl-empty">Nothing here yet. Open a venue above and add it, and it will show up here with its email.</p>`;
    return;
  }
  box.innerHTML = b.groups.map((g) => `
    <div class="pl-group">
      <h3>${LABEL[g.status]} <span>${g.entries.length}</span></h3>
      <ul class="pl-rows">
        ${g.entries.map((e) => `
          <li data-id="${e.venue_id}" class="${e.follow_up_due ? "due" : ""}">
            <div class="pl-main">
              <div class="pl-name">${esc(e.name)}</div>
              <div class="pl-meta">${entryLine(e)}</div>
            </div>
            <div class="pl-actions">
              <select aria-label="Status for ${esc(e.name)}" data-act="status">
                ${STATUSES.map((s) => `<option value="${s}" ${s === e.status ? "selected" : ""}>${LABEL[s]}</option>`).join("")}
              </select>
              <button class="pl-link" data-act="email">Email</button>
              <button class="pl-link" data-act="follow">Follow up</button>
              <button class="pl-link quiet" data-act="remove">Remove</button>
            </div>
            <div class="pl-draft" hidden></div>
          </li>`).join("")}
      </ul>
    </div>`).join("");

  box.querySelectorAll("li[data-id]").forEach((li) => {
    const id = Number(li.dataset.id);
    li.querySelector('[data-act="status"]').onchange = async (ev) => {
      await api(`/api/pipeline/${id}`, { method: "PATCH", body: { status: ev.target.value } });
      loadBoard();
    };
    li.querySelector('[data-act="email"]').onclick = () => showEmail(li, id);
    li.querySelector('[data-act="follow"]').onclick = () => showFollowUp(li, id);
    li.querySelector('[data-act="remove"]').onclick = async () => {
      await api(`/api/pipeline/${id}`, { method: "DELETE" });
      loadBoard();
    };
  });
}

function findEntry(id) {
  for (const g of state.board.groups) for (const e of g.entries) if (e.venue_id === id) return e;
  return null;
}

function draftHTML(d, extra = "") {
  const to = d.to ? [d.to.name, d.to.email || d.to.phone].filter(Boolean).join(", ") : "";
  return `
    <div class="pl-email">
      <div class="subj">${esc(d.subject)}</div>
      ${to ? `<div class="to">To ${esc(to)}</div>` : ""}
      <div class="body">${esc(d.body)}</div>
    </div>
    <p class="pl-draft-actions">
      <button class="pl-link" data-act="copy">Copy</button>
      ${extra}
      <button class="pl-link quiet" data-act="close">Close</button>
    </p>`;
}

function wireDraft(li, d) {
  const box = li.querySelector(".pl-draft");
  box.querySelector('[data-act="copy"]').onclick = async (ev) => {
    try { await navigator.clipboard.writeText(`Subject: ${d.subject}\n\n${d.body}`); ev.target.textContent = "Copied"; }
    catch { ev.target.textContent = "Select the text to copy"; }
  };
  box.querySelector('[data-act="close"]').onclick = () => { box.hidden = true; state.open = null; };
}

function openDraft(li, html) {
  document.querySelectorAll(".pl-draft").forEach((el) => (el.hidden = true));
  const box = li.querySelector(".pl-draft");
  box.innerHTML = html;
  box.hidden = false;
  return box;
}

function showEmail(li, id) {
  const e = findEntry(id);
  if (!e) return;
  const d = { ...e.email, to: e.contact };
  const extra = e.status === "drafted" ? `<button class="pl-link" data-act="sent">Mark as sent</button>` : "";
  const box = openDraft(li, draftHTML(d, extra));
  wireDraft(li, d);
  const sent = box.querySelector('[data-act="sent"]');
  if (sent) sent.onclick = async () => {
    await api(`/api/pipeline/${id}`, { method: "PATCH", body: { status: "sent" } });
    loadBoard();
  };
}

async function showFollowUp(li, id) {
  const box = openDraft(li, `<p class="pl-meta">Writing a follow-up…</p>`);
  try {
    const d = await api(`/api/pipeline/${id}/follow-up`, { method: "POST", body: {} });
    box.innerHTML = draftHTML(d);
    wireDraft(li, d);
  } catch (err) {
    box.innerHTML = `<p class="pl-meta">Couldn't draft that: ${esc(err.message)}</p>`;
  }
}

// ------------------------------------------------------------------ add the venue on screen

function renderAddBar() {
  const bar = $("pl-add");
  const id = state.current;
  if (!id) { bar.hidden = true; return; }
  const name = document.getElementById("d-name")?.textContent || "this venue";
  const tracked = state.board && findEntry(id);
  bar.hidden = false;
  bar.innerHTML = tracked
    ? `<span>${esc(tracked.name)} is on your list.</span>`
    : `<button class="pl-cta" id="pl-add-btn">Add ${esc(name)}</button><span class="pl-meta">We'll draft the first email for you.</span>`;
  const btn = $("pl-add-btn");
  if (btn) btn.onclick = addCurrent;
}

async function addCurrent() {
  const btn = $("pl-add-btn");
  btn.disabled = true;
  btn.textContent = "Adding…";
  const brief = document.getElementById("brief")?.value || "";
  const audience = Number((brief.match(/(\d+)\s*(?:guests|people|audience|seats)/i) || [])[1]) || 60;
  const group = Number((brief.match(/(\d+)\s*(?:singers|members|voices|performers)/i) || [])[1]) || 14;
  const nights = Number((brief.match(/(\d+)\s*nights?/i) || [])[1]) || 2;
  const date = (brief.match(/\b((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2})\b/i) || [])[1] || "";
  try {
    await api("/api/pipeline", { method: "POST", body: { venue_id: state.current, audience, group_size: group, nights, event_date: date } });
  } catch (err) {
    btn.textContent = `Couldn't add it: ${err.message}`;
    return;
  }
  await loadBoard();
  renderAddBar();
}

// ------------------------------------------------------------------ compare and listen

function allEntries() {
  return (state.board?.groups || []).flatMap((g) => g.entries);
}

function renderComparePickers() {
  const list = allEntries();
  const band = $("pl-compare");
  band.hidden = list.length < 2;
  if (list.length < 2) return;
  const opts = (sel) => list.map((e) => `<option value="${e.venue_id}" ${e.venue_id === sel ? "selected" : ""}>${esc(e.name)}</option>`).join("");
  const a = Number($("pl-a").value) || list[0].venue_id;
  let b = Number($("pl-b").value) || list[1].venue_id;
  if (b === a) b = list.find((e) => e.venue_id !== a).venue_id;
  $("pl-a").innerHTML = opts(a);
  $("pl-b").innerHTML = opts(b);
  if (!state.compare || state.compare.a.venue_id !== a || state.compare.b.venue_id !== b) runCompare();
}

async function runCompare() {
  const a = Number($("pl-a").value), b = Number($("pl-b").value);
  if (!a || !b) return;
  const out = $("pl-sides");
  if (a === b) {
    out.innerHTML = `<p class="pl-meta">Pick two different venues.</p>`;
    return;
  }
  out.innerHTML = `<p class="pl-meta">Measuring both rooms…</p>`;
  const audience = findEntry(a)?.audience || 60;
  const group = findEntry(a)?.group_size || 14;
  const nights = findEntry(a)?.nights || 2;
  try {
    state.compare = await api(`/api/compare?a=${a}&b=${b}&audience=${audience}&group_size=${group}&nights=${nights}`);
  } catch (err) {
    out.innerHTML = `<p class="pl-meta">Couldn't compare them: ${esc(err.message)}</p>`;
    return;
  }
  renderCompare();
}

function side(key) {
  const v = state.compare[key];
  const r = v.room || {};
  const s = v.lodging;
  const c = v.cost;
  const rt = state.crowd === "full" ? r.rt60_occupied_s : r.rt60_empty_s;
  const [lo, hi] = r.target_s || [0, 0];
  const fit = rt == null ? "" : rt < lo ? "A little dry" : rt > hi ? "On the live side" : "In the sweet spot";
  const row = (k, val) => `<div><dt>${k}</dt><dd>${val}</dd></div>`;
  return `
    <div class="pl-side">
      <p class="pl-which">${key.toUpperCase()}</p>
      <h3 class="pl-venue">${esc(v.name)}</h3>
      <p class="pl-room">${esc(r.name || "No scanned room")}</p>
      <p class="pl-rt">${rt ?? "–"}<small>s</small></p>
      <p class="pl-fit">${fit}${state.crowd === "full" ? " with a full house" : " when empty"}.</p>
      <button class="pl-play" data-key="${key}" aria-label="Play the chord in ${esc(v.name)}"><span class="tri"></span></button>
      <dl class="pl-specs">
        ${row("Target", `${lo}–${hi}s`)}
        ${row("Seats", r.capacity_seated ?? "–")}
        ${row("Room", r.area_sqft ? `${Number(r.area_sqft).toLocaleString()} sq ft` : "–")}
        ${row("Stay", s ? `${esc(s.name)}${s.same_building ? ", same building" : `, ${s.distance_miles} mi`}` : "None nearby")}
        ${row("Venue fee", money(c.venue_fee_estimate))}
        ${row("Lodging", money(c.lodging_estimate))}
        ${row("All in", `<b>${money(c.total)}</b>`)}
        ${row("Each singer", money(c.per_member))}
      </dl>
    </div>`;
}

function renderCompare() {
  $("pl-sides").innerHTML = `<div class="pl-grid">${side("a")}${side("b")}</div>
    <p class="pl-summary">${esc(state.compare.summary)}</p>
    <p class="note">${esc(state.compare.note)}</p>`;
  document.querySelectorAll(".pl-play").forEach((btn) => (btn.onclick = () => listen(btn.dataset.key)));
  markPlaying();
}

function roomFor(key) {
  const r = state.compare[key].room || {};
  const rt = (state.crowd === "full" ? r.rt60_occupied_s : r.rt60_empty_s) || 1;
  return [rt, r.volume_m3 || 500];
}

async function listen(key) {
  if (state.playing === key) {
    sound.stopChoir();
    state.playing = null;
    clearTimeout(state.stopTimer);
    markPlaying();
    return;
  }
  const wasPlaying = state.playing;
  state.playing = key;
  sound.setRoom(...roomFor(key));
  markPlaying();
  // Switching mid-chord keeps the music going and just swaps the room around it.
  if (!wasPlaying) {
    const secs = await sound.playChoir();
    // The listener may have switched rooms while the audio was starting.
    if (state.playing) sound.setRoom(...roomFor(state.playing));
    clearTimeout(state.stopTimer);
    state.stopTimer = setTimeout(() => { state.playing = null; markPlaying(); }, secs * 1000);
  }
}

function markPlaying() {
  document.querySelectorAll(".pl-play").forEach((b) => b.classList.toggle("on", b.dataset.key === state.playing));
  const now = $("pl-now");
  if (!state.compare) return;
  now.textContent = state.playing
    ? `Now hearing ${state.compare[state.playing].name}. Press the other one to switch rooms mid-chord.`
    : "Press play on either room, then switch while it sings.";
}

// ------------------------------------------------------------------ boot

function boot() {
  $("pl-a").onchange = runCompare;
  $("pl-b").onchange = runCompare;
  document.querySelectorAll("#pl-crowd button").forEach((btn) => {
    btn.onclick = () => {
      state.crowd = btn.dataset.crowd;
      document.querySelectorAll("#pl-crowd button").forEach((x) => x.classList.toggle("on", x === btn));
      if (state.compare) renderCompare();
      if (state.playing) sound.setRoom(...roomFor(state.playing));
    };
  });
  // Keep the button's label in step with the venue app.js is showing.
  const name = document.getElementById("d-name");
  if (name) new MutationObserver(renderAddBar).observe(name, { childList: true, characterData: true, subtree: true });
  const v = Number(new URLSearchParams(location.search).get("venue"));
  if (v) state.current = state.current || v;
  loadBoard().then(renderAddBar);
  window.addEventListener("pipeline:changed", () => loadBoard().then(renderAddBar)); // layout.js: a booking request was sent
}

boot();
