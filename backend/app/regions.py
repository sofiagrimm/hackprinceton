"""Estimated venues outside Los Angeles and Houston.

CoStar records and Matterport scans only exist for LA and Houston. For Northern
California and the Florida Panhandle we start from OpenStreetMap (churches,
theatres, halls and hotels, built by scripts/build_regions.py), take the
building's footprint and roof height from Vexcel where our key works, and
guess the main room from the kind of building:

    footprint x share of the floor plan that is the main room = hall area
    roof height x share that is open to the ceiling            = hall height

That volume goes through the same Eyring model as the scanned rooms
(acoustics.estimate) with a preset picked from the building type. Nothing here
has been inside the building, so every result says so.

Vexcel only answers inside four boxes (see geofence.py). San Francisco,
Oakland, Berkeley, Stanford and Tallahassee are outside them; there the
footprint and height come from OpenStreetMap, or from typical sizes if OSM has
no outline.
"""

from __future__ import annotations

import json
import math
from typing import Iterator

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

from . import vexcel
from .acoustics import USES, RoomGeometry, estimate
from .config import INDEX_DIR, ROOT, VEXCEL_API_KEY
from .geofence import covered
from .region_cities import ALIASES, CITIES, VEXCEL_GAPS, find_in_text, resolve

ESTIMATED_NOTE = "Estimated, no interior scan"
# OpenStreetMap data is ODbL, so a built copy can live in git at deploy/regions.json
# (Railway reads that one); a fresh local build in data/index wins.
_LOCAL_REGIONS = INDEX_DIR / "regions.json"
_SHIPPED_REGIONS = ROOT / "deploy" / "regions.json"
REGIONS_FILE = _LOCAL_REGIONS
FT = 0.3048
SQFT_PER_M2 = 10.7639

# OSM amenity -> (acoustics preset, share of footprint that is the main room,
#                 share of roof height open to the ceiling, ceiling clamp ft, hall area clamp sqft,
#                 what we call the room, ranking weight)
KINDS: dict[str, dict] = {
    "place_of_worship": {"preset": "chapel", "hall_share": 0.62, "height_share": 0.72,
                         "ceiling": (18, 70), "area": (900, 14000), "room": "Sanctuary", "weight": 1.0,
                         "typical_footprint_sqft": 7000, "typical_height_ft": 40, "label": "church"},
    "concert_hall": {"preset": "chapel", "hall_share": 0.55, "height_share": 0.75,
                     "ceiling": (24, 70), "area": (2000, 20000), "room": "Concert hall", "weight": 1.0,
                     "typical_footprint_sqft": 20000, "typical_height_ft": 55, "label": "concert hall"},
    "theatre": {"preset": "theater", "hall_share": 0.45, "height_share": 0.75,
                "ceiling": (18, 55), "area": (1200, 16000), "room": "Auditorium", "weight": 0.95,
                "typical_footprint_sqft": 12000, "typical_height_ft": 45, "label": "theater"},
    "events_venue": {"preset": "ballroom", "hall_share": 0.6, "height_share": 0.8,
                     "ceiling": (12, 28), "area": (1200, 15000), "room": "Main hall", "weight": 0.9,
                     "typical_footprint_sqft": 8000, "typical_height_ft": 24, "label": "event hall"},
    "arts_centre": {"preset": "ballroom", "hall_share": 0.35, "height_share": 0.8,
                    "ceiling": (12, 30), "area": (800, 10000), "room": "Main hall", "weight": 0.85,
                    "typical_footprint_sqft": 9000, "typical_height_ft": 26, "label": "arts center"},
    "community_centre": {"preset": "ballroom", "hall_share": 0.35, "height_share": 0.8,
                         "ceiling": (11, 24), "area": (800, 9000), "room": "Main hall", "weight": 0.8,
                         "typical_footprint_sqft": 8000, "typical_height_ft": 22, "label": "community hall"},
}


# ----------------------------------------------------------------------------- data

_cache: dict = {}


def _load() -> dict:
    global REGIONS_FILE
    REGIONS_FILE = _LOCAL_REGIONS if _LOCAL_REGIONS.exists() else _SHIPPED_REGIONS
    if not REGIONS_FILE.exists():
        return {"venues": [], "hotels": [], "missing": True}
    mtime = REGIONS_FILE.stat().st_mtime
    if _cache.get("mtime") != mtime:
        raw = json.loads(REGIONS_FILE.read_text())
        raw["by_id"] = {v["id"]: v for v in raw["venues"]}
        _cache.update(mtime=mtime, data=raw)
    return _cache["data"]


