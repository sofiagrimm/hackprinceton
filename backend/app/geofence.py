"""Where our Vexcel key works.

Vexcel answers 403 outside these four boxes (Los Angeles, Houston, Northern
California above 38.07 N, and the Florida Panhandle west of about 84.8 W).
Every Vexcel call for a region venue goes through `covered()` first, so no
request ever leaves the polygons.

Note that San Francisco, Oakland, Berkeley, Stanford and Tallahassee are all
outside. Sacramento, Davis and Pensacola are inside.
"""

from __future__ import annotations

COVERAGE_WKT = (
    "MULTIPOLYGON (((-119.0134 33.0945, -116.8949 33.0945, -116.8949 34.3154, -119.0134 34.3154, -119.0134 33.0945)),"
    "((-96.2185 29.0173, -94.5758 29.0173, -94.5758 30.3804, -96.2185 30.3804, -96.2185 29.0173)),"
    "((-124.7437 38.0655, -118.9869 38.0655, -118.9869 41.9596, -124.7437 41.9596, -124.7437 38.0655)),"
    "((-88.2145 30.8016, -88.3285 30.132, -86.2124 30.2269, -85.5125 29.6277, -84.8004 29.5039, "
    "-84.9062 30.7876, -88.2145 30.8016)))"
)

POLYGONS: list[list[tuple[float, float]]] = [
    [(-119.0134, 33.0945), (-116.8949, 33.0945), (-116.8949, 34.3154), (-119.0134, 34.3154)],
    [(-96.2185, 29.0173), (-94.5758, 29.0173), (-94.5758, 30.3804), (-96.2185, 30.3804)],
    [(-124.7437, 38.0655), (-118.9869, 38.0655), (-118.9869, 41.9596), (-124.7437, 41.9596)],
    [(-88.2145, 30.8016), (-88.3285, 30.132), (-86.2124, 30.2269), (-85.5125, 29.6277),
     (-84.8004, 29.5039), (-84.9062, 30.7876)],
]


def _inside(lon: float, lat: float, ring: list[tuple[float, float]]) -> bool:
    inside = False
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % n]
        if (y1 > lat) != (y2 > lat) and lon < (x2 - x1) * (lat - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def covered(lat: float, lon: float, margin_m: float = 0) -> bool:
    """True if the point (and, with a margin, a square around it) is inside a Vexcel box."""
    if margin_m <= 0:
        return any(_inside(lon, lat, ring) for ring in POLYGONS)
    import math
    dlat = margin_m / 111_320
    dlon = margin_m / (111_320 * math.cos(math.radians(lat)))
    corners = [(lat + a, lon + b) for a in (-dlat, dlat) for b in (-dlon, dlon)]
    return all(any(_inside(x, y, ring) for ring in POLYGONS) for y, x in corners)
