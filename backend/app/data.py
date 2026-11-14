"""In-memory store over the indexes built by scripts/build_index.py."""

from __future__ import annotations

import json
import math
from functools import lru_cache

from .config import INDEX_DIR


def _load(name: str):
    path = INDEX_DIR / name
    if not path.exists():
        raise FileNotFoundError(
            f"{path} is missing. Unzip the CoStar kit to data/kit and run "
            "`python scripts/build_index.py` (and scripts/fetch_matterport.py)."
        )
    return json.loads(path.read_text())


@lru_cache(maxsize=1)
def venues() -> dict[int, dict]:
    return {v["id"]: v for v in _load("venues.json")}


@lru_cache(maxsize=1)
def housing() -> list[dict]:
    return _load("housing.json")


def models() -> dict[str, dict | None]:
    """Cached Matterport scan names and room geometry (may still be filling)."""
    path = INDEX_DIR / "models.json"
    if not path.exists():
        return {}
    mtime = path.stat().st_mtime
    if _models_cache.get("mtime") != mtime:
        _models_cache["data"] = json.loads(path.read_text())
        _models_cache["mtime"] = mtime
    return _models_cache["data"]


_models_cache: dict = {}


def miles_between(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 3958.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


CITY_ALIASES = {
    "la": "Los Angeles", "los angeles": "Los Angeles", "l.a.": "Los Angeles",
    "hollywood": "Los Angeles", "houston": "Houston", "htx": "Houston",
}
CITY_CENTERS = {
    "Los Angeles": (34.0522, -118.2437),
    "Houston": (29.7604, -95.3698),
}


def metro_of(venue: dict) -> str:
    return "Los Angeles" if venue.get("state") == "CA" else "Houston"
