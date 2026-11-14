"""Room acoustics from scan geometry: reverberation per octave band, clarity and intelligibility.

This is the physics core of the scout. Matterport gives us each room's floor
area, width, depth and ceiling height; Matterport's description of the scan
tells us the finishes (backend/app/materials.py), and when it doesn't we infer
them from what the space is.

For each octave band from 125 Hz to 4 kHz we compute the reverberation time
with the Eyring equation, including air absorption:

    RT60 = 0.161 V / (-S ln(1 - a) + 4 m V)              (metric units)

V is the room volume, S the total surface area, a the area-weighted absorption
coefficient of the finishes, furniture and audience, and m the air attenuation
coefficient. From the reverberation times we derive what musicians and
acousticians actually talk about:

* RT60 (mid)   - the average of 500 Hz and 1 kHz, "how long the room rings"
* bass ratio   - (T125 + T250) / (T500 + T1k); above ~1.1 a room sounds warm
* C80 clarity  - early-to-late energy ratio at a typical seat, from Barron's
                 revised theory; around 0 to +4 dB keeps choral lines distinct
* STI          - speech transmission index from the modulation transfer function
                 of an exponential decay; above ~0.6 lyrics and dialogue are clear

Everything here is deterministic and explainable, so a judge (or a tour
manager) can see exactly why a room scored the way it did.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

FT = 0.3048
SQFT = FT * FT
CUFT = FT ** 3

BANDS = (125, 250, 500, 1000, 2000, 4000)

# Absorption coefficients per octave band (125 Hz ... 4 kHz), from standard
# published tables (e.g. Long, "Architectural Acoustics"; Egan, "Architectural
# Acoustics"). Values are representative, not product-specific.
ABSORPTION: dict[str, tuple[float, ...]] = {
    "concrete":          (0.01, 0.01, 0.02, 0.02, 0.02, 0.02),
    "polished_stone":    (0.01, 0.01, 0.01, 0.01, 0.02, 0.02),
    "tile":              (0.01, 0.01, 0.01, 0.02, 0.02, 0.02),
    "glass":             (0.18, 0.06, 0.04, 0.03, 0.02, 0.02),
    "plaster":           (0.01, 0.02, 0.02, 0.03, 0.04, 0.05),
    "gypsum":            (0.29, 0.10, 0.05, 0.04, 0.07, 0.09),
    "brick":             (0.03, 0.03, 0.03, 0.04, 0.05, 0.07),
    "wood_floor":        (0.15, 0.11, 0.10, 0.07, 0.06, 0.07),
    "wood_panel":        (0.28, 0.22, 0.17, 0.09, 0.10, 0.11),
    "metal_deck":        (0.15, 0.10, 0.10, 0.08, 0.08, 0.07),
    "rubber_floor":      (0.02, 0.03, 0.03, 0.03, 0.03, 0.02),
    "vinyl":             (0.02, 0.03, 0.03, 0.03, 0.03, 0.02),
    "carpet":            (0.02, 0.06, 0.14, 0.37, 0.60, 0.65),
    "acoustic_tile":     (0.29, 0.29, 0.55, 0.75, 0.78, 0.79),
    "curtain":           (0.07, 0.31, 0.49, 0.75, 0.70, 0.60),
    "upholstered_seats": (0.49, 0.66, 0.80, 0.88, 0.82, 0.70),
    "mixed_furnishing":  (0.10, 0.15, 0.20, 0.25, 0.28, 0.30),
    "open":              (1.00, 1.00, 1.00, 1.00, 1.00, 1.00),  # open sky
    # Occupied, well-upholstered concert seating per m^2 of audience area (Beranek).
    "seats_occupied":    (0.62, 0.72, 0.80, 0.83, 0.84, 0.85),
}
# Mid-band (500 Hz - 1 kHz) values, kept for anything that wants one number.
MATERIALS: dict[str, float] = {k: round((v[2] + v[3]) / 2, 3) for k, v in ABSORPTION.items()}

PERSON_SABINS_M2 = (0.25, 0.35, 0.42, 0.46, 0.50, 0.50)   # one seated adult, per band
AIR_M = (0.0001, 0.0003, 0.0006, 0.0010, 0.0019, 0.0058)    # 1/m at 20 C, 50 % RH
MISC_ABSORPTION = 0.03   # doors, fixtures, signage and furniture not described anywhere

# Finishes we assume for a space when the scan description doesn't say:
# (floor, ceiling, walls, furnishing_share, label)
# furnishing_share is the fraction of floor area covered by sofas, beds,
# shelving and the like, which absorb on top of the floor finish.
PRESETS: dict[str, tuple[str, str, str, float, str]] = {
    "theater": ("carpet", "acoustic_tile", "wood_panel", 0.6, "theater / screening room"),
    "ballroom": ("carpet", "gypsum", "gypsum", 0.1, "ballroom / meeting room"),
    "lobby": ("polished_stone", "gypsum", "glass", 0.08, "lobby / atrium"),
    "chapel": ("wood_floor", "plaster", "plaster", 0.25, "chapel / sanctuary"),
    "clubhouse": ("wood_floor", "gypsum", "gypsum", 0.15, "clubhouse / lounge"),
    "rooftop": ("tile", "open", "glass", 0.05, "rooftop / terrace (open air)"),
    "fitness": ("rubber_floor", "gypsum", "glass", 0.10, "fitness studio"),
    "warehouse": ("concrete", "metal_deck", "concrete", 0.02, "warehouse / industrial bay"),
    "office": ("carpet", "acoustic_tile", "gypsum", 0.10, "office / conference"),
    "residential_living": ("wood_floor", "gypsum", "gypsum", 0.25, "furnished living area"),
    "bedroom": ("carpet", "gypsum", "gypsum", 0.35, "bedroom"),
    "bathroom": ("tile", "gypsum", "tile", 0.0, "bathroom"),
    "hallway": ("vinyl", "gypsum", "gypsum", 0.0, "corridor"),
    "unfinished": ("concrete", "concrete", "gypsum", 0.0, "unfinished shell space"),
    "generic": ("vinyl", "gypsum", "gypsum", 0.10, "general interior"),
    "concert_hall": ("wood_floor", "plaster", "plaster", 0.0, "concert hall"),
}

NAME_HINTS: list[tuple[tuple[str, ...], str]] = [
    (("theatre", "theater", "screening", "cinema", "auditorium"), "theater"),
    (("ballroom", "banquet", "meeting", "conference", "event", "board room", "boardroom"), "ballroom"),
    (("chapel", "church", "sanctuary", "worship"), "chapel"),
    (("lobby", "atrium", "foyer", "entry", "concierge"), "lobby"),
    (("rooftop", "roof deck", "sky deck", "terrace", "pool", "courtyard", "outdoor", "patio", "garden"), "rooftop"),
    (("clubhouse", "club room", "clubroom", "lounge", "game room", "resident", "amenity",
      "sky lounge", "social", "rec room", "community room", "leasing"), "clubhouse"),
    (("fitness", "gym", "yoga", "dance studio", "spin", "dance"), "fitness"),
    (("warehouse", "industrial", "loading", "shop", "dock"), "warehouse"),
]

TAG_HINTS: dict[str, str] = {
    "lobby": "lobby",
    "exercise": "fitness",
    "office": "office",
    "living": "residential_living",
    "dining": "residential_living",
    "kitchen": "residential_living",
    "bedroom": "bedroom",
    "bathroom": "bathroom",
    "hallway": "hallway",
    "laundry": "generic",
    "unfurnished": "unfinished",
}

# Target RT60 (seconds, occupied, mid band) for each intended use.
USES: dict[str, tuple[float, float, str]] = {
    "a_cappella_performance": (1.3, 2.0, "a cappella without mics"),
    "choral_performance": (1.6, 2.4, "a choir"),
    "rehearsal": (0.7, 1.2, "rehearsing, where you need to hear every part"),
    "recording": (0.4, 0.8, "recording vocals"),
    "film_dialogue": (0.3, 0.6, "filming dialogue"),
    "amplified_show": (0.8, 1.3, "a show with a sound system"),
}
SPEECH_USES = {"film_dialogue", "rehearsal", "amplified_show"}


@dataclass
class RoomGeometry:
    area_sqft: float
    height_ft: float | None = None
    width_ft: float | None = None
    depth_ft: float | None = None


@dataclass
class AcousticEstimate:
    space_type: str
    space_label: str
    volume_m3: float
    rt60_empty: float
    rt60_occupied: float
    audience: int
    capacity_standing: int
    capacity_seated: int
    use: str
    target: tuple[float, float]
    score: int
    verdict: str
    bands_empty: list[float] = field(default_factory=list)
    bands_occupied: list[float] = field(default_factory=list)
    bass_ratio: float = 1.0
    c80_db: float = 0.0
    d50: float = 0.0
    sti: float = 0.0
    dims_m: dict = field(default_factory=dict)
    surface_m2: float = 0.0
    room_constant_m2: float = 0.0
    notes: list[str] = field(default_factory=list)
    assumptions: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "space_type": self.space_type,
            "space_label": self.space_label,
            "volume_m3": round(self.volume_m3, 1),
            "rt60_empty_s": round(self.rt60_empty, 2),
            "rt60_occupied_s": round(self.rt60_occupied, 2),
            "bands_hz": list(BANDS),
            "rt60_bands_empty_s": [round(x, 2) for x in self.bands_empty],
            "rt60_bands_occupied_s": [round(x, 2) for x in self.bands_occupied],
            "bass_ratio": round(self.bass_ratio, 2),
            "c80_db": round(self.c80_db, 1),
            "d50": round(self.d50, 2),
            "sti": round(self.sti, 2),
            "dims_m": {k: round(v, 2) for k, v in self.dims_m.items()},
            "surface_m2": round(self.surface_m2, 1),
            "room_constant_m2": round(self.room_constant_m2, 1),
            "audience": self.audience,
            "capacity_standing": self.capacity_standing,
            "capacity_seated": self.capacity_seated,
            "use": self.use,
            "target_s": list(self.target),
            "score": self.score,
            "verdict": self.verdict,
            "notes": self.notes,
            "assumptions": self.assumptions,
        }


def classify_space(name: str | None, tags: list[str] | None, property_type: str | None) -> str:
    """Guess the kind of space from its scan name, room tags and building type."""
    text = (name or "").lower()
    for words, kind in NAME_HINTS:
        if any(w in text for w in words):
            return kind
    for tag in tags or []:
        if tag in TAG_HINTS:
            kind = TAG_HINTS[tag]
            if kind == "residential_living" and property_type in ("Office", "Industrial", "Flex"):
                return "unfinished" if "unfurnished" in (tags or []) else "office"
            return kind
    if property_type in ("Industrial", "Flex"):
        return "warehouse"
    if property_type == "Office":
        return "office"
    return "generic"


# --------------------------------------------------------------------------- physics

def _eyring(volume: float, surface: float, absorption: float, air_m: float) -> float:
    a_mean = min(max(absorption / surface, 0.01), 0.95)
    return 0.161 * volume / (-surface * math.log(1 - a_mean) + 4 * air_m * volume)


def barron_c80(rt: float, volume: float, distance: float) -> float:
    """Clarity C80 (dB) at a listener `distance` metres from the source (Barron's revised theory)."""
    rt = max(rt, 0.05)
    direct = 100.0 / max(distance, 1.0) ** 2
    reflected = (31200.0 * rt / volume) * math.exp(-0.04 * distance / rt)
    early = reflected * (1 - math.exp(-1.11 / rt))
    late = reflected * math.exp(-1.11 / rt)
    return 10 * math.log10((direct + early) / max(late, 1e-9))


def barron_d50(rt: float, volume: float, distance: float) -> float:
    """Definition D50 (0-1): share of energy arriving in the first 50 ms."""
    rt = max(rt, 0.05)
    direct = 100.0 / max(distance, 1.0) ** 2
    reflected = (31200.0 * rt / volume) * math.exp(-0.04 * distance / rt)
    early = reflected * (1 - math.exp(-0.69 / rt))
    return (direct + early) / (direct + reflected)


MOD_FREQS = (0.63, 0.8, 1.0, 1.25, 1.6, 2.0, 2.5, 3.15, 4.0, 5.0, 6.3, 8.0, 10.0, 12.5)


def sti_from_rt(rt: float, drr: float) -> float:
    """Speech transmission index from an exponential decay plus direct sound (no background noise).

    m(F) = 1 / sqrt(1 + (2 pi F T / 13.8)^2) for the reverberant field; the direct sound,
    `drr` times stronger or weaker than the reverberant field, is fully modulated.
    """
    tis = []
    for f in MOD_FREQS:
        m_rev = 1 / math.sqrt(1 + (2 * math.pi * f * rt / 13.8) ** 2)
        m = (drr + m_rev) / (drr + 1)
        m = min(max(m, 1e-4), 0.9999)
        snr = max(-15.0, min(15.0, 10 * math.log10(m / (1 - m))))
        tis.append((snr + 15) / 30)
    return sum(tis) / len(tis)


def estimate(
    geom: RoomGeometry,
    space_type: str,
    use: str = "a_cappella_performance",
    audience: int | None = None,
    materials: dict | None = None,
) -> AcousticEstimate:
    """Estimate reverberation, clarity and intelligibility for one room and score it for a use."""
    floor_mat, ceil_mat, wall_mat, furnish, label = PRESETS.get(space_type, PRESETS["generic"])
    notes: list[str] = []
    found = {}
    if materials:
        found = {k: v for k, v in materials.items() if k in ("floor", "ceiling", "walls") and v in ABSORPTION}
        floor_mat = found.get("floor", floor_mat)
        ceil_mat = found.get("ceiling", ceil_mat)
        wall_mat = found.get("walls", wall_mat)
        if isinstance(materials.get("furnishing"), (int, float)):
            furnish = float(materials["furnishing"])

    height = geom.height_ft
    if not height or height < 6:
        tall = bool(materials and materials.get("tall"))
        height = 18.0 if tall else (10.0 if space_type in ("ballroom", "lobby", "warehouse", "theater") else 9.0)
        notes.append(f"Ceiling height not in the scan; assumed {height:.0f} ft.")
    area_ft2 = max(geom.area_sqft, 1.0)
    if geom.width_ft and geom.depth_ft and geom.width_ft > 1 and geom.depth_ft > 1:
        length_ft, width_ft = max(geom.width_ft, geom.depth_ft), min(geom.width_ft, geom.depth_ft)
        perimeter_ft = 2 * (geom.width_ft + geom.depth_ft)
    else:
        width_ft = math.sqrt(area_ft2 / 1.5)
        length_ft = area_ft2 / width_ft
        perimeter_ft = 2 * (length_ft + width_ft) * 1.05   # irregular rooms run a little longer

    floor_m2 = area_ft2 * SQFT
    wall_m2 = perimeter_ft * height * SQFT
    volume = area_ft2 * height * CUFT
    surface = 2 * floor_m2 + wall_m2
    open_air = ceil_mat == "open"
    if open_air:
        notes.append("Open-air space: little reverberation, sound carries away; plan on light amplification.")

    capacity_standing = int(area_ft2 / 7)
    capacity_seated = int(area_ft2 / 12)
    crowd = audience if audience is not None else min(capacity_seated, 80)
    crowd = max(0, min(crowd, capacity_standing))

    # Fixed audience seating (concert halls): area of occupied seats as a share of the floor;
    # it can exceed 1 when balconies add seating area. Seats replace the per-person figure.
    seat_share = float(materials.get("seats", 0)) if materials else 0.0
    if seat_share:
        crowd = 0

    bands_empty, bands_occ = [], []
    room_constant = 0.0
    for i in range(len(BANDS)):
        bare_floor = max(0.0, 1 - seat_share)
        absorb = (
            floor_m2 * bare_floor * (ABSORPTION[floor_mat][i] * (1 - furnish) + ABSORPTION["mixed_furnishing"][i] * furnish)
            + floor_m2 * seat_share * ABSORPTION["seats_occupied"][i]
            + floor_m2 * ABSORPTION[ceil_mat][i]
            + wall_m2 * ABSORPTION[wall_mat][i]
            + surface * MISC_ABSORPTION
        )
        people = crowd * PERSON_SABINS_M2[i]
        bands_empty.append(_eyring(volume, surface, absorb, AIR_M[i]))
        bands_occ.append(_eyring(volume, surface, absorb + people, AIR_M[i]))
        if BANDS[i] in (500, 1000):
            a = min((absorb + people) / surface, 0.95)
            room_constant += 0.5 * surface * a / (1 - a)

    rt_empty = (bands_empty[2] + bands_empty[3]) / 2
    rt_occ = (bands_occ[2] + bands_occ[3]) / 2
    bass_ratio = (bands_occ[0] + bands_occ[1]) / max(bands_occ[2] + bands_occ[3], 1e-6)

    # A typical listener sits about 60 % of the way down the long axis from the singers.
    distance = max(3.0, 0.6 * length_ft * FT)
    c80 = barron_c80(rt_occ, volume, distance)
    d50 = barron_d50(rt_occ, volume, distance)
    drr = (1 / (4 * math.pi * distance ** 2)) / (4 / max(room_constant, 1e-6))
    sti = sti_from_rt(rt_occ, drr)

    lo, hi, use_label = USES.get(use, USES["a_cappella_performance"])
    score = _score(rt_occ, lo, hi)
    if use in SPEECH_USES and sti < 0.55:
        score = min(score, int(sti * 120))
    if volume < 60:
        score = min(score, 45)
        notes.append("Small room: low notes can boom and the group will sound crowded.")
    if bass_ratio > 1.35 and not open_air:
        notes.append(f"Bass ratio {bass_ratio:.2f}: low voices will bloom; basses may want to sing lighter.")
    elif bass_ratio < 0.9 and not open_air:
        notes.append(f"Bass ratio {bass_ratio:.2f}: the room is bright and a little thin in the low end.")

    return AcousticEstimate(
        space_type=space_type,
        space_label=label,
        volume_m3=volume,
        rt60_empty=rt_empty,
        rt60_occupied=rt_occ,
        audience=crowd,
        capacity_standing=capacity_standing,
        capacity_seated=capacity_seated,
        use=use,
        target=(lo, hi),
        score=score,
        verdict=_verdict(rt_occ, lo, hi, use_label),
        bands_empty=bands_empty,
        bands_occupied=bands_occ,
        bass_ratio=bass_ratio,
        c80_db=c80,
        d50=d50,
        sti=sti,
        dims_m={"length": length_ft * FT, "width": width_ft * FT, "height": height * FT},
        surface_m2=surface,
        room_constant_m2=room_constant,
        notes=notes,
        assumptions={"floor": floor_mat, "ceiling": ceil_mat, "walls": wall_mat,
                     "furnishing_share": round(furnish, 2), "height_ft": round(height, 1),
                     "from_scan_description": sorted(found)},
    )


def _score(rt: float, lo: float, hi: float) -> int:
    """100 inside the target band, falling off with the log-distance outside it."""
    if lo <= rt <= hi:
        return 100
    edge = lo if rt < lo else hi
    miss = abs(math.log(rt / edge))  # 0.18 is roughly 20% off
    return max(0, int(round(100 - miss * 160)))


def _verdict(rt: float, lo: float, hi: float, use_label: str) -> str:
    if lo <= rt <= hi:
        return f"About {rt:.1f} seconds of reverb with a crowd in, which is right for {use_label}."
    if rt < lo:
        if lo / rt > 2:
            return f"Only {rt:.1f} seconds of reverb. Voices will sound flat here without a PA."
        return f"{rt:.1f} seconds of reverb, a bit dry for {use_label}. It works, but the blend will feel exposed."
    if rt / hi > 1.6:
        return f"{rt:.1f} seconds of reverb. Words will blur together unless you hang drapes."
    return f"{rt:.1f} seconds of reverb, a bit live. Slow songs will sound great and fast lyrics will smear."