def _venue(venue_id: str) -> dict | None:
    return _load()["by_id"].get(str(venue_id)) if not _load().get("missing") else None


def _miles(lat1, lon1, lat2, lon2) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = (math.sin((p2 - p1) / 2) ** 2
         + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2)
    return 2 * 3958.8 * math.asin(math.sqrt(a))


def _ring_area_sqft(ring: list[list[float]] | list[tuple[float, float]]) -> float:
    if not ring or len(ring) < 3:
        return 0.0
    lat0 = sum(p[1] for p in ring) / len(ring)
    kx = 111_320 * math.cos(math.radians(lat0))
    pts = [(p[0] * kx, p[1] * 111_320) for p in ring]
    s = sum(pts[i][0] * pts[i - 1][1] - pts[i - 1][0] * pts[i][1] for i in range(len(pts)))
    return abs(s) / 2 * SQFT_PER_M2


# ----------------------------------------------------------------------------- Vexcel, fenced

def _vexcel_ok(v: dict) -> bool:
    return bool(VEXCEL_API_KEY) and covered(v["lat"], v["lon"], margin_m=80)


def _vexcel_attrs(v: dict) -> dict | None:
    """Vexcel property/extract for a region venue, only inside the coverage polygons."""
    if not _vexcel_ok(v):
        return None
    attrs = vexcel.property_attributes(v["id"], v["lat"], v["lon"])
    return attrs if attrs and attrs.get("available") else None


def _parcel_inside(wkt: str | None) -> bool:
    pts = vexcel.wkt_points(wkt)
    return all(covered(lat, lon) for lon, lat in pts) if pts else True


# ----------------------------------------------------------------------------- building and room

def _building(v: dict, use_vexcel: bool) -> dict:
    """Footprint and roof height, with where each number came from."""
    attrs = _vexcel_attrs(v) if use_vexcel else None
    k = KINDS.get(v["kind"], KINDS["community_centre"])
    ring, footprint, height_ft = None, None, None
    fp_src = ht_src = None
    if attrs:
        pts = vexcel.wkt_points(attrs.get("footprint_wkt"))
        if pts:
            ring, fp_src = [list(p) for p in pts], "Vexcel aerial footprint"
        if attrs.get("footprint_sqft"):
            footprint, fp_src = float(attrs["footprint_sqft"]), "Vexcel aerial footprint"
        if attrs.get("max_roof_height_ft"):
            height_ft, ht_src = float(attrs["max_roof_height_ft"]), "Vexcel roof height"
    if not ring and v.get("footprint"):
        ring = v["footprint"]
    if footprint is None and ring:
        footprint, fp_src = _ring_area_sqft(ring), v.get("footprint_source") or "OpenStreetMap outline"
    if height_ft is None and v.get("height_m"):
        height_ft, ht_src = v["height_m"] / FT, "OpenStreetMap height tag"
    if height_ft is None and v.get("levels"):
        height_ft, ht_src = v["levels"] * 13.0, f"OpenStreetMap, {v['levels']} levels"
    if not footprint or footprint < 400:
        footprint, fp_src = k["typical_footprint_sqft"], f"typical size for a {k['label']}"
    if not height_ft:
        height_ft, ht_src = k["typical_height_ft"], f"typical height for a {k['label']}"
    return {
        "footprint": ring, "footprint_sqft": round(footprint), "height_ft": round(height_ft, 1),
        "footprint_source": fp_src, "height_source": ht_src,
        "vexcel": attrs, "vexcel_covered": covered(v["lat"], v["lon"], margin_m=80),
    }


def _room(v: dict, b: dict) -> dict:
    k = KINDS.get(v["kind"], KINDS["community_centre"])
    lo_a, hi_a = k["area"]
    lo_h, hi_h = k["ceiling"]
    area = min(max(b["footprint_sqft"] * k["hall_share"], lo_a), hi_a)
    # Towers and steeples inflate roof height; keep a church's nave height sane.
    height = min(max(b["height_ft"] * k["height_share"], lo_h), hi_h)
    return {"name": k["room"], "area_sqft": round(area), "height_ft": round(height, 1), "preset": k["preset"]}


