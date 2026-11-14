// See the light: where the sun is over a venue at a given date and time, and
// the shadow the building casts on the Vexcel aerial.
//
// Solar position uses the NOAA approximation (good to a fraction of a degree,
// plenty for planning a shoot or an outdoor set).

const RAD = Math.PI / 180;

/** Sun altitude and azimuth (degrees, azimuth clockwise from north). */
export function sunPosition(date, lat, lon) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const n = jd - 2451545.0;
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * RAD;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const eps = (23.439 - 0.0000004 * n) * RAD;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const gmst = (18.697374558 + 24.06570982441908 * n) % 24;
  const lst = (gmst * 15 + lon) * RAD;
  const ha = lst - ra;
  const phi = lat * RAD;
  const alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(ha));
  const az = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(phi) - Math.sin(phi) * Math.cos(ha));
  return { altitude: alt / RAD, azimuth: ((az / RAD) + 360) % 360 };
}

/** Sunrise, sunset and golden hours by sampling the day (local wall clock of the venue). */
export function dayTimeline(dateStr, lat, lon, utcOffsetHours) {
  const samples = [];
  for (let m = 0; m <= 24 * 60; m += 5) {
    const d = localToUtc(dateStr, m, utcOffsetHours);
    samples.push({ minute: m, ...sunPosition(d, lat, lon) });
  }
  const cross = (deg, rising) => {
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1].altitude, b = samples[i].altitude;
      if (rising ? a < deg && b >= deg : a >= deg && b < deg) return samples[i].minute;
    }
    return null;
  };
  return {
    samples,
    sunrise: cross(-0.83, true),
    sunset: cross(-0.83, false),
    goldenMorningEnd: cross(6, true),
    goldenEveningStart: cross(6, false),
  };
}

export function localToUtc(dateStr, minuteOfDay, utcOffsetHours) {
  const [y, mo, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, d, 0, minuteOfDay) - utcOffsetHours * 3600000);
}

export function fmtMinute(m) {
  if (m == null) return "-";
  const h = Math.floor(m / 60), mm = m % 60;
  const ampm = h >= 12 ? "pm" : "am";
  return `${((h + 11) % 12) + 1}:${String(mm).padStart(2, "0")}${ampm}`;
}

/** Rough UTC offset for our two metros on a date (US daylight time rules). */
export function utcOffsetFor(metro, dateStr) {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d));
  const secondSunMarch = nthSunday(y, 2, 2), firstSunNov = nthSunday(y, 10, 1);
  const dst = date >= secondSunMarch && date < firstSunNov;
  const std = metro === "Houston" ? -6 : -8;
  return std + (dst ? 1 : 0);
}

function nthSunday(year, month, n) {
  const first = new Date(Date.UTC(year, month, 1));
  const offset = (7 - first.getUTCDay()) % 7;
  return new Date(Date.UTC(year, month, 1 + offset + (n - 1) * 7));
}

/**
 * Draw the building's shadow on a canvas laid over the aerial image.
 * footprint: [[lon, lat], ...]; bounds: {west, east, south, north}.
 */
export function drawShadow(canvas, bounds, footprint, heightFt, sun) {
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const toPx = ([lon, lat]) => [
    ((lon - bounds.west) / (bounds.east - bounds.west)) * W,
    ((bounds.north - lat) / (bounds.north - bounds.south)) * H,
  ];
  if (sun.altitude <= 0) {
    ctx.fillStyle = "rgba(8, 12, 32, 0.55)";
    ctx.fillRect(0, 0, W, H);
    return { length: null };
  }
  if (!footprint || footprint.length < 3) return { length: null };

  const heightM = heightFt * 0.3048;
  const lengthM = Math.min(heightM / Math.tan(sun.altitude * RAD), 400);
  const dir = (sun.azimuth + 180) * RAD; // shadows point away from the sun
  const midLat = (bounds.north + bounds.south) / 2;
  const dLon = (lengthM * Math.sin(dir)) / (111320 * Math.cos(midLat * RAD));
  const dLat = (lengthM * Math.cos(dir)) / 111320;
  const base = footprint.map(toPx);
  const tip = footprint.map(([lon, lat]) => toPx([lon + dLon, lat + dLat]));

  // The shadow is the sweep of the footprint toward its projection: the hull of both.
  const hull = convexHull([...base, ...tip]);
  ctx.fillStyle = "rgba(10, 14, 40, 0.5)";
  ctx.beginPath();
  hull.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.fill();

  // Sunlit roof outline.
  ctx.strokeStyle = "rgba(255, 196, 64, 0.95)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  base.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.stroke();

  // Sun direction arrow from the edge of the image.
  const cx = W / 2, cy = H / 2, r = Math.min(W, H) * 0.44;
  const sx = cx + r * Math.sin(sun.azimuth * RAD), sy = cy - r * Math.cos(sun.azimuth * RAD);
  ctx.fillStyle = "rgba(255, 196, 64, 1)";
  ctx.beginPath();
  ctx.arc(sx, sy, Math.max(10, W * 0.018), 0, Math.PI * 2);
  ctx.fill();
  return { length: lengthM };
}

/** Which way each wall faces and whether the sun is on it. */
export function litFacades(footprint, sun) {
  if (!footprint || footprint.length < 3 || sun.altitude <= 0) return [];
  const pts = footprint.slice(0, -1);
  const ccw = signedArea(pts) > 0;
  const faces = {};
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    const dx = (x2 - x1) * Math.cos(y1 * RAD), dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (!len) continue;
    // Outward normal (x east, y north).
    const nx = ccw ? dy : -dy, ny = ccw ? -dx : dx;
    const facing = ((Math.atan2(nx, ny) / RAD) + 360) % 360;
    const label = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(facing / 45) % 8];
    const lit = Math.cos((facing - sun.azimuth) * RAD) > 0.1;
    faces[label] = faces[label] || { label, lit: false, length: 0 };
    faces[label].length += len;
    faces[label].lit = faces[label].lit || lit;
  }
  return Object.values(faces).sort((a, b) => b.length - a.length);
}

function signedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

function convexHull(points) {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const pt of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0) lower.pop();
    lower.push(pt);
  }
  for (const pt of p.reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= 0) upper.pop();
    upper.push(pt);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}
