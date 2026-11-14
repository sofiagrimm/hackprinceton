"""Film mode: location scouting for film crews on the same CoStar, Matterport and Vexcel data.

A film crew wants different things from a room than a choir does. Dialogue needs a dead room
(RT60 of 0.3 to 0.6 s), the set needs floor space and a high ceiling for lights, the building
should be one the production can lock down, and the street outside should be quiet. Outside,
the crew needs a base camp: somewhere paved to park the trucks, trailers and crew cars.

Everything here is deterministic. Numbers that come straight from a source (a Vexcel
measurement, a CoStar record, a Matterport scan) are labelled "measured"; anything we
derived from them is labelled "estimated".
"""

from __future__ import annotations

import json
import math
import re
from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from . import data, matterport, vexcel
from .acoustics import USES, RoomGeometry, classify_space, estimate
from .config import CACHE_DIR

router = APIRouter(prefix="/api/film", tags=["film"])

FILM_USE = "film_dialogue"
FT2_PER_M2 = 10.7639

# --------------------------------------------------------------------------- rooms

# Rooms a crew could actually shoot in. Bathrooms, bedrooms and corridors are out
# (a big "hallway" in an office scan is usually the open floor, handled below).
SHOOTABLE = {"theater", "ballroom", "lobby", "chapel", "clubhouse", "fitness", "warehouse",
             "unfinished", "office", "generic", "residential_living"}
INTERIOR_EXCLUDE = {"rooftop"}

# How easy it is to take over the building for weeks. Industrial and flex space is closest to a
# stage; offices and vacant suites can be locked off; apartment amenity rooms have residents.
BUILDING_CONTROL = {"Industrial": 1.0, "Flex": 1.0, "Specialty": 0.85, "Office": 0.8,
                    "GeneralRetail": 0.75, "Hospitality": 0.6, "Healthcare": 0.5,
                    "Multifamily": 0.45, "Land": 0.3}
UNIT_NAME = re.compile(r"\b(studio|\d\s*br|\d\s*bd|bedroom|\d\s*bed|king|queen|unit \d|apt|"
                       r"penthouse|townhome|floor ?plan|\d{3,4}\s*sf\b)", re.I)


def _film_kind(name: str | None, tags: list[str], area: float, property_type: str) -> str:
    kind = classify_space(name, tags, property_type)
    if kind in ("hallway", "bedroom") and area >= 1000:
        # The largest "room" in an office suite scan is usually the open floor.
        kind = "unfinished" if "unfurnished" in tags else (
            "office" if property_type in ("Office", "Healthcare") else "generic")
    return kind


def _rooms_for_venue(venue: dict, crew: int, min_area: float) -> list[dict]:
    rooms_out = []
    for model_id in venue["matterport_models"]:
        model = matterport.get_model(model_id, allow_fetch=False)
        if not model:
            continue
        rooms = [matterport.to_feet(r) for r in model.get("rooms") or []]
        rooms = [r for r in rooms if r.get("area") and r["area"] >= min_area]
        if not rooms:
            continue
        room = max(rooms, key=lambda r: r["area"])
        name = model.get("name") or "Scanned space"
        tags = room.get("tags") or []
        kind = _film_kind(name, tags, room["area"], venue["property_type"])
        if kind not in SHOOTABLE or kind in INTERIOR_EXCLUDE:
            continue
        if venue["property_type"] == "Multifamily" and UNIT_NAME.search(name):
            continue  # someone's apartment, not a location you can hold for weeks
        height = room.get("height") if room.get("height") and room["height"] >= 6 else None
        height_source = "measured"
        if not height and venue.get("ceiling_ft"):
            height, height_source = venue["ceiling_ft"], "costar"
        est = estimate(RoomGeometry(room["area"], height, room.get("width"), room.get("depth")),
                       kind, use=FILM_USE, audience=crew)
        rooms_out.append({
            "model_id": model_id,
            "space_name": name,
            "space_type": kind,
            "area_sqft": round(room["area"]),
            "height_ft": round(est.assumptions["height_ft"], 1),
            "height_source": height_source if height else "assumed",
            "acoustics": est.to_dict(),
        })
    return rooms_out


def _size_score(area: float, crew: int) -> float:
    """1.0 once the room holds the set plus the crew working around it."""
    need = max(1500.0, crew * 60.0)
    return min(1.0, math.sqrt(area / need))


def _ceiling_score(height: float) -> float:
    """Lights need headroom: 8 ft is cramped, 14 ft and up is a grid."""
    return max(0.0, min(1.0, (height - 8) / 6))


def _room_fit(room: dict, venue: dict, crew: int, noise: dict) -> dict:
    parts = {
        "dialogue": room["acoustics"]["score"] / 100,
        "size": _size_score(room["area_sqft"], crew),
        "ceiling": _ceiling_score(room["height_ft"]),
        "control": BUILDING_CONTROL.get(venue["property_type"], 0.5),
        "quiet": (5 - noise["score"]) / 4,
    }
    weights = {"dialogue": 0.35, "size": 0.25, "ceiling": 0.15, "control": 0.15, "quiet": 0.10}
    score = sum(parts[k] * w for k, w in weights.items()) * 100
    if venue["listings"]:
        score += 3  # vacant space someone is marketing: easier to hold for weeks
    return {"score": round(min(score, 100)), "parts": {k: round(v, 2) for k, v in parts.items()}}


# --------------------------------------------------------------------------- outside noise

