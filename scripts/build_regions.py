"""Pull candidate venues and hotels for the estimated regions from OpenStreetMap.

    python scripts/build_regions.py              # every city
    python scripts/build_regions.py --city Berkeley --city Davis
    python scripts/build_regions.py --from raw/  # rebuild from saved Overpass replies

Writes data/index/regions.json (git-ignored like the rest of data/). Needs
overpass-api.de to be reachable. Raw replies are kept in data/cache/overpass/
so a rebuild doesn't hit the API again.

OpenStreetMap data is (c) OpenStreetMap contributors, ODbL.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.geofence import covered  # noqa: E402
from app.region_cities import CITIES  # noqa: E402

OVERPASS = "https://overpass-api.de/api/interpreter"
VENUE_AMENITIES = ("place_of_worship", "theatre", "arts_centre", "community_centre", "events_venue", "concert_hall")
OUT = ROOT / "data" / "index" / "regions.json"
RAW = ROOT / "data" / "cache" / "overpass"


def query_for(lat: float, lon: float, radius_m: int) -> str:
    amen = "|".join(VENUE_AMENITIES)
    a = f"(around:{radius_m},{lat},{lon})"
    return f"""[out:json][timeout:180];
(
  nwr{a}[amenity~"^({amen})$"][name];
  nwr{a}[tourism=hotel][name];
)->.hits;
node.hits; out;
way.hits; out geom;
rel.hits; out center;
node.hits[amenity]->.pins;
way(around.pins:30)[building]; out geom;
"""


def fetch(city: str, spec: dict, use_cache: bool = True) -> dict:
    RAW.mkdir(parents=True, exist_ok=True)
    path = RAW / f"{city.lower().replace(' ', '_')}.json"
    if use_cache and path.exists():
        return json.loads(path.read_text())
    q = query_for(spec["lat"], spec["lon"], int(spec["radius_mi"] * 1609))
    body = urllib.parse.urlencode({"data": q}).encode()
    req = urllib.request.Request(OVERPASS, data=body, headers={"User-Agent": "encore-scout-hackathon/1.0"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=240) as r:
                raw = json.loads(r.read())
            path.write_text(json.dumps(raw))
            return raw
        except Exception as exc:  # 429 and 504 are common on the public server
            wait = 10 * (attempt + 1)
            print(f"  {city}: {exc}; retrying in {wait}s", file=sys.stderr)
            time.sleep(wait)
    raise SystemExit(f"Overpass failed for {city}. Is overpass-api.de allowed on this network?")


# ----------------------------------------------------------------------------- shaping

def _ring(el: dict) -> list[list[float]] | None:
    geom = el.get("geometry")
    if not geom or len(geom) < 4:
        return None
    return [[round(p["lon"], 7), round(p["lat"], 7)] for p in geom]


def _center(el: dict) -> tuple[float, float] | None:
    if "lat" in el:
        return el["lat"], el["lon"]
    if "center" in el:
        return el["center"]["lat"], el["center"]["lon"]
    ring = _ring(el)
    if ring:
        return sum(p[1] for p in ring) / len(ring), sum(p[0] for p in ring) / len(ring)
    return None


def _contains(ring: list[list[float]], lat: float, lon: float) -> bool:
    inside = False
    for i in range(len(ring) - 1):
        (x1, y1), (x2, y2) = ring[i], ring[i + 1]
        if (y1 > lat) != (y2 > lat) and lon < (x2 - x1) * (lat - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def _height_m(tags: dict) -> float | None:
    for key in ("height", "building:height"):
        val = (tags.get(key) or "").replace("m", "").strip()
        try:
            return float(val)
        except ValueError:
            pass
    return None


def _levels(tags: dict) -> int | None:
    try:
        return int(float(tags.get("building:levels", "")))
    except ValueError:
        return None


def _address(tags: dict) -> str:
    street = " ".join(x for x in (tags.get("addr:housenumber"), tags.get("addr:street")) if x)
    return ", ".join(x for x in (street, tags.get("addr:city")) if x)


def _miles(lat1, lon1, lat2, lon2) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = (math.sin((p2 - p1) / 2) ** 2
         + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2)
    return 2 * 3958.8 * math.asin(math.sqrt(a))


def shape(city: str, spec: dict, raw: dict) -> tuple[list[dict], list[dict]]:
    elements = raw.get("elements", [])
    buildings = [e for e in elements if e["type"] == "way" and "building" in e.get("tags", {})
                 and not ({"amenity", "tourism"} & set(e.get("tags", {})))]
    venues, hotels = [], []
    for el in elements:
        tags = el.get("tags") or {}
        name = tags.get("name")
        c = _center(el)
        if not name or not c:
            continue
        lat, lon = c
        osm = f"{el['type']}/{el['id']}"
        rid = f"osm-{el['type'][0]}{el['id']}"
        if tags.get("tourism") == "hotel":
            stars = tags.get("stars")
            hotels.append({
                "id": rid, "osm": osm, "name": name, "lat": lat, "lon": lon, "city": city,
                "region": spec["region"], "address": _address(tags),
                "stars": float(stars) if stars and stars.replace(".", "", 1).isdigit() else None,
                "rooms": int(tags["rooms"]) if tags.get("rooms", "").isdigit() else None,
                "website": tags.get("website") or tags.get("contact:website"),
                "phone": tags.get("phone") or tags.get("contact:phone"),
            })
            continue
        if tags.get("amenity") not in VENUE_AMENITIES:
            continue
        ring = _ring(el) if el["type"] == "way" else None
        src_tags = tags
        footprint_source = "OpenStreetMap outline" if ring else None
        if not ring and el["type"] == "node":
            # A pin inside a building: borrow the building's outline and height.
            home = next((b for b in buildings if _ring(b) and _contains(_ring(b), lat, lon)), None)
            if home:
                ring = _ring(home)
                src_tags = {**home.get("tags", {}), **tags}
                footprint_source = "OpenStreetMap outline of the building around the pin"
        venues.append({
            "id": rid, "osm": osm, "name": name, "kind": tags["amenity"],
            "city": city, "region": spec["region"], "lat": lat, "lon": lon,
            "distance_mi": round(_miles(spec["lat"], spec["lon"], lat, lon), 2),
            "address": _address(tags),
            "religion": tags.get("religion"), "denomination": tags.get("denomination"),
            "building": src_tags.get("building"),
            "height_m": _height_m(src_tags), "levels": _levels(src_tags),
            "seats": int(tags["capacity"]) if tags.get("capacity", "").isdigit() else None,
            "footprint": ring, "footprint_source": footprint_source,
            "website": tags.get("website") or tags.get("contact:website"),
            "phone": tags.get("phone") or tags.get("contact:phone"),
            "vexcel_covered": covered(lat, lon, margin_m=80),
        })
    return venues, hotels


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--city", action="append", help="only these cities (repeatable)")
    ap.add_argument("--refresh", action="store_true", help="ignore cached Overpass replies")
    args = ap.parse_args()

    cities = {k: v for k, v in CITIES.items() if not args.city or k in args.city}
    all_venues, all_hotels = {}, {}
    if OUT.exists() and args.city:  # merge into an existing build
        old = json.loads(OUT.read_text())
        all_venues = {v["id"]: v for v in old["venues"] if v["city"] not in cities}
        all_hotels = {h["id"]: h for h in old["hotels"] if h["city"] not in cities}
    for i, (city, spec) in enumerate(cities.items()):
        print(f"{city}...", file=sys.stderr)
        raw = fetch(city, spec, use_cache=not args.refresh)
        venues, hotels = shape(city, spec, raw)
        for v in venues:  # a venue near two city centres keeps the closer one
            if v["id"] not in all_venues or v["distance_mi"] < all_venues[v["id"]]["distance_mi"]:
                all_venues[v["id"]] = v
        for h in hotels:
            all_hotels.setdefault(h["id"], h)
        print(f"  {len(venues)} venues, {len(hotels)} hotels", file=sys.stderr)
        if i < len(cities) - 1:
            time.sleep(2)  # be polite to the public server

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "built": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "OpenStreetMap contributors via Overpass API (ODbL)",
        "venues": sorted(all_venues.values(), key=lambda v: (v["city"], v["distance_mi"])),
        "hotels": sorted(all_hotels.values(), key=lambda h: (h["city"], h["name"])),
    }))
    print(f"Wrote {OUT.relative_to(ROOT)}: {len(all_venues)} venues, {len(all_hotels)} hotels")


if __name__ == "__main__":
    main()
