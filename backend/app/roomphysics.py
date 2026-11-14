"""Three more things a room's shape and finishes tell us.

1. Room modes: which notes boom. Below the Schroeder frequency a room's sound is
   ruled by its standing waves, at f = (c/2) * sqrt((nx/L)^2 + (ny/W)^2 + (nz/H)^2).
   Axial modes (one non-zero index) are the strongest, tangential ones about half as
   strong, oblique ones about a quarter. Where several land close together, or an
   axial mode sits alone, a sung note at that pitch rings louder than its neighbours.
   We report the strongest of these as note names, with the voice parts that sing them.

2. Uncertainty. A scan gives the room's size, not its exact finishes, so we rerun the
   reverberation model a few hundred times with each surface's absorption, the
   ceiling height (when it was assumed) and the audience absorption varied within
   believable limits, and report the middle 80 % of results.

3. Treatment. How much curtain, rug or panel brings an over-live room into its target
   band, solved octave by octave with the same Eyring model; and what to take out when
   a room is too dry.
"""

from __future__ import annotations

import math
import random

from .acoustics import ABSORPTION, AIR_M, BANDS, _eyring

C = 343.0
NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
# Comfortable ranges (Hz) for each part, roughly E2-E4, C3-A4, F3-D5, C4-A5.
VOICES = [("bass", 82, 330), ("tenor", 131, 440), ("alto", 175, 587), ("soprano", 262, 880)]


def note_of(f: float) -> tuple[str, int]:
    """Nearest equal-tempered note name (with octave) and the offset in cents."""
    midi = 69 + 12 * math.log2(f / 440.0)
    n = round(midi)
    return f"{NOTE_NAMES[n % 12]}{n // 12 - 1}", round((midi - n) * 100)


def schroeder_hz(rt60: float, volume_m3: float) -> float:
    return 2000.0 * math.sqrt(max(rt60, 0.05) / max(volume_m3, 1.0))


def room_modes(dims: dict, rt60: float, fmax: float = 400.0, limit: int = 6) -> dict:
    """Standing waves of a shoebox room and the sung notes they make boom."""
    L, W, H = max(dims["length"], 1.0), max(dims["width"], 1.0), max(dims["height"], 1.0)
    fs = schroeder_hz(rt60, L * W * H)
    top = min(fmax, max(fs, 60.0))
    modes = []
    for nx in range(0, int(2 * top * L / C) + 2):
        for ny in range(0, int(2 * top * W / C) + 2):
            for nz in range(0, int(2 * top * H / C) + 2):
                if nx == ny == nz == 0:
                    continue
                f = (C / 2) * math.sqrt((nx / L) ** 2 + (ny / W) ** 2 + (nz / H) ** 2)
                if f > top:
                    continue
                kind = 3 - [nx, ny, nz].count(0)  # 1 axial, 2 tangential, 3 oblique
                modes.append({"f": f, "n": (nx, ny, nz), "kind": ("axial", "tangential", "oblique")[kind - 1],
                              "weight": (1.0, 0.5, 0.25)[kind - 1]})
    modes.sort(key=lambda m: m["f"])

    # Strength of each pitch: modes within a quarter-tone of each other add up.
    clusters = []
    for m in modes:
        if clusters and m["f"] / clusters[-1]["modes"][0]["f"] < 2 ** (0.5 / 12):
            clusters[-1]["modes"].append(m)
        else:
            clusters.append({"modes": [m]})
    lowest_voice = VOICES[0][1]
    boom = []
    for c in clusters:
        f = sum(m["f"] * m["weight"] for m in c["modes"]) / sum(m["weight"] for m in c["modes"])
        strength = sum(m["weight"] for m in c["modes"])
        if f < lowest_voice * 0.99 or f > fs:
            continue  # below anyone's voice, or above where single modes still matter
        name, cents = note_of(f)
        parts = [v for v, lo, hi in VOICES if lo <= f <= hi]
        # How much this pitch stands out: its weighted mode count against what a quarter-tone
        # band at this frequency holds on average (Weyl's modal density for a box room).
        df = f * (2 ** (1 / 24) - 2 ** (-1 / 24))
        V, S, Ltot = L * W * H, 2 * (L * W + L * H + W * H), 4 * (L + W + H)
        expected = (4 * math.pi * V * f ** 2 / C ** 3 + math.pi * S * f / (2 * C ** 2) + Ltot / (8 * C)) * df * 0.45
        strength = strength / max(expected, 0.6)
        lead = max(c["modes"], key=lambda m: m["weight"])
        boom.append({"hz": round(f, 1), "note": name, "cents": cents, "parts": parts,
                     "strength": round(strength, 2), "modes": len(c["modes"]),
                     "shape": list(lead["n"]), "kind": lead["kind"]})
    boom = [b for b in boom if b["strength"] >= 1.0]   # only pitches clearly above their neighbours
    boom.sort(key=lambda b: (-b["strength"], b["hz"]))
    boom = sorted(boom[:limit], key=lambda b: b["hz"])

    if not boom:
        summary = ("No single note should boom. " + (
            f"Above about {round(fs)} Hz the room's resonances overlap so densely that every pitch is treated "
            "evenly, and below that none of them stands out much from its neighbours."))
    else:
        worst = max(boom, key=lambda b: b["strength"])
        ps = worst["parts"] or ["low voices"]
        who = ps[0] if len(ps) == 1 else ", ".join(ps[:-1]) + " and " + ps[-1]
        summary = (f"In the empty room, the {who} may hear {worst['note']} ({worst['hz']} Hz) ring louder than the "
                   f"notes around it, because the room's own resonances sit there. Below about {round(fs)} Hz single "
                   "resonances stand out; above it the room treats every pitch evenly.")
    return {
        "schroeder_hz": round(fs, 1),
        "modes_below_schroeder": sum(1 for m in modes if m["f"] <= fs),
        "lowest_mode_hz": round(modes[0]["f"], 1) if modes else None,
        "booming_notes": boom,
        "summary": summary,
        "method": "Rectangular-room standing waves (Rayleigh), Schroeder frequency 2000*sqrt(T/V).",
    }


