"""Build the region venue index from Wikidata, when Overpass (OpenStreetMap) is unavailable.

    python scripts/build_regions_wikidata.py

For each region city it asks the Wikidata Query Service for churches, chapels,
cathedrals, synagogues, theaters, concert halls, performing arts centres,
music venues, community centres and hotels within the city's radius, with
seating capacity, height and floor count where Wikidata has them. The output
has the same shape as scripts/build_regions.py, so backend/app/regions.py reads
it unchanged. Wikidata has no building outlines, so those venues fall back to
Vexcel's footprint inside the coverage boxes, or a typical size for the type.

Writes data/index/regions.json and deploy/regions.json. Wikidata is CC0 (public
domain), so the shipped copy can live in git.
"""

from __future__ import annotations

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

ENDPOINT = "https://query.wikidata.org/sparql"
OUT = ROOT / "data" / "index" / "regions.json"
SHIPPED = ROOT / "deploy" / "regions.json"

# Wikidata class -> our venue kind (the amenity names regions.py knows). Order is priority.
CLASSES = [
    ("Q1060829", "concert_hall"),      # concert hall
    ("Q24354", "theatre"),             # theater building
    ("Q11635", "theatre"),             # theatre (structure)
    ("Q153562", "arts_centre"),        # performing arts center... (opera house is a subclass)
    ("Q8719053", "events_venue"),      # music venue
    ("Q2977", "place_of_worship"),     # cathedral
    ("Q16970", "place_of_worship"),    # church building
    ("Q108325", "place_of_worship"),   # chapel
    ("Q34627", "place_of_worship"),    # synagogue
    ("Q5153359", "community_centre"),  # community centre
    ("Q27686", "hotel"),               # hotel
]
KIND = dict(CLASSES)
RANK = {q: i for i, (q, _) in enumerate(CLASSES)}


def query_for(lat: float, lon: float, radius_km: float) -> str:
    values = " ".join(f"wd:{q}" for q, _ in CLASSES)
    return f"""
SELECT ?item ?itemLabel ?cls ?coord ?cap ?height ?floors ?web ?addr ?religionLabel WHERE {{
  SERVICE wikibase:around {{
    ?item wdt:P625 ?coord .
    bd:serviceParam wikibase:center "Point({lon} {lat})"^^geo:wktLiteral .
    bd:serviceParam wikibase:radius "{radius_km:.1f}" .
  }}
  VALUES ?cls {{ {values} }}
  ?item wdt:P31/wdt:P279? ?cls .
  FILTER NOT EXISTS {{ ?item wdt:P576 [] }}
  FILTER NOT EXISTS {{ ?item wdt:P5817 wd:Q56556915 }}
  OPTIONAL {{ ?item wdt:P1083 ?cap . }}
  OPTIONAL {{ ?item p:P2048/psn:P2048/wikibase:quantityAmount ?height . }}
  OPTIONAL {{ ?item wdt:P1101 ?floors . }}
  OPTIONAL {{ ?item wdt:P856 ?web . }}
  OPTIONAL {{ ?item wdt:P6375 ?addr . }}
  OPTIONAL {{ ?item wdt:P140 ?religion . }}
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en". }}
}}"""


CACHE = ROOT / "data" / "cache" / "wikidata"


