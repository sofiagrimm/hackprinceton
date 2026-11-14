"""Cities we cover with estimated venues (OpenStreetMap + Vexcel where it reaches)."""

from __future__ import annotations

NORCAL = "Northern California"
PANHANDLE = "Florida Panhandle"

# utc_offset is standard time; add an hour during daylight saving.
CITIES: dict[str, dict] = {
    "San Francisco": {"lat": 37.7749, "lon": -122.4194, "radius_mi": 5.5, "region": NORCAL, "utc_offset": -8},
    "Oakland": {"lat": 37.8044, "lon": -122.2712, "radius_mi": 4, "region": NORCAL, "utc_offset": -8},
    "Berkeley": {"lat": 37.8715, "lon": -122.2730, "radius_mi": 2.5, "region": NORCAL, "utc_offset": -8},
    "Stanford": {"lat": 37.4275, "lon": -122.1697, "radius_mi": 3.5, "region": NORCAL, "utc_offset": -8},
    "San Jose": {"lat": 37.3382, "lon": -121.8863, "radius_mi": 5, "region": NORCAL, "utc_offset": -8},
    "Sacramento": {"lat": 38.5816, "lon": -121.4944, "radius_mi": 5, "region": NORCAL, "utc_offset": -8},
    "Davis": {"lat": 38.5449, "lon": -121.7405, "radius_mi": 3, "region": NORCAL, "utc_offset": -8},
    "Pensacola": {"lat": 30.4213, "lon": -87.2169, "radius_mi": 5, "region": PANHANDLE, "utc_offset": -6},
    "Tallahassee": {"lat": 30.4383, "lon": -84.2807, "radius_mi": 5, "region": PANHANDLE, "utc_offset": -5},
}

ALIASES: dict[str, str] = {
    "san francisco": "San Francisco", "sf": "San Francisco", "san fran": "San Francisco",
    "frisco": "San Francisco",
    "oakland": "Oakland", "berkeley": "Berkeley",
    "stanford": "Stanford", "palo alto": "Stanford",
    "san jose": "San Jose",
    "sacramento": "Sacramento", "sac": "Sacramento", "sactown": "Sacramento",
    "davis": "Davis", "uc davis": "Davis",
    "pensacola": "Pensacola", "tallahassee": "Tallahassee", "fsu": "Tallahassee",
}

# Where Vexcel can't see, the 3D building comes from OpenStreetMap.
VEXCEL_GAPS = {"San Francisco", "Oakland", "Berkeley", "Stanford", "San Jose", "Tallahassee"}


def resolve(name: str | None) -> str | None:
    if not name:
        return None
    key = name.lower().strip().rstrip(".")
    if key in ALIASES:
        return ALIASES[key]
    for city in CITIES:
        if city.lower() == key:
            return city
    return None


def find_in_text(text: str) -> str | None:
    """The city a brief is about, preferring where they want to sing over where they're from.

    "Our Berkeley group wants to sing in San Francisco" -> San Francisco.
    """
    import re
    t = f" {text.lower()} "
    hits = []
    for alias, city in sorted(ALIASES.items(), key=lambda kv: -len(kv[0])):
        if len(alias) <= 3 and alias not in ("sf", "sac"):
            continue  # "cal" and similar are too easy to hit by accident
        for m in re.finditer(rf"(?<![a-z]){re.escape(alias)}(?![a-z])", t):
            before = t[max(0, m.start() - 14):m.start()]
            weight = 2 if re.search(r"\b(in|at|to|near|around|visiting|touring)\s+(the\s+)?$", before) else 1
            if re.search(r"\b(our|from|my)\s+$", before):
                weight = 0
            hits.append((weight, -m.start(), city))
    if not hits:
        return None
    hits.sort(reverse=True)
    return hits[0][2]