# --------------------------------------------------------------------------- uncertainty

def rt_uncertainty(volume: float, surface: float, parts: list[dict], target: tuple[float, float],
                   height_assumed: bool, samples: int = 400, seed: int = 7) -> dict:
    """Spread of the occupied mid-band RT60 when finishes and height are uncertain.

    parts: per band dicts {floor, ceiling, walls, misc, people} of absorption area (m^2 sabins)
    for the 500 Hz and 1 kHz bands (index 2 and 3 of BANDS).
    """
    rng = random.Random(seed)
    out = []
    for _ in range(samples):
        jf, jc, jw = (math.exp(rng.gauss(0, 0.30)) for _ in range(3))   # finishes: about +/- 35 %
        jp = math.exp(rng.gauss(0, 0.15))                                 # audience clothing, seating
        jh = math.exp(rng.gauss(0, 0.18 if height_assumed else 0.03))    # ceiling height
        V = volume * jh
        S = surface + (jh - 1) * (surface - 0) * 0.35                     # walls grow with height
        rts = []
        for b, p in zip((2, 3), parts):
            A = p["floor"] * jf + p["ceiling"] * jc + p["walls"] * jw * (1 + (jh - 1) * 0.9) + p["misc"] + p["people"] * jp
            rts.append(_eyring(V, S, A, AIR_M[b]))
        out.append(sum(rts) / 2)
    out.sort()
    q = lambda p: out[min(len(out) - 1, int(p * len(out)))]
    lo, hi = target
    inside = sum(1 for r in out if lo <= r <= hi) / len(out)
    return {"p10": round(q(0.10), 2), "p50": round(q(0.50), 2), "p90": round(q(0.90), 2),
            "in_target": round(inside, 2), "samples": samples,
            "varied": "each surface's absorption (about +/-35%), audience absorption (+/-15%)"
                      + (", ceiling height (+/-18%, it wasn't in the scan)" if height_assumed else "")}


# --------------------------------------------------------------------------- treatment

TREATMENTS = [
    # key, label, absorption table, where it goes, how much fits (share of the relevant area)
    ("curtain", "heavy curtains", ABSORPTION["curtain"], "walls", 0.5),
    ("carpet", "rugs or carpet runners", ABSORPTION["carpet"], "floor", 0.6),
    ("acoustic_tile", "acoustic panels", ABSORPTION["acoustic_tile"], "walls", 0.35),
]


def _rt_bands(volume: float, surface: float, absorption: list[float]) -> list[float]:
    return [_eyring(volume, surface, absorption[i], AIR_M[i]) for i in range(len(BANDS))]