def fetch(lat: float, lon: float, radius_km: float, city: str = "") -> list[dict]:
    path = CACHE / f"{city.lower().replace(' ', '_')}.json"
    if city and path.exists():
        return json.loads(path.read_text())
    url = ENDPOINT + "?" + urllib.parse.urlencode({"query": query_for(lat, lon, radius_km), "format": "json"})
    req = urllib.request.Request(url, headers={"User-Agent": "venue-scout-hackathon/1.0 (student project)",
                                               "Accept": "application/sparql-results+json"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                rows = json.loads(r.read())["results"]["bindings"]
            if city:
                CACHE.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps(rows))
            return rows
        except Exception as exc:
            print(f"  retry {attempt + 1}: {exc}", file=sys.stderr)
            time.sleep(65)  # the service is limited to one request a minute during outages
    raise SystemExit("Wikidata query failed")


def _num(b: dict, k: str) -> float | None:
    try:
        return float(b[k]["value"]) if k in b else None
    except ValueError:
        return None


def _miles(lat1, lon1, lat2, lon2) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 3958.8 * 2 * math.asin(math.sqrt(a))


def shape(city: str, spec: dict, rows: list[dict]) -> tuple[list[dict], list[dict]]:
    best: dict[str, dict] = {}
    for b in rows:
        qid = b["item"]["value"].rsplit("/", 1)[-1]
        name = b.get("itemLabel", {}).get("value", "")
        if not name or name == qid:  # no English label
            continue
        cls = b["cls"]["value"].rsplit("/", 1)[-1]
        lon, lat = (float(x) for x in b["coord"]["value"].removeprefix("Point(").rstrip(")").split())
        row = best.get(qid)
        if row is None or RANK[cls] < RANK[row["cls"]]:
            best[qid] = row = {"cls": cls, "name": name, "lat": lat, "lon": lon, "b": b}
        # Keep the largest capacity / height any row offers.
        for k in ("cap", "height", "floors"):
            v = _num(b, k)
            if v is not None and (row.get(k) is None or v > row[k]):
                row[k] = v
        for k in ("web", "addr", "religionLabel"):
            if k in b and k not in row:
                row[k] = b[k]["value"]

    venues, hotels = [], []
    for qid, r in best.items():
        kind = KIND[r["cls"]]
        base = {"id": f"wd-{qid}", "wikidata": qid, "name": r["name"], "lat": r["lat"], "lon": r["lon"],
                "city": city, "region": spec["region"], "address": r.get("addr") or "",
                "website": r.get("web"), "phone": None}
        if kind == "hotel":
            hotels.append({**base, "osm": None, "stars": None, "rooms": None})
            continue
        height = r.get("height")
        venues.append({
            **base, "osm": None, "kind": kind,
            "distance_mi": round(_miles(spec["lat"], spec["lon"], r["lat"], r["lon"]), 2),
            "religion": r.get("religionLabel"), "denomination": None, "building": None,
            "height_m": round(height, 1) if height and 3 < height < 150 else None,
            "levels": int(r["floors"]) if r.get("floors") else None,
            "seats": int(r["cap"]) if r.get("cap") and r["cap"] < 20000 else None,
            "footprint": None, "footprint_source": None,
            "vexcel_covered": covered(r["lat"], r["lon"], margin_m=80),
        })
    return venues, hotels


def main() -> None:
    all_venues, all_hotels = {}, {}
    for i, (city, spec) in enumerate(CITIES.items()):
        print(f"{city}...", file=sys.stderr)
        cached = (CACHE / f"{city.lower().replace(' ', '_')}.json").exists()
        rows = fetch(spec["lat"], spec["lon"], spec["radius_mi"] * 1.609, city)
        venues, hotels = shape(city, spec, rows)
        for v in venues:
            if v["id"] not in all_venues or v["distance_mi"] < all_venues[v["id"]]["distance_mi"]:
                all_venues[v["id"]] = v
        for h in hotels:
            all_hotels.setdefault(h["id"], h)
        print(f"  {len(venues)} venues, {len(hotels)} hotels", file=sys.stderr)
        if i < len(CITIES) - 1 and not cached:
            time.sleep(65)  # one request a minute
    doc = json.dumps({
        "built": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "Wikidata (CC0), via the Wikidata Query Service",
        "venues": sorted(all_venues.values(), key=lambda v: (v["city"], v["distance_mi"])),
        "hotels": sorted(all_hotels.values(), key=lambda h: (h["city"], h["name"])),
    })
    for path in (OUT, SHIPPED):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(doc)
    print(f"Wrote {OUT.relative_to(ROOT)} and {SHIPPED.relative_to(ROOT)}: "
          f"{len(all_venues)} venues, {len(all_hotels)} hotels")


if __name__ == "__main__":
    main()