# Rough centrelines, (lat, lon). Good to a few hundred metres, which is enough for a 1-5 score.
FREEWAYS = {
    "Los Angeles": {
        "I-405": [(33.774, -118.104), (33.83, -118.26), (33.93, -118.37), (34.00, -118.39), (34.06, -118.44),
                  (34.155, -118.47), (34.21, -118.47), (34.32, -118.49)],
        "I-10": [(34.02, -118.49), (34.03, -118.40), (34.04, -118.33), (34.03, -118.27), (34.06, -118.20),
                 (34.07, -118.10), (34.07, -117.95)],
        "I-110": [(33.73, -118.28), (33.87, -118.28), (33.98, -118.28), (34.05, -118.26), (34.09, -118.21),
                  (34.11, -118.18)],
        "US-101": [(34.04, -118.18), (34.05, -118.22), (34.06, -118.24), (34.09, -118.30), (34.10, -118.33),
                   (34.13, -118.35), (34.14, -118.38), (34.155, -118.45), (34.16, -118.50), (34.17, -118.60)],
        "I-5": [(33.95, -118.09), (34.00, -118.16), (34.04, -118.21), (34.08, -118.22), (34.13, -118.26),
                (34.18, -118.31), (34.32, -118.49)],
        "I-105": [(33.93, -118.38), (33.93, -118.28), (33.92, -118.10)],
        "I-710": [(33.77, -118.20), (33.90, -118.18), (34.02, -118.16), (34.06, -118.17)],
        "SR-134": [(34.155, -118.37), (34.155, -118.28), (34.14, -118.20), (34.14, -118.15)],
        "I-605": [(33.80, -118.08), (34.07, -117.98)],
        "SR-60": [(34.04, -118.21), (34.03, -118.10), (34.02, -117.95)],
        "I-210": [(34.27, -118.43), (34.20, -118.20), (34.15, -118.13), (34.14, -117.95)],
    },
    "Houston": {
        "I-610": [(29.81, -95.45), (29.81, -95.40), (29.81, -95.30), (29.78, -95.27), (29.72, -95.27),
                  (29.69, -95.30), (29.68, -95.38), (29.69, -95.43), (29.72, -95.455), (29.76, -95.455),
                  (29.81, -95.45)],
        "I-10": [(29.78, -95.80), (29.78, -95.55), (29.785, -95.45), (29.77, -95.37), (29.77, -95.30),
                 (29.78, -95.10)],
        "I-45": [(29.55, -95.13), (29.62, -95.22), (29.70, -95.30), (29.75, -95.36), (29.80, -95.38),
                 (29.90, -95.41), (30.00, -95.42)],
        "I-69/US-59": [(29.62, -95.60), (29.70, -95.50), (29.73, -95.43), (29.74, -95.38), (29.76, -95.36),
                       (29.80, -95.33), (29.90, -95.30), (30.00, -95.27)],
        "US-290": [(29.80, -95.45), (29.85, -95.52), (29.92, -95.60), (29.96, -95.68)],
        "Beltway 8": [(29.94, -95.56), (29.94, -95.40), (29.95, -95.30), (29.89, -95.20), (29.75, -95.17),
                      (29.63, -95.20), (29.60, -95.30), (29.60, -95.45), (29.65, -95.56), (29.78, -95.56),
                      (29.94, -95.56)],
        "SH-288": [(29.73, -95.38), (29.65, -95.39), (29.55, -95.39)],
    },
}
# Busy surface streets. A building that fronts one hears it all day.
MAJOR_ROADS = {
    "Los Angeles": ["wilshire", "sunset", "santa monica blvd", "hollywood blvd", "olympic", "pico", "venice blvd",
                    "washington blvd", "jefferson", "figueroa", "vermont", "western", "la brea", "la cienega",
                    "fairfax", "highland", "crenshaw", "sepulveda", "ventura blvd", "lankershim", "van nuys blvd",
                    "victory", "beverly blvd", "melrose", "alameda", "slauson", "manchester", "century blvd",
                    "lincoln blvd", "glendale blvd", "cesar chavez", "broadway", "main st", "spring st",
                    "san fernando rd", "riverside dr", "colorado blvd", "atlantic", "soto", "national blvd"],
    "Houston": ["westheimer", "richmond", "main st", "kirby", "shepherd", "washington ave", "memorial dr",
                "montrose", "san felipe", "post oak", "bellaire", "gessner", "fannin", "louisiana", "smith st",
                "travis", "milam", "gray st", "allen pkwy", "north fwy", "katy fwy", "gulf fwy", "southwest fwy",
                "beltway", "fm 1960", "fondren", "hillcroft", "chimney rock", "voss", "bissonnet", "holcombe",
                "old spanish trl", "telephone rd", "airline dr", "s post oak"],
}

AIRPORTS = {
    "LAX": (33.9416, -118.4085), "BUR": (34.2007, -118.3587),
    "IAH": (29.9902, -95.3368), "HOU": (29.6454, -95.2789),
}
RAIL = {
    "Los Angeles": {
        "Alameda Corridor": [(33.77, -118.22), (34.02, -118.23)],
        "Metrolink / LA River line": [(34.056, -118.235), (34.10, -118.25), (34.14, -118.26), (34.19, -118.32),
                                      (34.21, -118.45), (34.25, -118.60)],
        "Metro E Line": [(34.03, -118.27), (34.03, -118.37), (34.01, -118.49)],
        "Metro A Line": [(34.05, -118.24), (33.97, -118.24), (33.85, -118.22), (33.77, -118.19)],
        "UP Alhambra line": [(34.05, -118.22), (34.06, -118.10), (34.06, -117.90)],
    },
    "Houston": {
        "UP west line": [(29.77, -95.37), (29.78, -95.46), (29.82, -95.55)],
        "UP east line": [(29.77, -95.37), (29.81, -95.30), (29.85, -95.25)],
        "Galveston line": [(29.75, -95.36), (29.70, -95.30), (29.64, -95.22)],
        "METRORail Red Line": [(29.79, -95.37), (29.76, -95.365), (29.71, -95.40), (29.67, -95.41)],
    },
}


