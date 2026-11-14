"""Daylight in a scanned room: where the sun lands, how bright it is, and what shades it.

1. Windows. The room's 360 photo is six cube faces. We map every pixel onto a box the
   size of the scanned room (camera in the middle at eye height, the same box the
   browser draws), and mark wall pixels that look like glass: very bright, close to
   colourless, above the floor. They're binned into 25 cm cells per wall; specks smaller
   than a few cells (light fittings, reflections) are dropped.

2. Sun. NOAA solar position for the venue, date and time. The scan doesn't record
   which way is north, so the room is turned to line up with the building's walls
   (from the Vexcel footprint) and the visitor can turn it further.

3. Light levels, in lux, on a floor grid:
   - direct sun: a floor point is sunlit when the ray from it toward the sun leaves the
     room through a window cell. Clear-sky direct normal illuminance
     E_dn = 127,500 lux x exp(-0.21 m) (m = Kasten-Young air mass), x sin(altitude) on
     the floor, x 0.7 glazing transmittance;
   - skylight: each window cell is a patch of uniform luminance L = E_v / pi, where E_v is
     the vertical illuminance outside that wall (half the clear-sky diffuse plus ground
     reflection at 20%, plus direct sun on that wall). A floor point gets
     L x tau x A cos(theta_w) cos(theta_p) / d^2 from each cell;
   - inter-reflection: the split-flux average, rho / (A_room (1 - rho)) x the light that
     came in, with an average reflectance of 0.45.

4. Neighbours. Vexcel gives every building footprint around the venue and its ground
   elevation, but no heights here, so heights come from CoStar's floor counts (12 ft a
   floor) for buildings in our data. A wall's windows are in shadow when the ray from the
   matching side of the building toward the sun passes under a neighbour's roof line.
   Footprints we have no height for are counted and reported, not guessed.

It's an estimate for planning: the window finder can mistake a sunlit white wall for
glass, and real skies are rarely perfectly clear. The page says so.
"""

from __future__ import annotations

import io
import json
import math
import re
from datetime import date, datetime, timedelta, timezone

import numpy as np

from . import data, vexcel
from .config import CACHE_DIR

EYE = 1.55            # camera height in the scan, metres (same as the browser)
CELL = 0.25           # window grid, metres
TAU = 0.7             # glazing transmittance
RHO = 0.45            # average room reflectance for inter-reflection
GROUND_RHO = 0.2      # ground reflectance outside
FLOOR_FT_M = 12 * 0.3048
READ_LUX = 300        # reading music (IES/EN 12464 desk-task level)
FACE_ORDER = [2, 4, 0, 5, 1, 3]   # three.js cube slot (+x,-x,+y,-y,+z,-z) -> Matterport face
WALLS = ["+x", "-x", "+z", "-z"]
COMPASS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"]
RAD = math.pi / 180


# ----------------------------------------------------------------------------- geometry

def room_box(area_sqft: float | None, height_ft: float | None) -> dict:
    """The same box the browser uses: a little longer than wide, at least 2.6 m tall."""
    area = max(150.0, area_sqft or 800.0) * 0.0929
    w = math.sqrt(area / 1.3)
    d = area / w
    return {"hx": w / 2, "hz": d / 2, "h": max(2.6, (height_ft or 10) * 0.3048)}


def cube_dirs(slot: int, n: int) -> np.ndarray:
    """Unit view directions for an n x n cube face, OpenGL cube-map convention (what WebGL samples)."""
    c = (np.arange(n) + 0.5) / n * 2 - 1
    s, t = np.meshgrid(c, c)  # s across (column), t down (row)
    one = np.ones_like(s)
    d = {0: (one, -t, -s), 1: (-one, -t, s), 2: (s, one, t), 3: (s, -one, -t), 4: (s, -t, one), 5: (-s, -t, -one)}[slot]
    v = np.stack(d, -1)
    return v / np.linalg.norm(v, axis=-1, keepdims=True)


def box_hit(d: np.ndarray, box: dict) -> tuple[np.ndarray, np.ndarray]:
    """Where rays from the eye meet the box. Returns hit points and a surface code:
    0 +x, 1 -x, 2 +z, 3 -z (walls), 4 ceiling, 5 floor."""
    hx, hz, h = box["hx"], box["hz"], box["h"]
    dx, dy, dz = d[..., 0], d[..., 1], d[..., 2]
    eps = 1e-6
    tx = np.where(np.abs(dx) > eps, np.where(dx > 0, hx, -hx) / np.where(np.abs(dx) > eps, dx, 1), np.inf)
    tz = np.where(np.abs(dz) > eps, np.where(dz > 0, hz, -hz) / np.where(np.abs(dz) > eps, dz, 1), np.inf)
    ty = np.where(dy > eps, (h - EYE) / np.where(dy > eps, dy, 1), np.where(dy < -eps, -EYE / np.where(dy < -eps, dy, -1), np.inf))
    t = np.minimum(np.minimum(tx, tz), ty)
    p = d * t[..., None] + np.array([0, EYE, 0])
    code = np.where(t == tx, np.where(dx > 0, 0, 1), np.where(t == tz, np.where(dz > 0, 2, 3), np.where(dy > 0, 4, 5)))
    return p, code