def _assess(v: dict, use: str, audience: int, use_vexcel: bool) -> dict:
    k = KINDS.get(v["kind"], KINDS["community_centre"])
    b = _building(v, use_vexcel)
    room = _room(v, b)
    est = estimate(RoomGeometry(room["area_sqft"], room["height_ft"]), room["preset"], use=use, audience=audience)
    a = est.to_dict()
    a["notes"] = [n for n in a["notes"] if not n.startswith("Ceiling height not in scan")]
    a["notes"].insert(0, f"{ESTIMATED_NOTE}. We assumed the {room['name'].lower()} takes about "
                         f"{round(k['hall_share'] * 100)}% of the footprint and most of the roof height.")
    basis = [f"Footprint {b['footprint_sqft']:,} sq ft, from {b['footprint_source']}.",
             f"Roof about {round(b['height_ft'])} ft, from {b['height_source']}."]
    fit = est.score * k["weight"]
    if b["footprint_source"].startswith(("Vexcel", "OpenStreetMap")):
        fit += 3  # a measured outline beats a typical size
    if v.get("seats") and v["seats"] >= audience:
        fit += 4
    return {"building": b, "room": room, "acoustics": a, "basis": basis, "fit": fit}


def _card(v: dict, assessed: dict) -> dict:
    b, room, a = assessed["building"], assessed["room"], assessed["acoustics"]
    vx = b.get("vexcel") or {}
    return {
        "venue_id": v["id"],
        "name": v["name"],
        "address": v.get("address") or "",
        "metro": v["city"],
        "region": v["region"],
        "lat": v["lat"],
        "lon": v["lon"],
        "kind": v["kind"],
        "kind_label": KINDS.get(v["kind"], KINDS["community_centre"])["label"],
        "denomination": v.get("denomination"),
        "website": v.get("website"),
        "phone": v.get("phone"),
        "osm": v.get("osm"),
        "estimated": True,
        "estimate_note": ESTIMATED_NOTE,
        "has_interior_scan": False,
        "matterport_models": [],
        "vexcel_covered": b["vexcel_covered"],
        "building": {"footprint_sqft": b["footprint_sqft"], "height_ft": b["height_ft"],
                     "footprint_source": b["footprint_source"], "height_source": b["height_source"],
                     "roof_shape": vx.get("roof_shape"), "roof_material": vx.get("roof_material")},
        "best_space": {"space_name": room["name"], "area_sqft": room["area_sqft"], "height_ft": room["height_ft"],
                       "acoustics": a, "basis": assessed["basis"], "model_id": None},
        "match_score": round(min(assessed["fit"], 100)),
    }


# ----------------------------------------------------------------------------- tools

def search_region_venues(city: str, audience: int = 60, use: str = "a_cappella_performance",
                         max_results: int = 8, with_lodging: bool = True, group_size: int = 14,
                         nights: int = 2) -> dict:
    """Rank OSM churches, theaters and halls in a region city by estimated acoustics and capacity."""
    name = resolve(city)
    if not name:
        return {"error": f"{city} isn't one of the estimated cities: {', '.join(CITIES)}."}
    data = _load()
    if data.get("missing"):
        return {"error": "No region data yet. Run python scripts/build_regions.py."}
    if use not in USES:
        use = "a_cappella_performance"
    spec = CITIES[name]
    pool = [v for v in data["venues"] if v["city"] == name and v["kind"] in KINDS]

    # First pass on OpenStreetMap alone (no API calls), then refine the leaders with Vexcel.
    first = []
    for v in pool:
        got = _assess(v, use, audience, use_vexcel=False)
        if got["acoustics"]["capacity_standing"] >= audience * 0.8:
            first.append((got["fit"], v))
    first.sort(key=lambda t: t[0], reverse=True)
    shortlist = [v for _, v in first[:max_results * 2]]
    ranked = []
    for v in shortlist:
        got = _assess(v, use, audience, use_vexcel=True)
        if got["acoustics"]["capacity_standing"] >= audience * 0.8:
            ranked.append(_card(v, got))
    ranked.sort(key=lambda c: c["match_score"] + c["best_space"]["acoustics"]["score"] / 1000, reverse=True)
    results = ranked[:max_results]

    out = {
        "metro": name,
        "region": spec["region"],
        "estimated": True,
        "estimate_note": ESTIMATED_NOTE,
        "use": use,
        "use_label": USES[use][2],
        "target_rt60_s": list(USES[use][:2]),
        "audience": audience,
        "venues_considered": len(pool),
        "vexcel_covered": name not in VEXCEL_GAPS,
        "coverage_note": (None if name not in VEXCEL_GAPS else
                          f"Vexcel imagery doesn't cover {name}, so building outlines and heights come from "
                          "OpenStreetMap."),
        "results": results,
    }
    if with_lodging and results:
        out["lodging"] = find_region_lodging(results[0]["venue_id"], group_size=group_size, nights=nights)
    return out