def _dist_to_line_m(lat: float, lon: float, line: list[tuple[float, float]]) -> float:
    """Shortest distance from a point to a polyline, on a local flat projection."""
    kx = 111_320 * math.cos(math.radians(lat))
    ky = 110_540
    px, py = 0.0, 0.0
    best = float("inf")
    pts = [((lo - lon) * kx, (la - lat) * ky) for la, lo in line]
    for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
        dx, dy = x2 - x1, y2 - y1
        seg = dx * dx + dy * dy
        t = 0.0 if not seg else max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / seg))
        best = min(best, math.hypot(x1 + t * dx - px, y1 + t * dy - py))
    return best


def _nearest(lat: float, lon: float, lines: dict) -> tuple[str, float]:
    return min(((name, _dist_to_line_m(lat, lon, pts)) for name, pts in lines.items()), key=lambda t: t[1])


def _major_road(address: str, metro: str) -> str | None:
    street = (address or "").split(",")[0].lower()
    street = re.sub(r"\bboulevard\b", "blvd", re.sub(r"\bstreet\b", "st", re.sub(r"\bavenue\b", "ave", street)))
    for road in MAJOR_ROADS.get(metro, []):
        if re.search(r"\b" + re.escape(road) + r"\b", street):
            name = re.sub(r"^\s*[\d-]+\s*", "", (address or "").split(",")[0]).strip() or road
            return " ".join(w[:1].upper() + w[1:] for w in name.split())
    return None


def noise_exposure(lat: float, lon: float, metro: str, address: str = "") -> dict:
    """Distance to the nearest freeway, airport and rail line, frontage on a busy street,
    and a 1 (quiet) to 5 (loud) score."""
    fwy, fwy_m = _nearest(lat, lon, FREEWAYS.get(metro, {}))
    rail, rail_m = _nearest(lat, lon, RAIL.get(metro, {}))
    apt, apt_m = min(((code, data.miles_between(lat, lon, *pt) * 1609.34) for code, pt in AIRPORTS.items()),
                     key=lambda t: t[1])
    points = 0
    points += 3 if fwy_m < 200 else 2 if fwy_m < 500 else 1 if fwy_m < 1200 else 0
    points += 3 if apt_m < 3000 else 2 if apt_m < 6000 else 1 if apt_m < 12000 else 0
    points += 2 if rail_m < 150 else 1 if rail_m < 500 else 0
    road = _major_road(address, metro)
    points += 2 if road else 0
    score = 1 if points == 0 else 2 if points == 1 else 3 if points == 2 else 4 if points <= 4 else 5

    loud = []
    if road:
        loud.append(f"the building fronts {road}, a busy street")
    if fwy_m < 1200:
        loud.append(f"{fwy} is {_fmt_dist(fwy_m)} away")
    if apt_m < 12000:
        loud.append(f"{apt} is {_fmt_dist(apt_m)} away, so expect planes")
    if rail_m < 500:
        loud.append(f"the {rail} runs {_fmt_dist(rail_m)} away")
    if not loud:
        summary = "No freeway, airport or rail line close by. Exteriors should be easy to record."
    else:
        summary = " ".join(_sentence(x) + "." for x in loud)
    return {
        "score": score,
        "label": ["", "Very quiet", "Quiet", "Some traffic", "Busy", "Loud"][score],
        "summary": summary,
        "nearest_freeway": {"name": fwy, "distance_m": round(fwy_m)},
        "nearest_airport": {"code": apt, "distance_m": round(apt_m)},
        "nearest_rail": {"name": rail, "distance_m": round(rail_m)},
        "busy_street": road,
        "source": "estimated from the street address and a hand-drawn list of freeway, rail and airport locations",
    }


def _fmt_dist(m: float) -> str:
    return f"{m:,.0f} m" if m < 1000 else f"{m / 1000:.1f} km"


def _sentence(s: str) -> str:
    return s[:1].upper() + s[1:]


# --------------------------------------------------------------------------- base camp

TRAILER_W_M, TRAILER_L_M = 3.5, 15.0
# Each trailer also needs 1 m between neighbours and half of a 7 m two-way aisle in front.
TRAILER_STALL_M2 = (TRAILER_W_M + 1.0) * (TRAILER_L_M + 3.5)
USABLE_SHARE = 0.6        # islands, ramps, fire lanes and odd corners
CAR_STALL_M2 = 28.0       # a parking space plus its share of the aisle (about 300 sq ft)
RING_M = 40               # how far around the parcel we look for street and neighbouring pavement


def _polygon_area_m2(points: list[tuple[float, float]]) -> float:
    if len(points) < 3:
        return 0.0
    lat0 = sum(p[1] for p in points) / len(points)
    kx, ky = 111_320 * math.cos(math.radians(lat0)), 110_540
    xy = [(x * kx, y * ky) for x, y in points]
    return abs(sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(xy, xy[1:] + xy[:1]))) / 2


def _parcel_details(venue: dict) -> dict:
    """Parcel polygon, every structure footprint and a few parcel fields from Vexcel, cached."""
    path = CACHE_DIR / f"film_parcel_{venue['id']}.json"
    if path.exists():
        return json.loads(path.read_text())
    from .config import VEXCEL_API_KEY
    if not VEXCEL_API_KEY:
        return {}
    import httpx
    try:
        r = httpx.get(f"{vexcel.API}/property/extract", headers={"X-API-KEY": VEXCEL_API_KEY}, timeout=60, params={
            "wkt": f"POINT({venue['lon']} {venue['lat']})", "srid": 4326, "layer": vexcel.LAYERS,
            "latest": "true", "include": "precomputed", "unit-system": "imperial"})
        feats = (r.json().get("features") or []) if r.status_code == 200 else []
    except (httpx.HTTPError, ValueError):
        return {}
    if not feats:
        result = {}
    else:
        props = feats[0].get("properties") or {}
        result = {
            "parcel": vexcel.wkt_points(vexcel._geometry_to_wkt(feats[0].get("geometry"))),
            "footprints": [vexcel.wkt_points(s.get("footprint.wkt")) for s in props.get("structures") or []
                           if s.get("footprint.wkt")],
            "tree_cover_percent": props.get("parcel-tree-cover.percent"),
            "hardscape_sqft": props.get("hardscapes.area"),
            "vehicles": props.get("vehicles.count"),
            "capture_date": props.get("metadata.ortho-date-estimate"),
        }
    path.write_text(json.dumps(result))
    return result