def wall_axes(box: dict) -> list[dict]:
    """Each wall: its along-axis coordinate, half-length and inward normal (room frame)."""
    hx, hz = box["hx"], box["hz"]
    return [
        {"id": "+x", "along": "z", "half": hz, "plane": ("x", hx), "inward": (-1, 0, 0)},
        {"id": "-x", "along": "z", "half": hz, "plane": ("x", -hx), "inward": (1, 0, 0)},
        {"id": "+z", "along": "x", "half": hx, "plane": ("z", hz), "inward": (0, 0, -1)},
        {"id": "-z", "along": "x", "half": hx, "plane": ("z", -hz), "inward": (0, 0, 1)},
    ]


# ----------------------------------------------------------------------------- windows

def detect_windows(faces: dict[int, "np.ndarray"], box: dict, n: int = 192) -> list[dict]:
    """faces: three.js slot -> RGB float image (n x n, 0..1). Returns per-wall window cells."""
    walls = wall_axes(box)
    grids = []
    for w in walls:
        na = max(1, int(math.ceil(2 * w["half"] / CELL)))
        nh = max(1, int(math.ceil(box["h"] / CELL)))
        grids.append({"tot": np.zeros((nh, na)), "win": np.zeros((nh, na)), "na": na, "nh": nh})
    for slot, img in faces.items():
        d = cube_dirs(slot, img.shape[0])
        p, code = box_hit(d, box)
        r, g, b = img[..., 0], img[..., 1], img[..., 2]
        lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
        sat = img.max(-1) - img.min(-1)
        glass = (lum > 0.78) & (sat < 0.22) & (p[..., 1] > 0.45)
        for wi, w in enumerate(walls):
            m = code == wi
            if not m.any():
                continue
            along = p[..., 2] if w["along"] == "z" else p[..., 0]
            ia = np.clip(((along[m] + w["half"]) / CELL).astype(int), 0, grids[wi]["na"] - 1)
            ih = np.clip((p[..., 1][m] / CELL).astype(int), 0, grids[wi]["nh"] - 1)
            np.add.at(grids[wi]["tot"], (ih, ia), 1)
            np.add.at(grids[wi]["win"], (ih, ia), glass[m].astype(float))
    out = []
    for w, gr in zip(walls, grids):
        cells = (gr["tot"] > 0) & (gr["win"] / np.maximum(gr["tot"], 1) > 0.5)
        cells = _drop_specks(cells, min_cells=4)
        hs, as_ = np.nonzero(cells)
        out.append({"id": w["id"], "na": gr["na"], "nh": gr["nh"],
                    "cells": [[int(a), int(h)] for h, a in zip(hs, as_)],
                    "area_m2": round(float(cells.sum()) * CELL * CELL, 2)})
    return out


def _drop_specks(mask: np.ndarray, min_cells: int) -> np.ndarray:
    """Keep 4-connected groups of at least min_cells (a light fitting is not a window)."""
    keep = np.zeros_like(mask)
    seen = np.zeros_like(mask)
    H, W = mask.shape
    for y0 in range(H):
        for x0 in range(W):
            if not mask[y0, x0] or seen[y0, x0]:
                continue
            stack, comp = [(y0, x0)], []
            seen[y0, x0] = True
            while stack:
                y, x = stack.pop()
                comp.append((y, x))
                for yy, xx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
                    if 0 <= yy < H and 0 <= xx < W and mask[yy, xx] and not seen[yy, xx]:
                        seen[yy, xx] = True
                        stack.append((yy, xx))
            if len(comp) >= min_cells:
                for y, x in comp:
                    keep[y, x] = True
    return keep


def windows_for_pano(model_id: str, pano_id: str, box: dict) -> list[dict] | None:
    """Detect windows from the cached cube faces (fetched through panos.face if needed)."""
    from PIL import Image

    from .panos import face
    faces = {}
    for slot, mp in enumerate(FACE_ORDER):
        raw = face(model_id, pano_id, mp)
        if not raw:
            return None
        img = Image.open(io.BytesIO(raw)).convert("RGB").resize((192, 192))
        faces[slot] = np.asarray(img, dtype=np.float32) / 255.0
    return detect_windows(faces, box)


# ----------------------------------------------------------------------------- sun and sky

def sun_position(when: datetime, lat: float, lon: float) -> tuple[float, float]:
    from .film import sun_position as sp
    return sp(when, lat, lon)


