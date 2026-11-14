"""Room-by-room 360 photos from Matterport, for the lighting preview.

Every Matterport scan is made of panoramas taken around each room. For a venue
we list its indoor rooms across all of its scans, pick the panorama nearest the
middle of each room, and serve that panorama's six cube faces through our own
server (Matterport's image links are signed and expire, and the browser needs
same-origin images to draw them in WebGL).
"""

from __future__ import annotations

import time

import httpx

from . import data
from .config import CACHE_DIR, MATTERPORT_API_KEY, MATTERPORT_API_TOKEN

API = "https://api.matterport.com/api/models/graph"
QUERY = """
query($id: ID!) {
  model(id: $id) {
    name
    rooms { id classifications { label } dimensionEstimates { area height units } }
    panoLocations {
      id position { x y z } anchor { room { id } }
      skybox(resolution: "2k") { children }
    }
  }
}
"""
OUTDOOR = {"patio", "balcony", "garden", "pool", "driveway", "garage", "outdoor", "void", "yard", "deck"}
_cache: dict[str, tuple[float, dict]] = {}
TTL = 40 * 60  # Matterport's signed image links last about an hour


def _model(model_id: str) -> dict | None:
    hit = _cache.get(model_id)
    if hit and time.time() - hit[0] < TTL:
        return hit[1]
    if not (MATTERPORT_API_KEY and MATTERPORT_API_TOKEN):
        return None
    try:
        r = httpx.post(API, auth=(MATTERPORT_API_KEY, MATTERPORT_API_TOKEN),
                       json={"query": QUERY, "variables": {"id": model_id}}, timeout=40)
        r.raise_for_status()
        model = (r.json().get("data") or {}).get("model")
    except httpx.HTTPError:
        return None
    if model:
        _cache[model_id] = (time.time(), model)
    return model


def _central_pano(panos: list[dict]) -> dict | None:
    if not panos:
        return None
    xs = [p["position"]["x"] for p in panos]
    ys = [p["position"]["y"] for p in panos]
    cx, cy = sum(xs) / len(xs), sum(ys) / len(ys)
    return min(panos, key=lambda p: (p["position"]["x"] - cx) ** 2 + (p["position"]["y"] - cy) ** 2)


PRIVATE = {"bedroom", "bathroom", "closet", "laundry", "entrance", "entryway", "foyer", "hallway",
           "staircase", "utility", "pantry", "garage"}


def rooms_for_venue(venue_id: int, limit_models: int = 10) -> list[dict]:
    """Indoor rooms with a usable 360 photo, across the venue's scans."""
    venue = data.venues().get(int(venue_id))
    if not venue:
        return []
    out = []
    for model_id in venue["matterport_models"][:limit_models]:
        model = _model(model_id)
        if not model:
            continue
        panos_by_room: dict[str, list[dict]] = {}
        for p in model.get("panoLocations") or []:
            room_id = ((p.get("anchor") or {}).get("room") or {}).get("id")
            if room_id and (p.get("skybox") or {}).get("children"):
                panos_by_room.setdefault(room_id, []).append(p)
        from .scout import OUTDOOR_NAME, UNIT_NAME
        import re
        scan_name = model.get("name") or ""
        if UNIT_NAME.search(scan_name):  # apartment and hotel-room scans aren't places to perform
            continue
        if (OUTDOOR_NAME.search(scan_name) or re.search(r"\bexterior\b", scan_name, re.I)) \
                and not re.search(r"\b(interior|indoor|inside)\b", scan_name, re.I):
            continue
        for room in model.get("rooms") or []:
            labels = [c["label"] for c in room.get("classifications") or [] if c.get("label")]
            if {l.lower() for l in labels} & (OUTDOOR | PRIVATE):
                continue
            pano = _central_pano(panos_by_room.get(room["id"], []))
            if not pano:
                continue
            dims = room.get("dimensionEstimates") or {}
            area = dims.get("area")
            if area and dims.get("units") == "metric":
                area *= 10.7639
            if area is not None and area < 250:
                continue
            out.append({
                "model_id": model_id,
                "pano_id": pano["id"],
                "scan": model.get("name"),
                "room": " / ".join(l for l in labels[:2] if l.lower() != "other") or "",
                "area_sqft": round(area) if area else None,
            })
    out.sort(key=lambda r: -(r["area_sqft"] or 0))
    return out


def face(model_id: str, pano_id: str, index: int) -> bytes | None:
    """One cube face (0 up, 1-4 around, 5 down) of a panorama, cached on disk."""
    path = CACHE_DIR / f"pano_{model_id}_{pano_id}_{index}.jpg"
    if path.exists():
        return path.read_bytes()
    model = _model(model_id)
    if not model:
        return None
    pano = next((p for p in model.get("panoLocations") or [] if p["id"] == pano_id), None)
    urls = ((pano or {}).get("skybox") or {}).get("children") or []
    if index >= len(urls):
        return None
    try:
        r = httpx.get(urls[index], timeout=40)
    except httpx.HTTPError:
        return None
    if r.status_code != 200:
        _cache.pop(model_id, None)  # the signed link may have expired; refetch next time
        return None
    path.write_bytes(r.content)
    return r.content
