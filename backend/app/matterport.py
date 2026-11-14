"""Matterport Model API client with an on-disk cache."""

from __future__ import annotations

import json

import httpx

from . import data
from .config import CACHE_DIR, MATTERPORT_API_KEY, MATTERPORT_API_TOKEN

API = "https://api.matterport.com/api/models/graph"
QUERY = """
query($id: ID!) {
  model(id: $id) {
    id name
    rooms { tags dimensionEstimates { area width depth height units } }
  }
}
"""


def get_model(model_id: str, allow_fetch: bool = True) -> dict | None:
    """Scan name + rooms, from the bulk cache, the per-model cache, or the API."""
    cached = data.models().get(model_id)
    if cached:
        return cached
    path = CACHE_DIR / f"mp_{model_id}.json"
    if path.exists():
        return json.loads(path.read_text())
    if not allow_fetch or not (MATTERPORT_API_KEY and MATTERPORT_API_TOKEN):
        return None
    try:
        r = httpx.post(API, auth=(MATTERPORT_API_KEY, MATTERPORT_API_TOKEN),
                       json={"query": QUERY, "variables": {"id": model_id}}, timeout=30)
        r.raise_for_status()
        model = (r.json().get("data") or {}).get("model")
    except httpx.HTTPError:
        return None
    if not model:
        return None
    compact = {
        "name": model.get("name"),
        "rooms": [
            {"tags": rm.get("tags") or [], **{k: (rm.get("dimensionEstimates") or {}).get(k)
                                            for k in ("area", "width", "depth", "height", "units")}}
            for rm in model.get("rooms") or []
        ],
    }
    path.write_text(json.dumps(compact))
    return compact


def to_feet(room: dict) -> dict:
    """Normalise a room's dimensions to feet / square feet."""
    if room.get("units") == "metric":
        f = 3.28084
        return {**room,
                "area": (room.get("area") or 0) * f * f or None,
                "width": (room.get("width") or 0) * f or None,
                "depth": (room.get("depth") or 0) * f or None,
                "height": (room.get("height") or 0) * f or None,
                "units": "imperial"}
    return room