def utc_offset(metro: str, day: date) -> int:
    from .film import utc_offset as uo
    return uo(metro, day)


def wall_facing(wall: str, rotation: float) -> float:
    """Compass bearing a wall's outside faces, when the room's +z axis points to `rotation`.
    Room frame is right handed with y up, so +x points 90 degrees anticlockwise of +z."""
    return {"+z": rotation, "-z": rotation + 180, "+x": rotation - 90, "-x": rotation + 90}[wall] % 360


def sun_vector(alt: float, az: float, rotation: float) -> np.ndarray:
    """Unit vector toward the sun in the room frame (x, y up, z)."""
    a, rel = alt * RAD, (az - rotation) * RAD
    return np.array([-math.cos(a) * math.sin(rel), math.sin(a), math.cos(a) * math.cos(rel)])


def clear_sky(alt: float) -> tuple[float, float]:
    """(direct normal, diffuse horizontal) illuminance in lux for a clear sky."""
    if alt <= 0:
        return 0.0, 0.0
    m = 1 / (math.sin(alt * RAD) + 0.50572 * (alt + 6.07995) ** -1.6364)  # Kasten-Young air mass
    return 127_500 * math.exp(-0.21 * m), 1000 * (0.8 + 15.5 * math.sin(alt * RAD) ** 0.5)


def vertical_outside(alt: float, az: float, facing: float, shaded: bool) -> float:
    """Illuminance on the outside of a vertical wall facing `facing`."""
    edn, edh = clear_sky(alt)
    egh = edh + edn * math.sin(max(alt, 0) * RAD)
    direct = 0.0 if shaded else edn * max(0.0, math.cos(alt * RAD) * math.cos((az - facing) * RAD))
    return edh / 2 + GROUND_RHO * egh / 2 + direct


def floor_grid(box: dict, cell: float | None = None) -> dict:
    w, d = 2 * box["hx"], 2 * box["hz"]
    cell = cell or max(0.5, max(w, d) / 40)
    nx, nz = max(2, int(round(w / cell))), max(2, int(round(d / cell)))
    xs = -box["hx"] + (np.arange(nx) + 0.5) * w / nx
    zs = -box["hz"] + (np.arange(nz) + 0.5) * d / nz
    X, Z = np.meshgrid(xs, zs)
    return {"nx": nx, "nz": nz, "cw": w / nx, "cd": d / nz, "X": X, "Z": Z}


def window_cells_world(windows: list[dict], box: dict) -> list[dict]:
    """Window cell centres in the room frame, with their wall's inward normal."""
    out = []
    for w, ax in zip(windows, wall_axes(box)):
        for a, h in w["cells"]:
            along = -ax["half"] + (a + 0.5) * CELL
            y = (h + 0.5) * CELL
            axis, pos = ax["plane"]
            p = (pos, y, along) if axis == "x" else (along, y, pos)
            out.append({"wall": w["id"], "p": p, "n": ax["inward"]})
    return out


def sunlit(points: np.ndarray, s: np.ndarray, windows: list[dict], box: dict, shaded: dict) -> np.ndarray:
    """Is each point (N x 3) lit by the sun through a window? Ray toward the sun, find the exit."""
    if s[1] <= 0:
        return np.zeros(len(points), bool)
    hx, hz, h = box["hx"], box["hz"], box["h"]
    big = 1e9
    tx = (np.sign(s[0]) * hx - points[:, 0]) / s[0] if abs(s[0]) > 1e-9 else np.full(len(points), big)
    tz = (np.sign(s[2]) * hz - points[:, 2]) / s[2] if abs(s[2]) > 1e-9 else np.full(len(points), big)
    ty = (h - points[:, 1]) / s[1]
    t = np.minimum(np.minimum(tx, tz), ty)
    q = points + t[:, None] * s
    lit = np.zeros(len(points), bool)
    lookup = {w["id"]: w for w in windows}
    for wid, tw, along_i in (("+x" if s[0] > 0 else "-x", tx, 2), ("+z" if s[2] > 0 else "-z", tz, 0)):
        w = lookup.get(wid)
        if not w or not w["cells"] or shaded.get(wid):
            continue
        hit = (t == tw) & (t < ty)
        if not hit.any():
            continue
        half = (hz if along_i == 2 else hx)
        ia = ((q[hit, along_i] + half) / CELL).astype(int)
        ih = (q[hit, 1] / CELL).astype(int)
        cells = {(a, hh) for a, hh in w["cells"]}
        ok = np.array([(int(a), int(hh)) in cells for a, hh in zip(ia, ih)])
        idx = np.nonzero(hit)[0]
        lit[idx[ok]] = True
    return lit