def analyze_region_venue(venue_id: str, use: str = "a_cappella_performance", audience: int = 60) -> dict:
    """The estimate for one region venue, with the building numbers and where they came from."""
    v = _venue(venue_id)
    if not v:
        return {"error": f"Unknown region venue {venue_id}"}
    return _card(v, _assess(v, use, audience, use_vexcel=True))


def region_site_check(venue_id: str) -> dict:
    """The building from above: footprint, height and an aerial photo where Vexcel covers it."""
    v = _venue(venue_id)
    if not v:
        return {"error": f"Unknown region venue {venue_id}"}
    b = _building(v, use_vexcel=True)
    vx = b.get("vexcel") or {}
    parcel = vx.get("parcel_wkt") if vx and _parcel_inside(vx.get("parcel_wkt")) else None
    ring = b["footprint"]
    if parcel:
        bounds = vexcel.image_bounds(v["lat"], v["lon"], parcel)
    else:
        bounds = _bounds(ring, v["lat"], v["lon"])
    notes = [f"Footprint about {b['footprint_sqft']:,} sq ft, from {b['footprint_source']}.",
             f"Roof about {round(b['height_ft'])} ft, from {b['height_source']}."]
    if not b["vexcel_covered"]:
        notes.append(f"Vexcel imagery doesn't cover {v['city']}, so there's no aerial photo.")
    elif vx.get("vehicles_on_parcel") is not None:
        notes.append(f"Vexcel counted {vx['vehicles_on_parcel']} vehicles on the parcel at capture.")
    return {
        "venue_id": v["id"], "name": v["name"], "lat": v["lat"], "lon": v["lon"],
        "estimated": True, "estimate_note": ESTIMATED_NOTE,
        "vexcel_covered": b["vexcel_covered"],
        "aerial": {k: val for k, val in vx.items() if k not in ("parcel_wkt", "footprint_wkt")},
        "aerial_image_url": f"/api/regions/venues/{v['id']}/aerial.jpg" if vx else None,
        "image_bounds": bounds,
        "footprint": [tuple(p) for p in ring] if ring else [],
        "building_height_ft": b["height_ft"],
        "footprint_sqft": b["footprint_sqft"],
        "notes": notes,
    }


