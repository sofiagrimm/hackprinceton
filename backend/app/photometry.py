"""Photometry for the lighting lab (the browser has the same formulas in lightlab.js).

- Colour temperature to RGB: Tanner Helland's fit to the Planckian locus (1000 K to 40000 K).
- Luminous intensity: an even bulb spreads its lumens over 4 pi steradians; a spot or uplight
  over its cone, 2 pi (1 - cos half-angle).
- Illuminance: E = I cos(incidence) / d^2 (inverse square, Lambert cosine).
- Exposure from an incident-light reading: EV100 = log2(E x 100 / C) with the meter
  calibration constant C = 250 (flat-disc incident meters, ISO 2720). At ISO S,
  EV = EV100 + log2(S / 100), and the shutter time is t = N^2 / 2^EV.
"""

from __future__ import annotations

import math

C_INCIDENT = 250.0


def kelvin_rgb(k: float) -> tuple[int, int, int]:
    t = max(1000.0, min(40000.0, k)) / 100
    if t <= 66:
        r = 255.0
        g = 99.4708025861 * math.log(t) - 161.1195681661
        b = 0.0 if t <= 19 else 138.5177312231 * math.log(t - 10) - 305.0447927307
    else:
        r = 329.698727446 * (t - 60) ** -0.1332047592
        g = 288.1221695283 * (t - 60) ** -0.0755148492
        b = 255.0

    def c(v: float) -> int:
        return int(max(0, min(255, round(v))))
    return c(r), c(g), c(b)


def intensity_cd(lumens: float, half_angle_deg: float | None) -> float:
    if not half_angle_deg or half_angle_deg >= 180:
        return lumens / (4 * math.pi)
    return lumens / (2 * math.pi * (1 - math.cos(math.radians(half_angle_deg))))


def illuminance(intensity: float, distance_m: float, cos_incidence: float) -> float:
    return intensity * max(0.0, cos_incidence) / max(distance_m, 0.1) ** 2


def ev100(lux: float) -> float:
    return math.log2(max(lux, 1e-6) * 100 / C_INCIDENT)


def shutter(lux: float, iso: float = 800, f_number: float = 2.8) -> float:
    """Shutter time in seconds for a correct exposure."""
    ev = ev100(lux) + math.log2(iso / 100)
    return f_number ** 2 / 2 ** ev


def iso_for(lux: float, shutter_s: float = 1 / 48, f_number: float = 2.8) -> float:
    """ISO needed at a given shutter and aperture (24 fps with a 180 degree shutter is 1/48 s)."""
    ev_needed = math.log2(f_number ** 2 / shutter_s)
    return 100 * 2 ** (ev_needed - ev100(lux))