def diffuse_factors(grid: dict, cells: list[dict]) -> dict[str, np.ndarray]:
    """Per wall: sum over its window cells of A cos(theta_w) cos(theta_p) / (pi d^2) at each floor point."""
    P = np.stack([grid["X"], np.zeros_like(grid["X"]), grid["Z"]], -1)
    out = {w: np.zeros(grid["X"].shape) for w in WALLS}
    A = CELL * CELL
    for c in cells:
        v = P - np.array(c["p"])          # window -> floor point
        d2 = (v ** 2).sum(-1)
        d = np.sqrt(d2)
        cos_w = np.clip((v @ np.array(c["n"], float)) / d, 0, None)
        cos_p = np.clip(c["p"][1] / d, 0, None)  # floor normal is up; the window is above the floor
        out[c["wall"]] += A * cos_w * cos_p / (math.pi * d2)
    return out


# ----------------------------------------------------------------------------- neighbours

def _local(lat0: float, lon0: float):
    k = 111_320 * math.cos(lat0 * RAD)
    return lambda lon, lat: ((lon - lon0) * k, (lat - lat0) * 111_320)


def _inside(poly: list[tuple[float, float]], x: float, y: float) -> bool:
    c = False
    for (x1, y1), (x2, y2) in zip(poly, poly[1:] + poly[:1]):
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / ((y2 - y1) or 1e-12) + x1:
            c = not c
    return c


def neighbours(venue: dict, radius_m: float = 200) -> dict:
    """Buildings around the venue: Vexcel footprints and ground elevations, CoStar heights."""
    path = CACHE_DIR / f"daylight_nb_{venue['id']}.json"
    if path.exists():
        return json.loads(path.read_text())
    to = _local(venue["lat"], venue["lon"])
    costar = []
    for o in data.venues().values():
        dist = data.miles_between(venue["lat"], venue["lon"], o["lat"], o["lon"]) * 1609.34
        if dist < radius_m + 60 and o.get("stories"):
            costar.append({"id": o["id"], "name": o["name"], "floors": o["stories"], "xy": to(o["lon"], o["lat"]),
                           "building_sf": o.get("building_sf")})
    structures, source = [], "Vexcel footprints"
    from .config import VEXCEL_API_KEY
    feats = []
    if VEXCEL_API_KEY:
        import httpx
        try:
            r = httpx.get(f"{vexcel.API}/property/extract", headers={"X-API-KEY": VEXCEL_API_KEY}, timeout=120, params={
                "wkt": vexcel._square(venue["lat"], venue["lon"], radius_m), "srid": 4326, "layer": vexcel.LAYERS,
                "latest": "true", "include": "precomputed", "unit-system": "imperial"})
            feats = (r.json().get("features") or []) if r.status_code == 200 else []
        except (httpx.HTTPError, ValueError):
            feats = []
    for f in feats:
        for s in (f.get("properties") or {}).get("structures") or []:
            pts = vexcel.wkt_points(s.get("footprint.wkt"))
            if len(pts) < 3:
                continue
            poly = [to(x, y) for x, y in pts]
            structures.append({"poly": poly, "ground_ft": s.get("ground-elevation.value"),
                               "height_ft": s.get("roof-characteristics.maximum-roof-height")})
    if not structures:
        source = "CoStar buildings (footprint estimated as a square from floor area and floor count)"
        for c in costar:
            side = math.sqrt(max(100.0, (c["building_sf"] or 20000) / max(c["floors"], 1)) * 0.0929)
            x, y = c["xy"]
            structures.append({"poly": [(x - side / 2, y - side / 2), (x + side / 2, y - side / 2),
                                        (x + side / 2, y + side / 2), (x - side / 2, y + side / 2)],
                               "ground_ft": None, "height_ft": None, "costar": c})
    # Heights: Vexcel if present, else the CoStar building whose point falls inside (or within 15 m).
    own_ground, own = None, None
    for s in structures:
        s["centroid"] = (sum(p[0] for p in s["poly"]) / len(s["poly"]), sum(p[1] for p in s["poly"]) / len(s["poly"]))
    # Each CoStar building lends its height to one footprint: the one its point falls inside,
    # or failing that the nearest footprint centre within 15 m.
    claimed: dict[int, dict] = {}
    for c in costar:
        inside = [s for s in structures if not s.get("costar") and _inside(s["poly"], *c["xy"])]
        if not inside:
            near = sorted((s for s in structures if not s.get("costar")), key=lambda s: math.dist(c["xy"], s["centroid"]))
            inside = near[:1] if near and math.dist(c["xy"], near[0]["centroid"]) < 15 else []
        if inside:
            claimed[id(max(inside, key=lambda s: _poly_area(s["poly"])))] = c
    for s in structures:
        cx, cy = s["centroid"]
        match = s.get("costar") or claimed.get(id(s))
        if s["height_ft"]:
            s["height_m"], s["height_source"] = s["height_ft"] * 0.3048, "Vexcel"
        elif match:
            s["height_m"], s["height_source"] = match["floors"] * FLOOR_FT_M, f"CoStar, {match['floors']} floors"
        else:
            s["height_m"], s["height_source"] = None, None
        s["name"] = match["name"] if match else None
        s["floors"] = match["floors"] if match else None
        if match and match["id"] == venue["id"]:
            s["own"] = True
        if _inside(s["poly"], 0.0, 0.0):
            s["own"] = True
        if s.get("own") and own is None:
            own, own_ground = s, s.get("ground_ft")
    for s in structures:
        g = s.get("ground_ft")
        s["ground_m"] = ((g - own_ground) * 0.3048) if (g is not None and own_ground is not None) else 0.0
    result = {
        "source": source,
        "own_footprint": own["poly"] if own else None,
        "buildings": [{k: s.get(k) for k in ("poly", "centroid", "height_m", "height_source", "ground_m", "name", "floors")}
                      for s in structures if not s.get("own")],
    }
    path.write_text(json.dumps(result))
    return result


