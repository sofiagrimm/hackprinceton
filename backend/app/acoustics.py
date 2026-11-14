"""Room acoustics: estimate reverberation time (RT60) from scan geometry.

This is the physics core of the scout. Matterport gives us each room's floor
area, width, depth and ceiling height. We infer the likely surface finishes
from what the space is (its scan name, room tags and building type) and run
the Eyring equation, a refinement of Sabine's that stays accurate in rooms
with a lot of absorption:

    RT60 = 0.161 * V / (-S * ln(1 - a_mean))        (metric units)

V is room volume, S total surface area and a_mean the area-weighted absorption
coefficient at 500 Hz - 1 kHz, the band that carries most of the voice. People
absorb sound too, so we report the empty room and the room with an audience.

Everything here is deterministic and explainable, so a judge (or a tour
manager) can see exactly why a room scored the way it did.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

FT = 0.3048
SQFT = FT * FT
CUFT = FT ** 3

# Mid-frequency (500 Hz - 1 kHz) absorption coefficients for common finishes.
MATERIALS: dict[str, float] = {
    "concrete": 0.02,
    "polished_stone": 0.02,
    "tile": 0.02,
    "glass": 0.04,
    "plaster": 0.04,
    "gypsum": 0.05,
    "brick": 0.04,
    "wood_floor": 0.07,
    "wood_panel": 0.10,
    "metal_deck": 0.10,
    "rubber_floor": 0.04,
    "vinyl": 0.03,
    "carpet": 0.35,
    "acoustic_tile": 0.70,
    "curtain": 0.50,
    "upholstered_seats": 0.75,
    "mixed_furnishing": 0.20,
}

# Finishes we assume for a space when we have no photo analysis:
# (floor, ceiling, walls, furnishing_share, label)
# furnishing_share is the fraction of floor area covered by sofas, beds,
# shelving and the like, which add absorption on top of the floor finish.
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
}

NAME_HINTS: list[tuple[tuple[str, ...], str]] = [
    (("theatre", "theater", "screening", "cinema", "auditorium"), "theater"),
    (("ballroom", "banquet", "meeting", "conference", "event", "board room", "boardroom"), "ballroom"),
    (("chapel", "church", "sanctuary", "worship"), "chapel"),
    (("lobby", "atrium", "foyer", "entry", "concierge"), "lobby"),
    (("rooftop", "roof deck", "sky deck", "terrace", "pool", "courtyard", "outdoor", "patio", "garden"), "rooftop"),
    (("clubhouse", "club room", "clubroom", "lounge", "game room", "resident", "amenity",
      "sky lounge", "social", "rec room", "community room", "leasing"), "clubhouse"),
    (("fitness", "gym", "yoga", "studio", "spin", "dance"), "fitness"),
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

# Target RT60 bands (seconds, occupied) for each intended use.
USES: dict[str, tuple[float, float, str]] = {
    "a_cappella_performance": (1.3, 2.0, "unamplified vocal ensemble performance"),
    "choral_performance": (1.6, 2.4, "choir / sacred music"),
    "rehearsal": (0.7, 1.2, "rehearsal (clarity to hear each part)"),
    "recording": (0.4, 0.8, "vocal recording"),
    "film_dialogue": (0.3, 0.6, "film / video with dialogue"),
    "amplified_show": (0.8, 1.3, "amplified show with a PA"),
}

PERSON_SABINS_M2 = 0.45  # absorption of one seated or standing person, mid band
MISC_ABSORPTION = 0.03   # doors, fixtures, signage and furniture not in the presets


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
    notes: list[str] = field(default_factory=list)
    assumptions: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "space_type": self.space_type,
            "space_label": self.space_label,
            "volume_m3": round(self.volume_m3, 1),
            "rt60_empty_s": round(self.rt60_empty, 2),
            "rt60_occupied_s": round(self.rt60_occupied, 2),
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


def _eyring(volume_m3: float, surface_m2: float, absorption_m2: float) -> float:
    a_mean = min(max(absorption_m2 / surface_m2, 0.01), 0.95)
    return 0.161 * volume_m3 / (-surface_m2 * math.log(1 - a_mean))


def estimate(
    geom: RoomGeometry,
    space_type: str,
    use: str = "a_cappella_performance",
    audience: int | None = None,
    materials: dict[str, str] | None = None,
) -> AcousticEstimate:
    """Estimate RT60 for one room and score it against the intended use."""
    floor_mat, ceil_mat, wall_mat, furnish, label = PRESETS.get(space_type, PRESETS["generic"])
    if materials:  # e.g. from photo analysis: {"floor": "carpet", ...}
        floor_mat = materials.get("floor", floor_mat)
        ceil_mat = materials.get("ceiling", ceil_mat)
        wall_mat = materials.get("walls", wall_mat)

    notes: list[str] = []
    height = geom.height_ft
    if not height or height < 6:
        height = 10.0 if space_type in ("ballroom", "lobby", "warehouse", "theater") else 9.0
        notes.append(f"Ceiling height not in scan; assumed {height:.0f} ft.")
    area_ft2 = max(geom.area_sqft, 1.0)
    if geom.width_ft and geom.depth_ft and geom.width_ft > 1 and geom.depth_ft > 1:
        perimeter_ft = 2 * (geom.width_ft + geom.depth_ft)
    else:
        perimeter_ft = 4 * math.sqrt(area_ft2) * 1.1  # irregular rooms run longer than a square

    floor_m2 = area_ft2 * SQFT
    wall_m2 = perimeter_ft * height * SQFT
    volume = area_ft2 * height * CUFT

    open_air = ceil_mat == "open"
    ceil_absorb = 1.0 if open_air else MATERIALS[ceil_mat]
    surface = 2 * floor_m2 + wall_m2
    absorption = (
        floor_m2 * (MATERIALS[floor_mat] * (1 - furnish) + MATERIALS["mixed_furnishing"] * furnish)
        + floor_m2 * ceil_absorb
        + wall_m2 * MATERIALS[wall_mat]
        + surface * MISC_ABSORPTION
    )

    capacity_standing = int(area_ft2 / 7)
    capacity_seated = int(area_ft2 / 12)
    crowd = audience if audience is not None else min(capacity_seated, 80)
    crowd = max(0, min(crowd, capacity_standing))

    rt_empty = _eyring(volume, surface, absorption)
    rt_occ = _eyring(volume, surface, absorption + crowd * PERSON_SABINS_M2)
    if open_air:
        notes.append("Open-air space: little reverberation, sound carries away; plan on light amplification.")

    lo, hi, use_label = USES.get(use, USES["a_cappella_performance"])
    score = _score(rt_occ, lo, hi)
    if volume < 60:
        score = min(score, 45)
        notes.append("Small room: low notes can boom and the group will sound crowded.")
    verdict = _verdict(rt_occ, lo, hi, use_label)

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
        verdict=verdict,
        notes=notes,
        assumptions={"floor": floor_mat, "ceiling": ceil_mat, "walls": wall_mat,
                     "furnishing_share": furnish, "height_ft": round(height, 1)},
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
        return f"Ideal for {use_label}: {rt:.1f}s sits inside the {lo:.1f}-{hi:.1f}s target."
    if rt < lo:
        gap = lo / rt
        if gap > 2:
            return f"Very dry ({rt:.1f}s) for {use_label}; voices will sound flat and need a PA."
        return f"A little dry ({rt:.1f}s vs {lo:.1f}s+) for {use_label}; usable, blend will feel tight."
    gap = rt / hi
    if gap > 1.6:
        return f"Very live ({rt:.1f}s) for {use_label}; words will smear. Add drapes or pick another room."
    return f"A little live ({rt:.1f}s vs <{hi:.1f}s) for {use_label}; slow tempos will bloom, fast lyrics blur."
