"""How close is the engine? Run it on concert halls whose reverberation is well documented.

Each hall is described only with what a scan would give us (floor area, ceiling
height) plus its finishes and audience area, then compared with the occupied
mid-frequency RT60 published in L. Beranek, "Concert Halls and Opera Houses"
(2nd ed., Springer 2004). We use the published volume, and the floor area from
the hall's main-floor dimensions; height is volume / floor area.

Nothing here is tuned to the halls: they run through the same `estimate()` as
every lounge and lobby in the app.
"""

from __future__ import annotations

from .acoustics import RoomGeometry, estimate

M2_TO_FT2 = 10.7639
M_TO_FT = 3.28084

# name, city, volume m^3, main floor length x width m, audience area m^2 (incl. balconies),
# floor finish, wall finish, ceiling finish, published occupied RT60 mid (s)
HALLS = [
    ("Musikverein, Grosser Saal", "Vienna", 15000, (48.8, 19.8), 1115, "wood_floor", "plaster", "plaster", 2.0),
    ("Symphony Hall", "Boston", 18750, (38.0, 22.9), 1550, "wood_floor", "plaster", "plaster", 1.9),
    ("Concertgebouw", "Amsterdam", 18780, (44.0, 28.0), 1285, "wood_floor", "plaster", "plaster", 2.0),
]


def run() -> list[dict]:
    out = []
    for name, city, volume, (length, width), audience_area, floor, walls, ceiling, published in HALLS:
        floor_m2 = length * width
        height_m = volume / floor_m2
        est = estimate(
            RoomGeometry(floor_m2 * M2_TO_FT2, height_m * M_TO_FT, length * M_TO_FT, width * M_TO_FT),
            "concert_hall", use="choral_performance",
            materials={"floor": floor, "walls": walls, "ceiling": ceiling, "furnishing": 0.0,
                       "seats": audience_area / floor_m2},
        )
        ours = est.rt60_occupied
        out.append({
            "hall": name, "city": city, "volume_m3": volume,
            "published_rt60_s": published, "estimated_rt60_s": round(ours, 2),
            "error_pct": round(100 * (ours - published) / published, 1),
            "stage_support_db": round(est.stage_support_db, 1),
        })
    return out


if __name__ == "__main__":
    for row in run():
        print(row)