def _poly_area(poly: list[tuple[float, float]]) -> float:
    return abs(sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(poly, poly[1:] + poly[:1]))) / 2


def ray_blocker(origin: tuple[float, float, float], alt: float, az: float, buildings: list[dict]) -> dict | None:
    """First building whose roof line is above the sun ray from `origin` (x east, y north, z up, m)."""
    if alt <= 0:
        return None
    dx, dy = math.sin(az * RAD), math.cos(az * RAD)
    rise = math.tan(alt * RAD)
    best = None
    for b in buildings:
        top = b.get("height_m")
        if top is None:
            continue
        top += b.get("ground_m") or 0.0
        poly = b["poly"]
        for (x1, y1), (x2, y2) in zip(poly, poly[1:] + poly[:1]):
            # ray o + t (dx, dy), t > 0, against segment p1 + u (p2 - p1)
            ex, ey = x2 - x1, y2 - y1
            den = dx * ey - dy * ex
            if abs(den) < 1e-12:
                continue
            ox, oy = x1 - origin[0], y1 - origin[1]
            t = (ox * ey - oy * ex) / den
            u = (ox * dy - oy * dx) / den
            if t > 0.5 and 0 <= u <= 1 and origin[2] + t * rise < top:
                if best is None or t < best[0]:
                    best = (t, b)
    return {"distance_m": best[0], **{k: best[1].get(k) for k in ("name", "floors", "height_m", "centroid")}} if best else None


def facade_point(own: list[tuple[float, float]] | None, facing: float) -> tuple[float, float]:
    """Middle of the footprint edge whose outward normal is closest to `facing`, nudged outside."""
    if not own or len(own) < 3:
        return (math.sin(facing * RAD) * 10, math.cos(facing * RAD) * 10)
    pts = own[:-1] if own[0] == own[-1] else own
    area = sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(pts, pts[1:] + pts[:1]))
    best, best_cos = None, -2.0
    for (x1, y1), (x2, y2) in zip(pts, pts[1:] + pts[:1]):
        ex, ey = x2 - x1, y2 - y1
        ln = math.hypot(ex, ey)
        if ln < 2:
            continue
        nx, ny = (ey / ln, -ex / ln) if area > 0 else (-ey / ln, ex / ln)
        bearing = math.atan2(nx, ny) / RAD
        c = math.cos((bearing - facing) * RAD) + ln / 1e4
        if c > best_cos:
            best_cos, best = c, ((x1 + x2) / 2 + nx * 0.5, (y1 + y2) / 2 + ny * 0.5)
    return best or (0.0, 0.0)


def footprint_axis(own: list[tuple[float, float]] | None) -> float | None:
    """Compass bearing of the footprint's longest edge (0..180)."""
    if not own or len(own) < 3:
        return None
    pts = own[:-1] if own[0] == own[-1] else own
    (x1, y1), (x2, y2) = max(zip(pts, pts[1:] + pts[:1]), key=lambda e: math.dist(*e))
    return (math.atan2(x2 - x1, y2 - y1) / RAD) % 180


def room_floor_height(name: str, building_height_m: float) -> tuple[float, str]:
    t = (name or "").lower()
    if re.search(r"\b(rooftop|roof deck|penthouse|sky ?lounge)\b", t):
        return max(0.0, building_height_m - 4.5), "the top floor (the room's name says rooftop)"
    m = re.search(r"\b(?:floor|level|lvl)\s*(\d+)\b|\b(\d+)(?:st|nd|rd|th)\s+floor\b", t)
    if m:
        n = int(m.group(1) or m.group(2))
        return (n - 1) * FLOOR_FT_M, f"floor {n} (from the room's name)"
    return 0.0, "the ground floor (the scan doesn't say which floor)"


# ----------------------------------------------------------------------------- the day