def find_region_lodging(venue_id: str, group_size: int = 14, nights: int = 2,
                        radius_miles: float = 3, max_results: int = 5) -> dict:
    """Hotels from OpenStreetMap near a region venue. OSM has no prices, so there are no rates."""
    v = _venue(venue_id)
    if not v:
        return {"error": f"Unknown region venue {venue_id}"}
    rooms = -(-group_size // 2)
    options = []
    for h in _load()["hotels"]:
        d = _miles(v["lat"], v["lon"], h["lat"], h["lon"])
        if d > radius_miles:
            continue
        if h.get("rooms") and h["rooms"] < rooms:
            continue
        options.append({
            "kind": "hotel", "name": h["name"], "address": h.get("address") or "",
            "distance_miles": round(d, 1), "stars": h.get("stars"), "rooms": h.get("rooms"),
            "rooms_needed": rooms, "estimated_total": None,
            "website": h.get("website"), "phone": h.get("phone"),
            "why": f"{rooms} rooms for {nights} night{'s' if nights != 1 else ''}. No rate on file, ask for a group rate",
        })
    options.sort(key=lambda o: o["distance_miles"])
    return {
        "venue": v["name"], "venue_id": v["id"], "group_size": group_size, "nights": nights,
        "options": options[:max_results],
        "note": "Hotels come from OpenStreetMap, which has no prices. Ask each one for a group rate.",
    }


def _bounds(ring, lat: float, lon: float, buffer_m: float = 25) -> dict:
    pts = ring or []
    if not pts:
        return vexcel.image_bounds(lat, lon, None)
    dlat = buffer_m / 111_320
    dlon = buffer_m / (111_320 * math.cos(math.radians(lat)))
    lons, lats = [p[0] for p in pts], [p[1] for p in pts]
    return {"west": min(lons) - dlon, "east": max(lons) + dlon,
            "south": min(lats) - dlat, "north": max(lats) + dlat}


TOOLS = {
    "search_region_venues": search_region_venues,
    "analyze_region_venue": analyze_region_venue,
    "region_site_check": region_site_check,
    "find_region_lodging": find_region_lodging,
}

_CITY_LIST = ", ".join(CITIES)

TOOL_SCHEMAS = [
    {
        "name": "search_region_venues",
        "description": "Rank churches, theaters and halls in Northern California or the Florida Panhandle "
                       f"({_CITY_LIST}) by estimated acoustics and capacity. These come from OpenStreetMap and "
                       "Vexcel building footprints, not interior scans, so every result is marked estimated. "
                       "Use this instead of search_venues for any city outside Los Angeles and Houston. Also "
                       "returns hotels near the top pick.",
        "input_schema": {
            "type": "object",
            "properties": {
                "city": {"type": "string", "description": f"One of: {_CITY_LIST}."},
                "audience": {"type": "integer", "description": "Expected audience size."},
                "use": {"type": "string", "enum": list(USES), "description": "Intended use of the room."},
                "max_results": {"type": "integer", "default": 8},
                "with_lodging": {"type": "boolean", "default": True},
                "group_size": {"type": "integer", "description": "Number of performers, for lodging."},
                "nights": {"type": "integer", "description": "Nights of lodging needed."},
            },
            "required": ["city"],
        },
    },
    {
        "name": "analyze_region_venue",
        "description": "Estimated acoustics for one region venue (an id like osm-w123 from search_region_venues), "
                       "with the footprint, roof height and where each number came from.",
        "input_schema": {
            "type": "object",
            "properties": {
                "venue_id": {"type": "string"},
                "use": {"type": "string", "enum": list(USES)},
                "audience": {"type": "integer"},
            },
            "required": ["venue_id"],
        },
    },
    {
        "name": "region_site_check",
        "description": "The building from above for a region venue: footprint outline, roof height and, where "
                       "Vexcel covers the city, aerial attributes.",
        "input_schema": {
            "type": "object",
            "properties": {"venue_id": {"type": "string"}},
            "required": ["venue_id"],
        },
    },
    {
        "name": "find_region_lodging",
        "description": "Hotels from OpenStreetMap near a region venue, nearest first. No prices are available.",
        "input_schema": {
            "type": "object",
            "properties": {
                "venue_id": {"type": "string"},
                "group_size": {"type": "integer"},
                "nights": {"type": "integer"},
                "radius_miles": {"type": "number", "default": 3},
            },
            "required": ["venue_id"],
        },
    },
]


# ----------------------------------------------------------------------------- a small planner

def parse_region_brief(text: str) -> dict | None:
    """The brief's numbers (via agent.parse_brief) with a region city in place of LA/Houston."""
    city = find_in_text(text)
    if not city:
        return None
    from .agent import parse_brief
    brief = parse_brief(text)
    brief["metro"] = city
    brief["region"] = CITIES[city]["region"]
    return brief


def run_region_scout(text: str) -> Iterator[dict]:
    """Same event stream as /api/scout: plan, tool, tool_result, message, done."""
    brief = parse_region_brief(text)
    if not brief:
        yield {"type": "error", "text": f"I couldn't find one of these cities in the brief: {_CITY_LIST}."}
        return
    yield {"type": "plan", "text": (
        f"{brief['group_size']} singers, about {brief['audience']} guests in {brief['metro']}. "
        "No one has scanned these rooms, so I'll estimate them from the buildings.")}

    def call(name, args):
        yield {"type": "tool", "name": name, "input": args}
        try:
            result = TOOLS[name](**args)
        except Exception as exc:
            result = {"error": f"{type(exc).__name__}: {exc}"}
        yield {"type": "tool_result", "name": name, "result": result}
        return result

    found = yield from call("search_region_venues", {
        "city": brief["metro"], "audience": brief["audience"], "use": brief["use"],
        "group_size": brief["group_size"], "nights": brief["nights"]})
    if found.get("error") or not found.get("results"):
        yield {"type": "message", "text": found.get("error") or "Nothing big enough turned up. Try a smaller audience."}
        yield {"type": "done", "brief": brief}
        return
    pick = found["results"][0]
    yield from call("region_site_check", {"venue_id": pick["venue_id"]})
    a = pick["best_space"]["acoustics"]
    stay = (found.get("lodging") or {}).get("options") or []
    lines = [f"I'd start with {pick['name']}. {a['verdict']} The {pick['best_space']['space_name'].lower()} "
             f"should seat about {a['capacity_seated']}."]
    if stay:
        lines.append(f"{stay[0]['name']} is {stay[0]['distance_miles']} miles away.")
    backups = [r["name"] for r in found["results"][1:3]]
    if backups:
        lines.append("If it's taken, try " + " or ".join(backups) + ".")
    lines.append("These are estimates from the outside of the building. Ask to hear the room before you book.")
    yield {"type": "message", "text": " ".join(lines)}
    yield {"type": "done", "brief": brief}


# ----------------------------------------------------------------------------- HTTP

router = APIRouter(prefix="/api/regions", tags=["regions"])


class RegionScoutRequest(BaseModel):
    brief: str


@router.get("")
def regions_overview() -> dict:
    data = _load()
    counts: dict[str, dict] = {c: {"venues": 0, "hotels": 0} for c in CITIES}
    for v in data["venues"]:
        counts.setdefault(v["city"], {"venues": 0, "hotels": 0})["venues"] += 1
    for h in data["hotels"]:
        counts.setdefault(h["city"], {"venues": 0, "hotels": 0})["hotels"] += 1
    return {
        "ready": not data.get("missing"),
        "built": data.get("built"),
        "source": data.get("source"),
        "estimate_note": ESTIMATED_NOTE,
        "aliases": ALIASES,
        "cities": [{"name": c, "region": s["region"], "lat": s["lat"], "lon": s["lon"], "utc_offset": s["utc_offset"],
                    "vexcel_covered": c not in VEXCEL_GAPS, **counts[c]} for c, s in CITIES.items()],
    }


@router.get("/detect")
def detect(brief: str) -> dict:
    """Which estimated city a brief is about, if any (the front end uses this to route the brief)."""
    b = parse_region_brief(brief)
    return {"city": b["metro"] if b else None, "brief": b}


@router.get("/search")
def search(city: str, audience: int = 60, use: str = "a_cappella_performance", max_results: int = 8,
           group_size: int = 14, nights: int = 2) -> dict:
    out = search_region_venues(city, audience=audience, use=use, max_results=max_results,
                               group_size=group_size, nights=nights)
    if out.get("error"):
        raise HTTPException(404, out["error"])
    return out


@router.post("/scout")
def scout(req: RegionScoutRequest) -> StreamingResponse:
    def stream():
        yield json.dumps({"type": "agent", "name": "regions"}) + "\n"
        try:
            for ev in run_region_scout(req.brief):
                yield json.dumps(ev, default=str) + "\n"
        except Exception as exc:
            yield json.dumps({"type": "error", "text": f"{type(exc).__name__}: {exc}"}) + "\n"
    return StreamingResponse(stream(), media_type="application/x-ndjson")


@router.get("/venues/{venue_id}")
def venue(venue_id: str, use: str = "a_cappella_performance", audience: int = 60) -> dict:
    out = analyze_region_venue(venue_id, use=use, audience=audience)
    if out.get("error"):
        raise HTTPException(404, out["error"])
    return out


@router.get("/venues/{venue_id}/site")
def site(venue_id: str) -> dict:
    out = region_site_check(venue_id)
    if out.get("error"):
        raise HTTPException(404, out["error"])
    return out


@router.get("/venues/{venue_id}/housing")
def housing(venue_id: str, group_size: int = 14, nights: int = 2) -> dict:
    out = find_region_lodging(venue_id, group_size=group_size, nights=nights)
    if out.get("error"):
        raise HTTPException(404, out["error"])
    return out


@router.get("/venues/{venue_id}/aerial.jpg")
def aerial(venue_id: str) -> Response:
    v = _venue(venue_id)
    if not v:
        raise HTTPException(404, "Unknown region venue")
    attrs = _vexcel_attrs(v)
    if not attrs or not _parcel_inside(attrs.get("parcel_wkt")):
        raise HTTPException(404, "Vexcel imagery doesn't cover this building")
    image = vexcel.ortho_image(v["id"], v["lat"], v["lon"], attrs.get("parcel_wkt"))
    if not image:
        raise HTTPException(404, "No aerial imagery for this building")
    return Response(image, media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})