def treatment_plan(a: dict) -> dict:
    """What to add or take away so the occupied mid-band RT60 lands in the target band.

    Works from an acoustics result (to_dict): volume, surface, band RT60s and target.
    The absorption already in the room is recovered by inverting Eyring per band.
    """
    V, S = a["volume_m3"], a["surface_m2"]
    bands = a["rt60_bands_occupied_s"]
    lo, hi = a["target_s"]
    rt = a["rt60_occupied_s"]
    if a.get("assumptions", {}).get("ceiling") == "open":
        return {"status": "open_air", "summary": "Open-air space: curtains won't help. Plan on light amplification."}

    def absorption_for(t: float, i: int) -> float:
        # invert Eyring for the existing absorption area in band i
        a_mean = 1 - math.exp(-(0.161 * V / t - 4 * AIR_M[i] * V) / S)
        return S * min(max(a_mean, 0.01), 0.95)

    base = [absorption_for(t, i) for i, t in enumerate(bands)]
    dims = a.get("dims_m") or {}
    floor_m2 = dims.get("length", 10) * dims.get("width", 8)
    wall_m2 = 2 * (dims.get("length", 10) + dims.get("width", 8)) * dims.get("height", 3)
    goal = (lo + hi) / 2

    if lo <= rt <= hi:
        return {"status": "in_range", "rt60_s": rt, "target_s": [lo, hi],
                "summary": f"No changes needed. {rt} s with the audience in is inside the {lo} to {hi} s target."}

    if rt < lo:
        # Too dry: the only free lever is taking soft things out (or a smaller audience area).
        soft = a.get("assumptions", {}).get("furnishing_share", 0)
        return {"status": "too_dry", "rt60_s": rt, "target_s": [lo, hi], "options": [],
                "summary": (f"{rt} s is drier than the {lo} to {hi} s target. Curtains can't add reverb. "
                            + ("Ask whether the sofas and rugs can come out for the evening. Otherwise, pick "
                               if soft > 0.1 else "Pick ")
                            + "a room with harder surfaces or a higher ceiling, "
                              "or stand the group close to a hard back wall so they hear each other.")}

    options = []
    for key, label, alpha, where, share in TREATMENTS:
        cap = (wall_m2 if where == "walls" else floor_m2) * share

        def mid_rt(area):
            r = _rt_bands(V, S, [base[i] + area * alpha[i] for i in range(len(BANDS))])
            return (r[2] + r[3]) / 2

        if mid_rt(cap) > hi:
            area, enough = cap, False
        else:
            lo_a, hi_a = 0.0, cap
            for _ in range(40):  # bisection for the area that lands on the middle of the target
                mid_a = (lo_a + hi_a) / 2
                if mid_rt(mid_a) > goal:
                    lo_a = mid_a
                else:
                    hi_a = mid_a
            area, enough = hi_a, True
        after = _rt_bands(V, S, [base[i] + area * alpha[i] for i in range(len(BANDS))])
        options.append({
            "treatment": key, "label": label, "where": where,
            "area_m2": round(area, 1), "area_sqft": round(area * 10.764),
            "rt60_after_s": round((after[2] + after[3]) / 2, 2),
            "bands_after_s": [round(x, 2) for x in after],
            "enough": enough,
        })
    options.sort(key=lambda o: (not o["enough"], o["area_m2"]))
    best = options[0]
    if best["enough"]:
        summary = (f"{rt} s is livelier than the {lo} to {hi} s target. About {best['area_sqft']:,} sq ft of "
                   f"{best['label']} on the {best['where']} would bring it to {best['rt60_after_s']} s.")
        other = next((o for o in options[1:] if o["enough"]), None)
        if other:
            summary += f" {other['label'].capitalize()} would need about {other['area_sqft']:,} sq ft."
    else:
        summary = (f"{rt} s is well above the {lo} to {hi} s target, and even covering half the walls in "
                   f"{best['label']} only brings it to {best['rt60_after_s']} s. This room suits slow, sustained "
                   "music better than fast lyrics.")
    return {"status": "too_live", "rt60_s": rt, "target_s": [lo, hi], "options": options, "summary": summary,
            "method": "Existing absorption recovered per octave by inverting Eyring; added area solved by bisection."}


# --------------------------------------------------------------------------- agent tool

def plan_room(venue_id: int, use: str = "a_cappella_performance", audience: int = 60) -> dict:
    """Fix-it plan for a venue's best room: what to add or remove to hit the target reverb,
    which notes the empty room makes boom, and how sure the reverb estimate is."""
    from .scout import analyze_venue
    v = analyze_venue(venue_id, use=use, audience=audience)
    if v.get("error") or not v.get("spaces"):
        return {"error": v.get("error") or "No measurable room at this venue."}
    s = v["spaces"][0]
    a = s["acoustics"]
    return {
        "venue_id": venue_id, "name": v.get("name"), "room": s.get("space_name"),
        "rt60_occupied_s": a["rt60_occupied_s"], "rt60_likely_range_s": a.get("rt60_range_s"),
        "chance_in_target": (a.get("uncertainty") or {}).get("in_target"),
        "target_s": a["target_s"],
        "treatment": a.get("treatment"),
        "booming_notes": (a.get("modes") or {}).get("booming_notes"),
        "resonance_summary": (a.get("modes") or {}).get("summary"),
    }


TOOLS = {"plan_room": plan_room}
TOOL_SCHEMAS = [{
    "name": "plan_room",
    "description": "For a venue's best room: how many sq ft of curtains, rugs or panels would bring the reverb into "
                   "the target (or what to take out if it's too dry), which sung notes the empty room makes boom, "
                   "and the likely range of the reverb estimate. Use it after picking a venue whose reverb is "
                   "outside the target, or when the group has low basses.",
    "input_schema": {"type": "object", "properties": {
        "venue_id": {"type": "integer"},
        "use": {"type": "string", "description": "a_cappella_performance, choral_performance, rehearsal, recording, film_dialogue or amplified_show"},
        "audience": {"type": "integer"}},
        "required": ["venue_id"]},
}]