def fmt_minute(m: int | None) -> str:
    if m is None:
        return ""
    h, mm = divmod(int(m), 60)
    return f"{(h + 11) % 12 + 1}:{mm:02d}{'pm' if h >= 12 else 'am'}"


def compass(bearing: float) -> str:
    return COMPASS[round((bearing % 360) / 45) % 8]


def analyse(venue_id: int, model_id: str, pano_id: str, area_sqft: float | None, height_ft: float | None,
            day: str, rotation: float | None = None, room_name: str = "") -> dict:
    venue = data.venues().get(int(venue_id))
    if not venue:
        return {"error": f"Unknown venue {venue_id}"}
    box = room_box(area_sqft, height_ft)
    key = f"{model_id}_{pano_id}_{round(box['hx'], 2)}_{round(box['hz'], 2)}_{round(box['h'], 2)}"
    wpath = CACHE_DIR / f"daylight_win_{key}.json"
    if wpath.exists():
        windows = json.loads(wpath.read_text())
    else:
        windows = windows_for_pano(model_id, pano_id, box)
        if windows is None:
            return {"error": "The room's photo isn't available right now."}
        wpath.write_text(json.dumps(windows))

    nb = neighbours(venue)
    own = nb.get("own_footprint")
    axis = footprint_axis(own)
    # Default turn: the room's long axis along the footprint's longest wall, and the glassiest
    # wall facing outward on that side. Only the visitor can tell which of the four is right.
    base = axis if axis is not None else 0.0
    rotation_default = base % 360
    if rotation is None:
        rotation = rotation_default
    rotation = float(rotation) % 360

    d = date.fromisoformat(day)
    off = utc_offset(_metro(venue), d)
    midnight = datetime(d.year, d.month, d.day, tzinfo=timezone.utc) - timedelta(hours=off)

    site = _building_height_m(venue)
    floor_m, floor_note = room_floor_height(f"{room_name}", site)

    grid = floor_grid(box)
    cells = window_cells_world(windows, box)
    fac = diffuse_factors(grid, cells)
    win_area = {w["id"]: w["area_m2"] for w in windows}
    total_win = sum(win_area.values())
    a_room = 2 * (4 * box["hx"] * box["hz"]) + 2 * box["h"] * (4 * box["hx"] + 4 * box["hz"])

    # Stage: against the wall with the least glass, centred, about 4 m wide and 2.5 m deep.
    stage_wall = min(WALLS, key=lambda w: (win_area.get(w, 0), w))
    stage = _stage_rect(stage_wall, box)
    in_stage = ((grid["X"] >= stage["x0"]) & (grid["X"] <= stage["x1"]) & (grid["Z"] >= stage["z0"]) & (grid["Z"] <= stage["z1"]))
    pts = np.stack([grid["X"].ravel(), np.full(grid["X"].size, 0.02), grid["Z"].ravel()], -1)

    frames, shading_log = [], {w: [] for w in WALLS}
    blocker_seen: dict[str, dict] = {}
    for minute in range(5 * 60, 21 * 60 + 1, 10):
        alt, az = sun_position(midnight + timedelta(minutes=minute), venue["lat"], venue["lon"])
        shaded, blockers = {}, {}
        for w in WALLS:
            facing = wall_facing(w, rotation)
            on_side = alt > 0 and math.cos((az - facing) * RAD) > 0.05
            blk = None
            if on_side and win_area.get(w, 0) > 0:
                fx, fy = facade_point(own, facing)
                blk = ray_blocker((fx, fy, floor_m + 1.5), alt, az, nb["buildings"])
            shaded[w] = bool(blk)
            if blk:
                blockers[w] = blk
                blocker_seen.setdefault(w, blk)
            shading_log[w].append((minute, on_side, bool(blk), blk))
        s = sun_vector(alt, az, rotation)
        edn, _ = clear_sky(alt)
        direct_floor = edn * TAU * max(s[1], 0)
        lit = sunlit(pts, s, windows, box, shaded).reshape(grid["X"].shape)
        e_direct = np.where(lit, direct_floor, 0.0)
        e_diffuse = np.zeros(grid["X"].shape)
        flux_in = 0.0
        for w in WALLS:
            if not win_area.get(w):
                continue
            ev = vertical_outside(alt, az, wall_facing(w, rotation), shaded[w])
            e_diffuse += TAU * ev * fac[w]
            flux_in += TAU * ev * win_area[w]
        flux_in += float(e_direct.sum()) * grid["cw"] * grid["cd"]
        e_ir = RHO * flux_in / (a_room * (1 - RHO))
        lux = e_direct + e_diffuse + e_ir
        frames.append({
            "minute": minute, "alt": round(alt, 1), "az": round(az, 1),
            "stage_lux": round(float(lux[in_stage].mean()) if in_stage.any() else 0.0),
            "mean_lux": round(float(lux.mean())),
            "sun_on_stage": round(float(lit[in_stage].mean()) if in_stage.any() else 0.0, 2),
            "shaded": [w for w in WALLS if shaded[w]],
            # One byte per cell, log scale: lux = 10^(b / 40) - 1 (about 6% steps), base64.
            "lux": encode_lux(lux) if alt > -1 else "",
        })

    verdicts = _verdicts(frames, total_win)
    shade_notes = _shade_notes(shading_log, rotation, win_area)
    unknown = sum(1 for b in nb["buildings"] if b.get("height_m") is None)
    known, named = [], set()
    for b in sorted([b for b in nb["buildings"] if b.get("height_m")], key=lambda b: math.hypot(*b["centroid"])):
        if b.get("name") in named:
            continue
        named.add(b.get("name"))
        known.append(b)
    return {
        "room": {"w": 2 * box["hx"], "d": 2 * box["hz"], "h": box["h"], "floor_m": floor_m},
        "rotation": rotation, "rotation_default": rotation_default,
        "walls": [{"id": w, "facing": round(wall_facing(w, rotation)), "compass": compass(wall_facing(w, rotation)),
                   "window_m2": win_area.get(w, 0)} for w in WALLS],
        "windows": {"cell_m": CELL, "walls": windows},
        "grid": {"nx": grid["nx"], "nz": grid["nz"], "x0": -box["hx"], "z0": -box["hz"], "cw": grid["cw"], "cd": grid["cd"]},
        "stage": {**stage, "wall": stage_wall},
        "frames": frames,
        "verdicts": verdicts,
        "shade": shade_notes,
        "neighbours": {
            "source": nb["source"],
            "with_height": [{"name": b.get("name"), "floors": b.get("floors"), "height_m": round(b["height_m"], 1),
                             "distance_m": round(math.hypot(*b["centroid"])),
                             "compass": compass(math.atan2(*b["centroid"]) / RAD)} for b in known[:8]],
            "unknown_height": unknown,
            "buildings": [{"poly": [[round(x, 1), round(y, 1)] for x, y in b["poly"]], "height_m": b.get("height_m"),
                           "ground_m": round(b.get("ground_m") or 0, 1), "name": b.get("name")}
                          for b in nb["buildings"] if b.get("height_m") and math.hypot(*b["centroid"]) < 260],
        },
        "assumptions": [
            "Windows are found in the 360 photo: bright, nearly colourless wall areas. A sunlit white wall can look like glass.",
            "The scan doesn't record north. We lined the room up with the building's longest wall; turn it if the windows face the wrong way.",
            f"The room is on {floor_note}.",
            "Clear sky. Glass lets 70% through. Room surfaces reflect 45% on average.",
            f"Neighbour heights from {('Vexcel' if any((b.get('height_source') or '').startswith('Vexcel') for b in nb['buildings']) else 'CoStar floor counts, 12 ft a floor')}. "
            f"{unknown} nearby footprints have no height on record and are left out." if unknown else
            "Neighbour heights from CoStar floor counts, 12 ft a floor.",
        ],
    }