def _site_ortho(venue: dict, parcel: list) -> tuple[bytes, dict] | None:
    """A clean ortho (no outline drawn) of the parcel plus a ring around it, and its exact bounds."""
    img_path = CACHE_DIR / f"film_ortho_{venue['id']}.jpg"
    if img_path.exists():
        raw = img_path.read_bytes()
    else:
        from .config import VEXCEL_API_KEY
        if not VEXCEL_API_KEY or len(parcel) < 3:
            return None
        import httpx
        wkt = "POLYGON((" + ",".join(f"{x} {y}" for x, y in parcel) + "))"
        try:
            r = httpx.post(f"{vexcel.API}/ortho/extract", headers={"X-API-KEY": VEXCEL_API_KEY}, timeout=120, json={
                "wkt": wkt, "srid": 4326, "layer": vexcel.LAYERS, "buffer-meter": RING_M,
                "crop": "bounding_box", "image-format": "jpeg"})
        except httpx.HTTPError:
            return None
        if r.status_code != 200 or not r.content:
            return None
        raw = r.content
        img_path.write_bytes(raw)
    # Vexcel writes the image's footprint into its XMP metadata.
    m = re.search(rb"<Vexcel:geometry>POLYGON \(\(([^)]+)\)\)</Vexcel:geometry>", raw)
    if not m:
        return None
    pts = [tuple(map(float, p.split())) for p in m.group(1).decode().split(",")]
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return raw, {"west": min(xs), "east": max(xs), "south": min(ys), "north": max(ys)}


def _paved_masks(raw: bytes, bounds: dict, parcel: list, footprints: list) -> dict | None:
    """Classify the ortho: paved or bare ground vs vegetation, inside the parcel and in the ring around it."""
    try:
        import io

        import numpy as np
        from PIL import Image, ImageDraw
    except ImportError:
        return None
    img = Image.open(io.BytesIO(raw)).convert("RGB")
    scale = min(1.0, 900 / max(img.size))
    img = img.resize((max(1, int(img.width * scale)), max(1, int(img.height * scale))))
    W, H = img.size

    def px(points):
        return [((x - bounds["west"]) / (bounds["east"] - bounds["west"]) * W,
                 (bounds["north"] - y) / (bounds["north"] - bounds["south"]) * H) for x, y in points]

    def mask(polys):
        m = Image.new("L", (W, H), 0)
        d = ImageDraw.Draw(m)
        for poly in polys:
            if len(poly) >= 3:
                d.polygon(px(poly), fill=255)
        return np.array(m) > 0

    parcel_m = mask([parcel])
    built = mask(footprints)
    a = np.asarray(img).astype(np.int16)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    green = (g > r + 6) & (g > b - 4)          # lawn and tree canopy
    water = (b > r + 25) & (b > g + 5)          # pools
    paved = ~green & ~water & ~built & parcel_m

    # Ground size of one pixel from the image's own bounds.
    mid = (bounds["north"] + bounds["south"]) / 2
    px_w = (bounds["east"] - bounds["west"]) * 111_320 * math.cos(math.radians(mid)) / W
    px_h = (bounds["north"] - bounds["south"]) * 110_540 / H
    px_m2 = px_w * px_h
    # A trailer needs a strip at least ~4.5 m wide: open the mask with a square that size, which drops
    # sidewalks, planter gaps and slivers along the walls.
    from PIL import ImageFilter
    k = max(3, int(round(TRAILER_W_M + 1.0) / max(px_w, px_h)) | 1)
    pm = Image.fromarray((paved * 255).astype(np.uint8))
    wide = np.array(pm.filter(ImageFilter.MinFilter(k)).filter(ImageFilter.MaxFilter(k))) > 0
    return {
        "paved_m2": float(paved.sum() * px_m2),
        "wide_paved_m2": float(wide.sum() * px_m2),
        "image": img, "parcel_mask": parcel_m, "paved_mask": wide,
    }


