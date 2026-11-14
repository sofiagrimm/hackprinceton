"""Vexcel aerial data: parcel attributes and ortho imagery for a venue."""

from __future__ import annotations

import json

import httpx

from .config import CACHE_DIR, VEXCEL_API_KEY

API = "https://api.vexcelgroup.com/v2"
LAYERS = "urban,urban-r,wide-area,urban-g"


def _headers() -> dict:
    return {"X-API-KEY": VEXCEL_API_KEY}


def property_attributes(venue_id: int, lat: float, lon: float) -> dict | None:
    """Footprint, roof, detected vehicles and the parcel polygon at a point."""
    path = CACHE_DIR / f"vx_{venue_id}.json"
    if path.exists():
        return json.loads(path.read_text())
    if not VEXCEL_API_KEY:
        return None
    try:
        r = httpx.get(f"{API}/property/extract", headers=_headers(), timeout=60, params={
            "wkt": f"POINT({lon} {lat})", "srid": 4326, "layer": LAYERS,
            "latest": "true", "include": "precomputed", "unit-system": "imperial"})
    except httpx.HTTPError:
        return None
    if r.status_code != 200:
        result = {"available": False, "status": r.status_code}
        path.write_text(json.dumps(result))
        return result
    feats = r.json().get("features") or []
    if not feats:
        return {"available": False}
    f = feats[0]
    props = f.get("properties") or {}
    structures = props.get("structures") or []
    main = max(structures, key=lambda s: s.get("footprint.area") or 0) if structures else {}
    result = {
        "available": True,
        "parcel_wkt": _geometry_to_wkt(f.get("geometry")),
        "footprint_wkt": main.get("footprint.wkt"),
        "structure_count": props.get("structure.count"),
        "footprint_sqft": main.get("footprint.area"),
        "roof_material": main.get("roof-characteristics.material.class"),
        "roof_shape": main.get("roof-characteristics.shape.value"),
        "roof_condition": main.get("roof-characteristics.condition"),
        "max_roof_height_ft": main.get("roof-characteristics.maximum-roof-height"),
        "stories_below_eave": main.get("roof-characteristics.number-of-stories-below-eave"),
        "solar_panels": main.get("roof-objects.solar-panel-photovoltaic.count"),
        "building_type": main.get("building-type.class"),
        "vehicles_on_parcel": props.get("vehicles.count"),
        "hardscape_sqft": props.get("hardscapes.area"),
        "pool": props.get("pool.detected"),
        "capture_date": props.get("metadata.ortho-date-estimate"),
        "collection": props.get("metadata.collection"),
    }
    path.write_text(json.dumps(result))
    return result


def ortho_image(venue_id: int, lat: float, lon: float, parcel_wkt: str | None) -> bytes | None:
    """A JPEG aerial of the parcel (or a 120 m square around the point)."""
    path = CACHE_DIR / f"vx_{venue_id}.jpg"
    if path.exists():
        return path.read_bytes()
    if not VEXCEL_API_KEY:
        return None
    wkt = parcel_wkt or _square(lat, lon, 60)
    body = {"wkt": wkt, "srid": 4326, "layer": LAYERS, "buffer-meter": IMAGE_BUFFER_M,
            "crop": "bounding_box", "image-format": "jpeg",
            "drawing": [{"wkt": wkt, "outline-width": 4, "outline-color": "rgb(255,49,88)"}]}
    try:
        r = httpx.post(f"{API}/ortho/extract", headers=_headers(), json=body, timeout=120)
    except httpx.HTTPError:
        return None
    if r.status_code != 200 or not r.content:
        return None
    path.write_bytes(r.content)
    return r.content


IMAGE_BUFFER_M = 25


def image_bounds(lat: float, lon: float, parcel_wkt: str | None) -> dict:
    """Approximate lon/lat bounds of the ortho image (parcel bbox + buffer)."""
    import math
    pts = wkt_points(parcel_wkt or _square(lat, lon, 60))
    lons, lats = [p[0] for p in pts], [p[1] for p in pts]
    dlat = IMAGE_BUFFER_M / 111_320
    dlon = IMAGE_BUFFER_M / (111_320 * math.cos(math.radians(lat)))
    return {"west": min(lons) - dlon, "east": max(lons) + dlon,
            "south": min(lats) - dlat, "north": max(lats) + dlat}


def wkt_points(wkt: str | None) -> list[tuple[float, float]]:
    if not wkt:
        return []
    import re
    first_ring = re.search(r"\(\(+([^()]+)\)", wkt)
    if not first_ring:
        return []
    pts = []
    for pair in first_ring.group(1).split(","):
        x, y, *_ = pair.split()
        pts.append((float(x), float(y)))
    return pts


def _square(lat: float, lon: float, half_m: float) -> str:
    import math
    dlat = half_m / 111_320
    dlon = half_m / (111_320 * math.cos(math.radians(lat)))
    w, e, s, n = lon - dlon, lon + dlon, lat - dlat, lat + dlat
    return f"POLYGON(({w} {s},{e} {s},{e} {n},{w} {n},{w} {s}))"


def _geometry_to_wkt(geom) -> str | None:
    if not geom:
        return None
    if isinstance(geom, str):
        return geom
    if geom.get("type") == "Polygon":
        ring = geom["coordinates"][0]
        return "POLYGON((" + ",".join(f"{x} {y}" for x, y, *_ in ring) + "))"
    if geom.get("type") == "MultiPolygon":
        ring = geom["coordinates"][0][0]
        return "POLYGON((" + ",".join(f"{x} {y}" for x, y, *_ in ring) + "))"
    return None