def encode_lux(lux: np.ndarray) -> str:
    import base64
    b = np.clip(np.round(40 * np.log10(1 + np.maximum(lux, 0))), 0, 255).astype(np.uint8)
    return base64.b64encode(b.ravel().tobytes()).decode()


def decode_lux(s: str) -> np.ndarray:
    import base64
    return 10 ** (np.frombuffer(base64.b64decode(s), dtype=np.uint8) / 40) - 1


def _metro(venue: dict) -> str:
    from .data import metro_of
    try:
        return metro_of(venue)
    except Exception:
        return "Houston" if (venue.get("city") or "").lower().startswith("houston") else "Los Angeles"


def _building_height_m(venue: dict) -> float:
    attrs = vexcel.property_attributes(venue["id"], venue["lat"], venue["lon"]) or {}
    ft = attrs.get("max_roof_height_ft") or ((venue.get("stories") or 1) * 12)
    return ft * 0.3048


def _stage_rect(wall: str, box: dict) -> dict:
    hx, hz = box["hx"], box["hz"]
    if wall in ("+z", "-z"):
        half_w, depth = min(2.0, hx * 0.6), min(2.5, hz * 0.6)
        z_edge = hz if wall == "+z" else -hz
        z0, z1 = sorted((z_edge, z_edge - math.copysign(depth, z_edge)))
        return {"x0": -half_w, "x1": half_w, "z0": z0, "z1": z1}
    half_w, depth = min(2.0, hz * 0.6), min(2.5, hx * 0.6)
    x_edge = hx if wall == "+x" else -hx
    x0, x1 = sorted((x_edge, x_edge - math.copysign(depth, x_edge)))
    return {"x0": x0, "x1": x1, "z0": -half_w, "z1": half_w}