def base_camp(venue: dict, crew: int = 25) -> dict:
    """How many trucks and trailers fit on the paved parts of the parcel, from Vexcel and CoStar."""
    det = _parcel_details(venue)
    parcel, footprints = det.get("parcel") or [], det.get("footprints") or []
    measured, estimated = {}, {}

    parcel_m2 = _polygon_area_m2(parcel)
    built_m2 = sum(_polygon_area_m2(f) for f in footprints)
    if parcel_m2:
        measured["parcel_sqft"] = round(parcel_m2 * FT2_PER_M2)
    if built_m2:
        measured["building_footprint_sqft"] = round(built_m2 * FT2_PER_M2)
    elif venue.get("building_sf"):
        # No footprint from the air: CoStar's floor area spread over its stories.
        built_m2 = venue["building_sf"] / max(venue.get("stories") or 1, 1) / FT2_PER_M2
        estimated["building_footprint_sqft"] = round(built_m2 * FT2_PER_M2)
    if parcel_m2:
        (measured if footprints else estimated)["unbuilt_sqft"] = round(max(0.0, parcel_m2 - built_m2) * FT2_PER_M2)
    if det.get("tree_cover_percent") is not None:
        measured["tree_cover_percent"] = det["tree_cover_percent"]
    if det.get("vehicles") is not None:
        measured["vehicles_at_capture"] = det["vehicles"]
    if venue.get("parking_spaces"):
        measured["costar_parking_spaces"] = venue["parking_spaces"]

    site = _site_ortho(venue, parcel) if parcel else None
    masks = _paved_masks(*site, parcel, footprints) if site else None
    unbuilt_m2 = max(0.0, parcel_m2 - built_m2)
    if masks:
        estimated["paved_sqft"] = round(min(masks["paved_m2"], unbuilt_m2) * FT2_PER_M2)
        paved_m2 = min(masks["wide_paved_m2"], unbuilt_m2)
        estimated["truck_width_paved_sqft"] = round(paved_m2 * FT2_PER_M2)
        estimated["paved_basis"] = ("pixels in the Vexcel ortho that are not roof, lawn, tree or water, "
                                    "keeping only strips wide enough for a trailer")
    else:
        tree = (det.get("tree_cover_percent") or 0) / 100
        paved_m2 = max(0.0, parcel_m2 - built_m2 - parcel_m2 * tree)
        estimated["paved_sqft"] = round(paved_m2 * FT2_PER_M2)
        estimated["paved_basis"] = "unbuilt parcel minus Vexcel tree cover"

    trailers = int(paved_m2 * USABLE_SHARE // TRAILER_STALL_M2)
    need_trailers = 3 + math.ceil(crew / 15)   # grip and electric, camera, hair and make-up, honeywagon...
    need_cars = math.ceil(crew / 1.5)
    left_m2 = max(0.0, paved_m2 * USABLE_SHARE - min(trailers, need_trailers) * TRAILER_STALL_M2)
    surface_cars = int(left_m2 // CAR_STALL_M2)
    garage_cars = max(0, (venue.get("parking_spaces") or 0) - int(paved_m2 // CAR_STALL_M2))
    cars = surface_cars + garage_cars
    working_lot = (det.get("vehicles") or 0) > 0
    estimated.update({
        "trailers_fit": trailers,
        "trailers_needed": need_trailers,
        "crew_cars_fit": cars,
        "crew_cars_fit_in_garage": garage_cars,
        "crew_cars_needed": need_cars,
        "lot_in_use_at_capture": working_lot,
    })

    if trailers >= need_trailers and cars >= need_cars:
        verdict = (f"{'Base camp fits on site' if working_lot else 'On paper base camp fits on site'}. About {trailers} trailers fit on the lot and you need "
                   f"{need_trailers}, with parking for the crew's {need_cars} cars.")
    elif trailers >= need_trailers:
        verdict = (f"The trucks fit on site ({trailers} trailer spots for {need_trailers} trailers), "
                   "but crew cars will need a shuttle lot.")
    elif trailers:
        verdict = (f"About {trailers} trailer spots on site and you need {need_trailers}. "
                   "Keep the work trucks here and put base camp somewhere close.")
    else:
        verdict = "No room for trailers on the lot. Plan on street permits or a base camp lot nearby."
    if garage_cars >= need_cars and trailers < need_trailers:
        verdict += " The garage can take the crew's cars."
    if trailers and not working_lot:
        verdict += (" No cars were parked on this paving in the aerial photo, so it may be a plaza or courtyard."
                    " Check that a truck can get onto it.")
    elif trailers:
        verdict += f" Vexcel counted {det['vehicles']} cars parked on it from the air, so it is a working lot."

    overflow = []
    for other in data.venues().values():
        if other["id"] == venue["id"] or (other.get("parking_spaces") or 0) < 150:
            continue
        d = data.miles_between(venue["lat"], venue["lon"], other["lat"], other["lon"])
        if d <= 0.6:
            overflow.append({"venue_id": other["id"], "name": other["name"], "address": other["address"],
                             "distance_miles": round(d, 2), "parking_spaces": other["parking_spaces"]})
    overflow.sort(key=lambda o: o["distance_miles"])

    return {
        "measured": measured,
        "estimated": estimated,
        "verdict": verdict,
        "overflow_lots": overflow[:3],
        "map_url": f"/api/film/{venue['id']}/basecamp.jpg" if masks else None,
        "assumptions": (f"Each trailer is {TRAILER_W_M} m by {TRAILER_L_M:.0f} m. With a metre between trailers and "
                        f"half of a 7 m aisle that is {TRAILER_STALL_M2:.0f} m² per trailer. We count "
                        f"{USABLE_SHARE:.0%} of the paved area as usable, and assume trailers can't go in a garage."),
        "capture_date": det.get("capture_date"),
        "vexcel_available": bool(parcel),
    }


def base_camp_map(venue: dict) -> bytes | None:
    """The ortho with everything outside the parcel dimmed and the paved ground left bright."""
    det = _parcel_details(venue)
    parcel = det.get("parcel") or []
    site = _site_ortho(venue, parcel) if parcel else None
    masks = _paved_masks(*site, parcel, det.get("footprints") or []) if site else None
    if not masks:
        return None
    import io

    import numpy as np
    from PIL import Image
    a = np.asarray(masks["image"]).astype(np.float32)
    keep = masks["parcel_mask"] & masks["paved_mask"]
    a[~keep] *= 0.35
    out = io.BytesIO()
    Image.fromarray(a.clip(0, 255).astype(np.uint8)).save(out, "JPEG", quality=85)
    return out.getvalue()


# --------------------------------------------------------------------------- oblique imagery

DIRECTIONS = {"n": "north", "e": "east", "s": "south", "w": "west"}


def oblique_image(venue: dict, direction: str) -> bytes | None:
    """One directional oblique photo of the building, cached under data/cache/."""
    direction = DIRECTIONS.get(direction.lower()[:1], "north")
    path = CACHE_DIR / f"film_oblique_{venue['id']}_{direction}.jpg"
    if path.exists():
        return path.read_bytes()
    image = _fetch_oblique(venue, direction)
    if image:
        path.write_bytes(image)
    return image


def _fetch_oblique(venue: dict, direction: str) -> bytes | None:
    # TODO: the Vexcel oblique endpoint is documented in docs/vendor/vexcel_quickstart.py, which is not
    # in git. Fill this in from that file; everything else (caching, routes, UI) is already wired.
    return None


# --------------------------------------------------------------------------- light

RAD = math.pi / 180


def sun_position(when: datetime, lat: float, lon: float) -> tuple[float, float]:
    """Sun altitude and azimuth in degrees (NOAA approximation, ported from frontend/sun.js)."""
    jd = when.timestamp() / 86400 + 2440587.5
    n = jd - 2451545.0
    L = (280.46 + 0.9856474 * n) % 360
    g = ((357.528 + 0.9856003 * n) % 360) * RAD
    lam = (L + 1.915 * math.sin(g) + 0.02 * math.sin(2 * g)) * RAD
    eps = (23.439 - 0.0000004 * n) * RAD
    ra = math.atan2(math.cos(eps) * math.sin(lam), math.cos(lam))
    dec = math.asin(math.sin(eps) * math.sin(lam))
    gmst = (18.697374558 + 24.06570982441908 * n) % 24
    ha = (gmst * 15 + lon) * RAD - ra
    phi = lat * RAD
    alt = math.asin(math.sin(phi) * math.sin(dec) + math.cos(phi) * math.cos(dec) * math.cos(ha))
    az = math.atan2(-math.sin(ha), math.tan(dec) * math.cos(phi) - math.sin(phi) * math.cos(ha))
    return alt / RAD, (az / RAD + 360) % 360


def utc_offset(metro: str, day: date) -> int:
    """US daylight time: second Sunday in March to first Sunday in November."""
    def nth_sunday(month: int, n: int) -> date:
        first = date(day.year, month, 1)
        return first + timedelta(days=(6 - first.weekday()) % 7 + 7 * (n - 1))
    dst = nth_sunday(3, 2) <= day < nth_sunday(11, 1)
    return (-6 if metro == "Houston" else -8) + (1 if dst else 0)


def _facades(footprint: list[tuple[float, float]]) -> list[dict]:
    """Outward-facing walls (8-way compass) with their lengths, from the Vexcel footprint."""
    if len(footprint) < 4:
        return [{"label": d, "facing": a, "length": 1.0} for d, a in (("N", 0), ("E", 90), ("S", 180), ("W", 270))]
    pts = footprint[:-1] if footprint[0] == footprint[-1] else footprint
    signed = sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(pts, pts[1:] + pts[:1])) / 2
    faces: dict[str, dict] = {}
    for (x1, y1), (x2, y2) in zip(pts, pts[1:] + pts[:1]):
        dx, dy = (x2 - x1) * math.cos(y1 * RAD), y2 - y1
        length = math.hypot(dx, dy)
        if not length:
            continue
        nx, ny = (dy, -dx) if signed > 0 else (-dy, dx)
        facing = (math.atan2(nx, ny) / RAD + 360) % 360
        label = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][round(facing / 45) % 8]
        f = faces.setdefault(label, {"label": label, "facing": round(facing / 45) % 8 * 45, "length": 0.0})
        f["length"] += length
    total = sum(f["length"] for f in faces.values())
    return sorted([f for f in faces.values() if f["length"] > total * 0.04], key=lambda f: -f["length"])


def _fmt_minute(m: int | None) -> str | None:
    if m is None:
        return None
    h, mm = divmod(m, 60)
    return f"{(h + 11) % 12 + 1}:{mm:02d}{'pm' if h >= 12 else 'am'}"


def day_light(lat: float, lon: float, metro: str, day: date, footprint=None) -> dict:
    """Sunrise, golden hours, sunset and when each wall of the building is in sun."""
    off = utc_offset(metro, day)
    base = datetime(day.year, day.month, day.day, tzinfo=timezone.utc) - timedelta(hours=off)
    samples = [(m, *sun_position(base + timedelta(minutes=m), lat, lon)) for m in range(0, 24 * 60 + 1, 5)]

    def cross(deg: float, rising: bool) -> int | None:
        for (_, a, _), (m, b, _) in zip(samples, samples[1:]):
            if (a < deg <= b) if rising else (a >= deg > b):
                return m
        return None

    walls = []
    for f in _facades(footprint or []):
        windows, start = [], None
        for m, alt, az in samples:
            lit = alt > 0 and math.cos((f["facing"] - az) * RAD) > 0.1
            if lit and start is None:
                start = m
            if not lit and start is not None:
                windows.append((start, m))
                start = None
        if start is not None:
            windows.append((start, samples[-1][0]))
        walls.append({"facade": f["label"],
                      "sun": [f"{_fmt_minute(a)} to {_fmt_minute(b)}" for a, b in windows] or ["no direct sun"]})
    noon = max(samples, key=lambda s: s[1])
    sunrise, sunset = cross(-0.83, True), cross(-0.83, False)
    return {
        "date": day.isoformat(),
        "utc_offset": off,
        "sunrise": _fmt_minute(sunrise),
        "golden_morning": f"{_fmt_minute(sunrise)} to {_fmt_minute(cross(6, True))}",
        "golden_evening": f"{_fmt_minute(cross(6, False))} to {_fmt_minute(sunset)}",
        "sunset": _fmt_minute(sunset),
        "daylight_hours": round(((sunset or 0) - (sunrise or 0)) / 60, 1),
        "solar_noon": _fmt_minute(noon[0]),
        "max_sun_altitude": round(noon[1]),
        "facades": walls,
    }


# --------------------------------------------------------------------------- brief

MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]


def parse_film_brief(text: str, today: date | None = None) -> dict:
    """'25 crew, quiet interior, LA, 3 weeks in April' -> crew, metro, shoot days and start date."""
    today = today or date.today()
    t = f" {text.lower()} "
    metro = "Houston" if "houston" in t or "htx" in t else "Los Angeles"
    m = re.search(r"(\d+)\s*(?:-\s*)?(?:person\s+)?(?:crew|people|cast and crew|cast & crew|on set)", t) \
        or re.search(r"crew of (\d+)", t)
    crew = int(m.group(1)) if m else 25
    days = 5
    if w := re.search(r"(\d+)\s*-?\s*weeks?", t):
        days = int(w.group(1)) * 7
    elif d := re.search(r"(\d+)\s*-?\s*(?:shoot\s+)?days?", t):
        days = int(d.group(1))
    start = None
    if iso := re.search(r"(20\d\d)-(\d\d)-(\d\d)", t):
        start = date(int(iso.group(1)), int(iso.group(2)), int(iso.group(3)))
    else:
        # "may" is usually the verb, so only count it after in/from/on/starting.
        month_re = r"\b(" + "|".join(m for m in MONTHS if m != "may") + r")[a-z]*\.?(?:\s+(\d{1,2}))?\b" \
                   r"|(?:in|from|on|starting|early|late|mid)\s+(may)(?:\s+(\d{1,2}))?\b"
        mo = re.search(month_re, t)
        if mo:
            name, dom = (mo.group(1), mo.group(2)) if mo.group(1) else (mo.group(3), mo.group(4))
            month = MONTHS.index(name) + 1
            dom = int(dom) if dom else 1
            year = today.year if (month, dom) >= (today.month, today.day) else today.year + 1
            start = date(year, month, min(dom, 28))
    if not start:
        start = today + timedelta(days=14)
    interior = not any(w in t for w in ("exterior", "outdoor", "rooftop", "outside"))
    return {"metro": metro, "crew": crew, "shoot_days": days, "start_date": start.isoformat(),
            "interior": interior, "dialogue": True}


def shoot_dates(start: str, days: int) -> list[str]:
    """One date per shoot week (first day, then each week), so the light table stays short."""
    d0 = date.fromisoformat(start)
    picks = [d0 + timedelta(days=i) for i in range(0, max(days, 1), 7)]
    last = d0 + timedelta(days=max(days, 1) - 1)
    if picks[-1] != last and days > 1:
        picks.append(last)
    return [p.isoformat() for p in picks[:6]]


# --------------------------------------------------------------------------- tools

def search_film_locations(metro: str = "Los Angeles", crew: int = 25, min_area_sqft: float = 1200,
                          interior_only: bool = True, max_results: int = 8) -> dict:
    """Rank scanned rooms for a film shoot: a dead room for dialogue, floor space, ceiling height,
    a building the production can control and a quiet street."""
    metro = data.CITY_ALIASES.get((metro or "").lower().strip(), metro) or "Los Angeles"
    ranked = []
    for venue in data.venues().values():
        if data.metro_of(venue) != metro:
            continue
        rooms = _rooms_for_venue(venue, crew, min_area_sqft)
        if not rooms:
            continue
        noise = noise_exposure(venue["lat"], venue["lon"], metro, venue["address"])
        for r in rooms:
            r["fit"] = _room_fit(r, venue, crew, noise)
        rooms.sort(key=lambda r: r["fit"]["score"], reverse=True)
        best = rooms[0]
        ranked.append((best["fit"]["score"], venue, best, noise, len(rooms)))
    ranked.sort(key=lambda t: t[0], reverse=True)

    results = []
    for score, venue, best, noise, n in ranked[:max_results]:
        a = best["acoustics"]
        results.append({
            "venue_id": venue["id"],
            "name": venue["name"],
            "address": venue["address"],
            "metro": metro,
            "lat": venue["lat"],
            "lon": venue["lon"],
            "property_type": venue["property_type"],
            "photo": venue.get("photo"),
            "match_score": score,
            "space": {
                "model_id": best["model_id"],
                "name": best["space_name"],
                "type": a["space_label"],
                "area_sqft": best["area_sqft"],
                "height_ft": best["height_ft"],
                "height_source": best["height_source"],
                "rt60_s": a["rt60_occupied_s"],
                "dialogue_verdict": _dialogue_verdict(a["rt60_occupied_s"]),
                "score_parts": best["fit"]["parts"],
            },
            "noise": {"score": noise["score"], "label": noise["label"], "summary": noise["summary"]},
            "parking_spaces": venue.get("parking_spaces"),
            "for_lease": bool(venue["listings"]),
            "rooms_considered": n,
        })
    return {
        "metro": metro,
        "crew": crew,
        "target_rt60_s": list(USES[FILM_USE][:2]),
        "venues_with_rooms": len(ranked),
        "results": results,
        "note": "Reverb is estimated from scan geometry and assumed finishes, with the crew in the room.",
    }


def _dialogue_verdict(rt: float) -> str:
    lo, hi = USES[FILM_USE][:2]
    if rt <= hi:
        return f"{rt:.2f} s of reverb. Dead enough to record dialogue as is."
    if rt <= hi * 1.6:
        return f"{rt:.2f} s of reverb. A few sound blankets will get it under {hi} s."
    return f"{rt:.2f} s of reverb. Live room, so plan on heavy blanketing or ADR."


def film_site_report(venue_id: int, crew: int = 25, start_date: str | None = None, shoot_days: int = 5) -> dict:
    """Everything a location manager needs on one venue: the best rooms, base camp capacity from the air,
    outside noise, shoot-day light per facade and links to the four oblique photos."""
    venue = data.venues().get(int(venue_id))
    if not venue:
        return {"error": f"Unknown venue {venue_id}"}
    metro = data.metro_of(venue)
    start_date = start_date or (date.today() + timedelta(days=14)).isoformat()
    noise = noise_exposure(venue["lat"], venue["lon"], metro, venue["address"])
    rooms = _rooms_for_venue(venue, crew, 600)
    for r in rooms:
        r["fit"] = _room_fit(r, venue, crew, noise)
        r["dialogue_verdict"] = _dialogue_verdict(r["acoustics"]["rt60_occupied_s"])
    rooms.sort(key=lambda r: r["fit"]["score"], reverse=True)
    camp = base_camp(venue, crew)
    attrs = vexcel.property_attributes(venue["id"], venue["lat"], venue["lon"]) or {}
    footprint = vexcel.wkt_points(attrs.get("footprint_wkt"))
    light = [day_light(venue["lat"], venue["lon"], metro, date.fromisoformat(d), footprint)
             for d in shoot_dates(start_date, shoot_days)]
    return {
        "venue_id": venue["id"],
        "name": venue["name"],
        "address": venue["address"],
        "metro": metro,
        "lat": venue["lat"],
        "lon": venue["lon"],
        "property_type": venue["property_type"],
        "building_sf": venue.get("building_sf"),
        "year_built": venue.get("year_built"),
        "for_lease": bool(venue["listings"]),
        "crew": crew,
        "rooms": [{k: r[k] for k in ("model_id", "space_name", "area_sqft", "height_ft", "height_source",
                                     "dialogue_verdict")}
                  | {"rt60_s": r["acoustics"]["rt60_occupied_s"], "type": r["acoustics"]["space_label"],
                     "score": r["fit"]["score"]} for r in rooms[:5]],
        "base_camp": camp,
        "noise": noise,
        "light": light,
        "facade_source": "Vexcel building footprint" if footprint else "assumed square building facing N/E/S/W",
        "obliques": {d: f"/api/film/{venue['id']}/oblique/{d}.jpg" for d in ("n", "e", "s", "w")},
    }


TOOLS = {
    "search_film_locations": search_film_locations,
    "film_site_report": film_site_report,
}

TOOL_SCHEMAS = [
    {
        "name": "search_film_locations",
        "description": "Rank Matterport-scanned rooms in Los Angeles or Houston for a film shoot. Scores each room "
                       "on dialogue reverb (RT60 with the crew in, target 0.3 to 0.6 s), floor area, ceiling "
                       "height, how controllable the building is and outside noise. Returns the best room per venue.",
        "input_schema": {
            "type": "object",
            "properties": {
                "metro": {"type": "string", "enum": ["Los Angeles", "Houston"]},
                "crew": {"type": "integer", "description": "People on set, cast and crew."},
                "min_area_sqft": {"type": "number", "description": "Smallest room to consider. Default 1200."},
                "max_results": {"type": "integer", "description": "Default 8."},
            },
            "required": ["metro", "crew"],
        },
    },
    {
        "name": "film_site_report",
        "description": "Full location report for one venue: its best rooms for dialogue, base camp capacity "
                       "(trailers and crew cars that fit on the paved parcel, from Vexcel hardscape and CoStar "
                       "parking, each number marked measured or estimated), a 1-5 outside noise score with the "
                       "nearest freeway, airport and rail line, and sunrise, golden hours, sunset and sun on each "
                       "facade for the shoot dates.",
        "input_schema": {
            "type": "object",
            "properties": {
                "venue_id": {"type": "integer"},
                "crew": {"type": "integer"},
                "start_date": {"type": "string", "description": "First shoot day, YYYY-MM-DD."},
                "shoot_days": {"type": "integer"},
            },
            "required": ["venue_id"],
        },
    },
]


# --------------------------------------------------------------------------- HTTP

@router.get("/search")
def http_search(brief: str = "", metro: str | None = None, crew: int | None = None,
                max_results: int = 8) -> dict:
    parsed = parse_film_brief(brief) if brief else {"metro": "Los Angeles", "crew": 25, "shoot_days": 5,
                                                     "start_date": (date.today() + timedelta(days=14)).isoformat()}
    if metro:
        parsed["metro"] = metro
    if crew:
        parsed["crew"] = crew
    result = search_film_locations(parsed["metro"], parsed["crew"], max_results=max_results)
    return {"brief": parsed, **result}


@router.get("/{venue_id}/report")
def http_report(venue_id: int, crew: int = 25, start_date: str | None = None, shoot_days: int = 5) -> dict:
    result = film_site_report(venue_id, crew=crew, start_date=start_date, shoot_days=shoot_days)
    if "error" in result:
        raise HTTPException(404, result["error"])
    return result


@router.get("/{venue_id}/light")
def http_light(venue_id: int, day: str) -> dict:
    venue = data.venues().get(venue_id)
    if not venue:
        raise HTTPException(404, "Unknown venue")
    attrs = vexcel.property_attributes(venue["id"], venue["lat"], venue["lon"]) or {}
    return day_light(venue["lat"], venue["lon"], data.metro_of(venue), date.fromisoformat(day),
                     vexcel.wkt_points(attrs.get("footprint_wkt")))


@router.get("/{venue_id}/basecamp.jpg")
def http_basecamp(venue_id: int) -> Response:
    venue = data.venues().get(venue_id)
    if not venue:
        raise HTTPException(404, "Unknown venue")
    image = base_camp_map(venue)
    if not image:
        raise HTTPException(404, "No aerial imagery for this parcel")
    return Response(image, media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})


@router.get("/{venue_id}/oblique/{direction}.jpg")
def http_oblique(venue_id: int, direction: str) -> Response:
    venue = data.venues().get(venue_id)
    if not venue:
        raise HTTPException(404, "Unknown venue")
    if direction.lower()[:1] not in DIRECTIONS:
        raise HTTPException(404, "Direction must be n, e, s or w")
    image = oblique_image(venue, direction)
    if not image:
        raise HTTPException(404, "No oblique imagery for this view")
    return Response(image, media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})
