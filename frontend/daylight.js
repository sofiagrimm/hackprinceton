// Daylight in the room: the floor's light level through the day, from /api/daylight.
//
// The server finds the windows in the room's 360 photo, follows the sun for the show
// date, checks the neighbouring buildings for shade, and returns a lux grid for every
// ten minutes. This draws the grid for the time on the slider, tells the 360 viewer where
// the sun patches fall, and lets the visitor turn the room when we have its north wrong.

const RAD = Math.PI / 180;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Unit vector toward the sun in the room frame (same as daylight.py sun_vector). */
export function sunVector(altitude, azimuth, rotation) {
  const a = altitude * RAD, rel = (azimuth - rotation) * RAD;
  return [-Math.cos(a) * Math.sin(rel), Math.sin(a), Math.cos(a) * Math.cos(rel)];
}

export function decodeLux(b64) {
  if (!b64) return null;
  const bin = atob(b64);
  const out = new Float32Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = 10 ** (bin.charCodeAt(i) / 40) - 1;
  return out;
}

const fmtMinute = (m) => { const h = Math.floor(m / 60), mm = m % 60; return `${((h + 11) % 12) + 1}:${String(mm).padStart(2, "0")}${h >= 12 ? "pm" : "am"}`; };
const fmtLux = (v) => (v >= 10000 ? `${Math.round(v / 1000)}k` : v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`);

// Colour ramp on a log scale, 10 lux (dark wine) to 30,000 lux (pale cream).
const STOPS = [[0, [36, 12, 16]], [0.3, [116, 28, 44]], [0.55, [196, 82, 52]], [0.75, [235, 165, 72]], [1, [255, 244, 214]]];
function ramp(lux) {
  const t = Math.max(0, Math.min(1, (Math.log10(Math.max(lux, 1)) - 1) / (Math.log10(30000) - 1)));
  for (let i = 1; i < STOPS.length; i++) {
    if (t <= STOPS[i][0]) {
      const [t0, a] = STOPS[i - 1], [t1, b] = STOPS[i], k = (t - t0) / (t1 - t0);
      return a.map((v, j) => Math.round(v + (b[j] - v) * k));
    }
  }
  return STOPS[STOPS.length - 1][1];
}

export function createDaylight(root, { viewer }) {
  root.innerHTML = `
    <div class="dl-head">
      <h3 class="sub-head">Daylight in this room</h3>
      <p class="note dl-lede">Worked out from the windows in the photo, the sun on your date and the buildings around it.</p>
    </div>
    <div class="dl-grid">
      <div class="dl-mapwrap">
        <canvas class="dl-map" aria-label="Floor plan of the room coloured by how bright the floor is"></canvas>
        <div class="dl-legend" aria-hidden="true"></div>
        <p class="dl-now" aria-live="polite"></p>
      </div>
      <div class="dl-side">
        <ul class="dl-verdicts"></ul>
        <div class="dl-turn">
          <p class="mini-head">Which way the room faces</p>
          <p class="dl-facing"></p>
          <p class="dl-turn-btns">
            <button type="button" class="link" data-turn="-90">Turn left</button>
            <button type="button" class="link" data-turn="90">Turn right</button>
            <button type="button" class="link" data-turn="reset">Line up with the building</button>
          </p>
        </div>
        <p class="dl-neighbours note"></p>
        <details class="dl-assume"><summary>What we assumed</summary><ul></ul></details>
      </div>
    </div>`;
  const q = (s) => root.querySelector(s);
  const canvas = q(".dl-map");
  let data = null, req = null, minute = 1110, sun = null, token = 0;

  // Legend: the ramp with a few marks, including the 300 lux reading line.
  q(".dl-legend").innerHTML = `<span class="dl-bar" style="background:linear-gradient(90deg,${[10, 30, 100, 300, 1000, 3000, 10000, 30000].map((v) => `rgb(${ramp(v).join(",")})`).join(",")})"></span>
    <span class="dl-ticks">${["10", "100", "300", "1k", "10k lux"].map((t) => `<span>${t}</span>`).join("")}</span>`;

  root.querySelectorAll("[data-turn]").forEach((b) => (b.onclick = () => {
    if (!data || !req) return;
    const turn = b.dataset.turn;
    load({ ...req, rotation: turn === "reset" ? null : (data.rotation + Number(turn) + 360) % 360 });
  }));

  async function load(r) {
    req = r;
    const my = ++token;
    root.hidden = false;
    q(".dl-now").textContent = "Working out the daylight…";
    const p = new URLSearchParams({ venue_id: r.venueId, model_id: r.modelId, pano_id: r.panoId, date: r.date, room: r.name || "" });
    if (r.area) p.set("area_sqft", r.area);
    if (r.height) p.set("height_ft", r.height);
    if (r.rotation != null) p.set("rotation", r.rotation);
    let d;
    try {
      const res = await fetch(`/api/daylight?${p}`);
      if (!res.ok) throw new Error((await res.json()).detail || res.status);
      d = await res.json();
    } catch (err) {
      if (my !== token) return;
      data = null;
      viewer()?.clearWindows?.();
      q(".dl-now").textContent = `No daylight figures for this room: ${err.message}`;
      return;
    }
    if (my !== token) return;
    data = d;
    data.frames.forEach((f) => { f.grid = decodeLux(f.lux); });
    viewer()?.setWindows?.(d.room, d.windows.walls);
    // building names (e.g. "Westmore on Wilshire") as little ransom-note cut-outs
    const names = (d.neighbours?.with_height || []).map((b) => b.name).filter(Boolean).sort((x, y) => y.length - x.length);
    const cutNames = (t) => names.reduce((h, n) => h.split(esc(n)).join(`<span class="ransom-me dl-name">${esc(n)}</span>`), esc(t));
    q(".dl-verdicts").innerHTML = [...d.verdicts, ...d.shade].map((v) => `<li>${cutNames(v)}</li>`).join("");
    const glass = d.walls.filter((w) => w.window_m2 > 0.5).map((w) => `${w.compass} (${Math.round(w.window_m2)} m² of glass)`);
    q(".dl-facing").textContent = glass.length ? `Windows face ${glass.join(", ")}.` : "We didn't find windows in this photo.";
    const nb = d.neighbours;
    q(".dl-neighbours").innerHTML = nb.with_height.length
      ? `Nearby: ${nb.with_height.slice(0, 4).map((b) => `<span class="ransom-me dl-name">${esc(b.name)}</span> (${b.floors} floors, ${b.distance_m} m ${b.compass})`).join(", ")}.`
      : "We have no heights for the buildings around this one, so we couldn't check for shade.";
    q(".dl-assume ul").innerHTML = d.assumptions.map((a) => `<li>${esc(a)}</li>`).join("");
    r.onNeighbours?.(nb.buildings);
    draw();
  }

  function frameAt(m) {
    if (!data) return null;
    return data.frames.reduce((best, f) => (Math.abs(f.minute - m) < Math.abs(best.minute - m) ? f : best), data.frames[0]);
  }

  function draw() {
    if (!data) return;
    const f = frameAt(minute);
    const { grid, room, stage, windows } = data;
    const wrap = canvas.parentElement.clientWidth || 480;
    // Draw the room with north up: rotate the plan by the room's turn.
    const span = Math.hypot(room.w, room.d) * 1.08;
    const size = Math.min(wrap, 520);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = canvas.height = size * dpr;
    canvas.style.width = canvas.style.height = `${size}px`;
    const g = canvas.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, size, size);
    const k = size / span;
    g.save();
    g.translate(size / 2, size / 2);
    // Room +z points to bearing `rotation`; +x to rotation - 90. Screen: north up, east right.
    // A room vector (x, z) has east = -x cos(r) + z sin(r) ... built from the two axis bearings.
    const r = data.rotation * RAD;
    const ex = [Math.sin(r - Math.PI / 2), -Math.cos(r - Math.PI / 2)]; // +x on screen (east, down)
    const ez = [Math.sin(r), -Math.cos(r)];                               // +z on screen
    g.transform(ex[0] * k, ex[1] * k, ez[0] * k, ez[1] * k, 0, 0);
    const lux = f?.grid;
    for (let iz = 0; iz < grid.nz; iz++) {
      for (let ix = 0; ix < grid.nx; ix++) {
        const v = lux ? lux[iz * grid.nx + ix] : 0;
        g.fillStyle = `rgb(${ramp(v).join(",")})`;
        g.fillRect(grid.x0 + ix * grid.cw, grid.z0 + iz * grid.cd, grid.cw + 0.02, grid.cd + 0.02);
      }
    }
    // Stage
    g.strokeStyle = "rgba(243,236,225,0.95)";
    g.lineWidth = 2 / k;
    g.setLineDash([6 / k, 4 / k]);
    g.strokeRect(stage.x0, stage.z0, stage.x1 - stage.x0, stage.z1 - stage.z0);
    g.setLineDash([]);
    // Windows along the walls (any height), as bright ticks on the outline.
    const hx = room.w / 2, hz = room.d / 2, cell = windows.cell_m;
    g.strokeStyle = "rgba(29,27,22,0.9)";
    g.lineWidth = 3 / k;
    g.strokeRect(-hx, -hz, room.w, room.d);
    g.strokeStyle = "#9fd3ff";
    g.lineWidth = 5 / k;
    windows.walls.forEach((w) => {
      const cols = new Set(w.cells.map(([a]) => a));
      cols.forEach((a) => {
        const along = (w.id[1] === "x" ? -hz : -hx) + a * cell;
        g.beginPath();
        if (w.id[1] === "x") { const x = w.id[0] === "+" ? hx : -hx; g.moveTo(x, along); g.lineTo(x, along + cell); }
        else { const z = w.id[0] === "+" ? hz : -hz; g.moveTo(along, z); g.lineTo(along + cell, z); }
        g.stroke();
      });
    });
    g.restore();
    // Labels drawn upright.
    g.fillStyle = "rgba(243,236,225,0.95)";
    g.font = '600 12px "DM Sans", sans-serif';
    const sc = [(stage.x0 + stage.x1) / 2, (stage.z0 + stage.z1) / 2];
    const sx = size / 2 + (sc[0] * ex[0] + sc[1] * ez[0]) * k, sy = size / 2 + (sc[0] * ex[1] + sc[1] * ez[1]) * k;
    g.textAlign = "center";
    g.fillText("stage", sx, sy + 4);
    // North arrow
    g.strokeStyle = g.fillStyle = "rgba(29,27,22,0.85)";
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(size - 22, 34); g.lineTo(size - 22, 12); g.stroke();
    g.beginPath(); g.moveTo(size - 27, 18); g.lineTo(size - 22, 10); g.lineTo(size - 17, 18); g.fill();
    g.fillText("N", size - 22, 48);

    const shadedNames = (f?.shaded || []).map((w) => data.walls.find((x) => x.id === w)?.compass).filter(Boolean);
    q(".dl-now").textContent = !f || f.alt <= 0
      ? `${fmtMinute(minute)}: the sun is down, so the room runs on its own lights.`
      : `${fmtMinute(f.minute)}: about ${fmtLux(f.stage_lux)} lux on the stage, ${fmtLux(f.mean_lux)} lux on average across the floor`
        + (f.sun_on_stage > 0.05 ? `, sun on ${Math.round(f.sun_on_stage * 100)}% of the stage` : "")
        + (shadedNames.length ? `. The ${shadedNames.join(" and ")} windows are in a neighbour's shadow.` : ".");
    // The 360 viewer's sun patches follow the same sun and the same shade.
    if (sun) viewer()?.setSunPatches?.(sunVector(sun.altitude, sun.azimuth, data.rotation), f?.shaded || []);
  }

  new ResizeObserver(() => data && draw()).observe(root);

  return {
    load,
    /** minute: local minutes after midnight; s: {altitude, azimuth} from sun.js for that minute. */
    update(m, s) { minute = m; sun = s; draw(); },
    get rotation() { return data?.rotation; },
  };
}
