// Image tab: drop in a picture (a film still, a mood-board frame) and get back the rooms that look like it.
// Talks to /api/lookalike (colour, light and layout match) and, when the server has a Claude key,
// /api/lookalike/rerank (Claude looks at the shortlist and reorders it by the feel of the space).

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let picture = null; // the chosen picture, shrunk, as a data: URL
let run = 0;

/** Shrink to at most 640px on the long side: plenty for matching, quick to send. */
function shrink(file) {
  return new Promise((done, fail) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, 640 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * k);
      c.height = Math.round(img.naturalHeight * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      done(c.toDataURL("image/jpeg", 0.86));
    };
    img.onerror = () => fail(new Error("That file isn't a picture we can read."));
    img.src = URL.createObjectURL(file);
  });
}

async function choose(file) {
  if (!file || !file.type.startsWith("image/")) { $("lk-status").textContent = "That file isn't a picture."; return; }
  try {
    picture = await shrink(file);
  } catch (e) { $("lk-status").textContent = e.message; return; }
  $("lk-preview").src = picture;
  $("lk-preview").hidden = false;
  $("lk-hint").textContent = "Drop another to swap it.";
  $("lk-form").classList.add("has-pic");
  $("lk-go").disabled = false;
  $("lk-status").textContent = "";
  find();
}

function row(r, i) {
  const line = r.why || (r.shared.length ? `Same ${r.shared.join(", ")}.` : `Reads as ${r.look.join(", ")}.`);
  return `
    <li class="tp-stop lk-row">
      <a class="lk-shot" href="#/venue/${r.venue_id}" style="--tilt:${[-1.6, 1.1, -0.6, 1.4][i % 4]}deg"><img src="${esc(r.picture)}?w=512" alt="${esc(r.name)}" loading="lazy"></a>
      <div>
        <p class="tp-city">${esc(r.city)}</p>
        <p class="tp-venue"><a href="#/venue/${r.venue_id}">${esc(r.name)}</a></p>
        <p class="tp-line">${esc(line)}</p>
        <p class="lk-links"><a class="tp-vote" href="#/venue/${r.venue_id}">see the space</a><a class="tp-vote" href="#/venue/${r.venue_id}/walk">walk it in 3D</a></p>
      </div>
      <p class="tp-cost">${r.match}%<small>match</small></p>
    </li>`;
}

function show(d) {
  $("lk-list").innerHTML = d.results.map(row).join("");
  $("lk-result").hidden = !d.results.length;
}

async function find() {
  if (!picture) return;
  const mine = ++run;
  $("lk-go").disabled = true;
  $("lk-status").textContent = "Comparing it with every room we've scanned…";
  try {
    const res = await fetch("/api/lookalike", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image: picture }) });
    const d = await res.json();
    if (mine !== run) return;
    if (!res.ok) throw new Error(d.detail || "Something went wrong.");
    if (!d.results.length) { $("lk-status").textContent = "No room photos are ready yet. Try again in a minute."; $("lk-result").hidden = true; return; }
    $("lk-summary").textContent = `Your picture reads as ${d.look.join(", ")}. These are the closest of ${d.rooms_compared.toLocaleString()} room views.`;
    show(d);
    $("lk-status").textContent = "";
    if (d.can_rerank) {
      $("lk-status").textContent = "Taking a closer look at the shortlist…";
      const rr = await fetch("/api/lookalike/rerank", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: d.token, results: d.results }) })
        .then((r) => r.json()).catch(() => null);
      if (mine !== run) return;
      if (rr?.reranked) show(rr);
      $("lk-status").textContent = "";
    }
  } catch (e) {
    if (mine === run) $("lk-status").textContent = e.message;
  } finally {
    if (mine === run) $("lk-go").disabled = !picture;
  }
}

function wire() {
  const drop = $("lk-drop");
  if (!drop) return;
  $("lk-file").onchange = (e) => choose(e.target.files[0]);
  ["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => choose(e.dataTransfer.files[0]));
  // paste a picture anywhere while the Image tab is open
  document.addEventListener("paste", (e) => {
    if (document.body.dataset.view !== "image") return;
    const item = [...(e.clipboardData?.items || [])].find((x) => x.type.startsWith("image/"));
    if (item) choose(item.getAsFile());
  });
  $("lk-form").onsubmit = (e) => { e.preventDefault(); find(); };
}

wire();