def _runs(flags: list[tuple[int, bool]]) -> list[tuple[int, int]]:
    out, start = [], None
    for m, f in flags:
        if f and start is None:
            start = m
        if not f and start is not None:
            out.append((start, m))
            start = None
    if start is not None:
        out.append((start, flags[-1][0]))
    return out


def _verdicts(frames: list[dict], total_win: float) -> list[str]:
    if total_win <= 0:
        return ["We couldn't find windows in this photo, so the room gets little or no daylight. Plan on its own lights."]
    out = []
    bright = _runs([(f["minute"], f["stage_lux"] >= READ_LUX) for f in frames])
    if bright:
        a, b = max(bright, key=lambda r: r[1] - r[0])
        out.append(f"Bright enough to read sheet music ({READ_LUX} lux) on the stage from {fmt_minute(a)} until {fmt_minute(b)}.")
    else:
        peak = max(frames, key=lambda f: f["stage_lux"])
        out.append(f"Daylight never reaches {READ_LUX} lux on the stage (at best about {peak['stage_lux']} lux at "
                   f"{fmt_minute(peak['minute'])}). Bring stand lights for the music.")
    sun = _runs([(f["minute"], f["sun_on_stage"] >= 0.1) for f in frames])
    if sun:
        a, b = sun[0]
        out.append(f"Sunlight reaches the stage at {fmt_minute(a)} and leaves it around {fmt_minute(b)}. "
                   "Singers facing the windows will squint; turn the risers.")
    else:
        out.append("Direct sun never lands on the stage on this date.")
    return out


def _shade_notes(log: dict, rotation: float, win_area: dict) -> list[str]:
    notes = []
    for w, rows in log.items():
        if not win_area.get(w):
            continue
        side = compass(wall_facing(w, rotation))
        sunny = [r for r in rows if r[1]]
        if not sunny:
            continue
        first_shade = None
        for (m0, on0, sh0, _), (m1, on1, sh1, blk) in zip(rows, rows[1:]):
            if on0 and on1 and not sh0 and sh1:
                first_shade = (m1, blk)
                break
        start_shaded = sunny[0][2]
        if first_shade:
            m, blk = first_shade
            notes.append(f"The {side} windows go into shadow at {fmt_minute(m)} behind {_describe(blk)}.")
        elif start_shaded and all(r[2] for r in sunny):
            notes.append(f"The {side} windows stay in the shadow of {_describe(sunny[0][3])} whenever the sun is on that side.")
        elif start_shaded:
            m = next(r[0] for r in sunny if not r[2])
            notes.append(f"The {side} windows are in the shadow of {_describe(sunny[0][3])} until {fmt_minute(m)}.")
        else:
            notes.append(f"Nothing nearby blocks the sun on the {side} windows.")
    return notes


# ----------------------------------------------------------------------------- routes

from fastapi import APIRouter, HTTPException  # noqa: E402

router = APIRouter(prefix="/api/daylight")


@router.get("")
def daylight(venue_id: int, model_id: str, pano_id: str, date: str, area_sqft: float | None = None,
             height_ft: float | None = None, rotation: float | None = None, room: str = "") -> dict:
    """Window map, floor light levels through the day, and shading by neighbours for one room."""
    try:
        out = analyse(venue_id, model_id, pano_id, area_sqft, height_ft, date, rotation, room)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    if out.get("error"):
        raise HTTPException(404, out["error"])
    return out


@router.get("/windows")
def windows(model_id: str, pano_id: str, area_sqft: float | None = None, height_ft: float | None = None) -> dict:
    """Just the windows found in a room's 360 photo (for the lighting lab's daylight warning)."""
    box = room_box(area_sqft, height_ft)
    key = f"{model_id}_{pano_id}_{round(box['hx'], 2)}_{round(box['hz'], 2)}_{round(box['h'], 2)}"
    wpath = CACHE_DIR / f"daylight_win_{key}.json"
    if wpath.exists():
        found = json.loads(wpath.read_text())
    else:
        found = windows_for_pano(model_id, pano_id, box)
        if found is None:
            raise HTTPException(404, "The room's photo isn't available right now.")
        wpath.write_text(json.dumps(found))
    return {"window_m2": round(sum(w["area_m2"] for w in found), 1), "walls": found, "cell_m": CELL}


def _describe(blk: dict | None) -> str:
    if not blk:
        return "a neighbouring building"
    where = compass(math.atan2(*blk["centroid"]) / RAD) if blk.get("centroid") else ""
    dist = f"{round(math.hypot(*blk['centroid']))} m {where}" if blk.get("centroid") else ""
    if blk.get("name") and blk.get("floors"):
        return f"{blk['name']} ({blk['floors']} floors, {dist})"
    return f"a {round(blk['height_m'])} m building {dist}"
