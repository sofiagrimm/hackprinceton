"""Checks on the lighting physics: sun geometry, window patches, the lux model, colour
temperature and exposure.

    python -m pytest tests/test_lighting.py
"""

from __future__ import annotations

import math
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app import daylight as dl  # noqa: E402
from app import photometry as ph  # noqa: E402

BOX = {"hx": 5.0, "hz": 6.0, "h": 3.0}


def wall(wid: str, cells: list[list[int]], box: dict = BOX) -> list[dict]:
    """A window list with cells only on one wall."""
    out = []
    for w in dl.WALLS:
        half = box["hz"] if w[1] == "x" else box["hx"]
        out.append({"id": w, "na": int(math.ceil(2 * half / dl.CELL)), "nh": int(math.ceil(box["h"] / dl.CELL)),
                    "cells": cells if w == wid else [], "area_m2": len(cells) * dl.CELL ** 2 if w == wid else 0})
    return out


# ----------------------------------------------------------------- sun geometry

def test_sun_vector_points_where_the_sun_is():
    # Room +z faces north (rotation 0); sun due south at 30 degrees up -> toward -z, and up.
    s = dl.sun_vector(30, 180, 0)
    assert s[1] == pytest.approx(0.5, abs=1e-9)
    assert s[2] < -0.8 and abs(s[0]) < 1e-9
    # Sun due east: +x points west when +z is north, so the sun is toward -x.
    assert dl.sun_vector(10, 90, 0)[0] < -0.9
    # Turning the room turns the sun the other way in room terms.
    assert np.allclose(dl.sun_vector(20, 100, 90), dl.sun_vector(20, 10, 0))


def test_wall_facing_matches_sun_vector():
    for rot in (0, 37, 200):
        for w, axis, sign in (("+x", 0, 1), ("-x", 0, -1), ("+z", 2, 1), ("-z", 2, -1)):
            facing = dl.wall_facing(w, rot)
            # A low sun straight out from that wall points along the wall's outward axis.
            s = dl.sun_vector(1, facing, rot)
            assert s[axis] * sign > 0.99


def test_noaa_noon_altitude_in_los_angeles():
    # Winter solstice, solar noon in LA (about 11:55am PST = 19:55 UTC): 90 - 34.05 - 23.44 = 32.5 degrees.
    alt, az = dl.sun_position(datetime(2026, 12, 21, 19, 55, tzinfo=timezone.utc), 34.05, -118.24)
    assert alt == pytest.approx(32.5, abs=1.0)
    assert az == pytest.approx(180, abs=5)


# ----------------------------------------------------------------- sun patches

def test_sun_patch_lands_where_geometry_says():
    # A window band on the +x wall from 1.0 m to 2.0 m high, along z in [-1, 1].
    na0 = int(round((-1 + BOX["hz"]) / dl.CELL))
    cells = [[a, h] for a in range(na0, na0 + 8) for h in range(4, 8)]
    windows = wall("+x", cells)
    # Sun straight out from the +x wall at 45 degrees: patch on the floor 1 to 2 m in from the wall.
    s = np.array([math.cos(math.pi / 4), math.sin(math.pi / 4), 0.0])
    xs = np.linspace(-4.9, 4.9, 99)
    pts = np.stack([xs, np.full_like(xs, 0.01), np.zeros_like(xs)], -1)
    lit = dl.sunlit(pts, s, windows, BOX, shaded={})
    lit_x = xs[lit]
    assert lit.any()
    assert lit_x.min() == pytest.approx(5 - 2.0, abs=0.15)
    assert lit_x.max() == pytest.approx(5 - 1.0, abs=0.15)
    # The same sun on the far side of the room sees no window: dark.
    assert not dl.sunlit(pts, -s * np.array([1, -1, 1]), windows, BOX, shaded={}).any()
    # A neighbour shading that wall puts the patch out.
    assert not dl.sunlit(pts, s, windows, BOX, shaded={"+x": True}).any()


def test_detect_windows_finds_a_bright_band():
    """A synthetic panorama: grey walls, with a white band on the +z wall at 1-2 m."""
    box = {"hx": 4.0, "hz": 4.0, "h": 3.0}
    faces = {}
    for slot in range(6):
        d = dl.cube_dirs(slot, 96)
        p, code = dl.box_hit(d, box)
        img = np.full(d.shape, 0.45, np.float32)
        band = (code == 2) & (p[..., 1] > 1.0) & (p[..., 1] < 2.0) & (np.abs(p[..., 0]) < 1.5)
        img[band] = 0.95
        faces[slot] = img
    found = {w["id"]: w for w in dl.detect_windows(faces, box)}
    assert found["+z"]["area_m2"] == pytest.approx(3.0 * 1.0, rel=0.3)
    assert found["+x"]["area_m2"] == 0 and found["-z"]["area_m2"] == 0


# ----------------------------------------------------------------- lux model

def test_clear_sky_levels_are_realistic():
    edn, edh = dl.clear_sky(90)
    assert 95_000 < edn < 115_000      # direct beam, high sun
    assert 14_000 < edh < 18_000       # clear-sky diffuse
    assert dl.clear_sky(-1) == (0.0, 0.0)
    assert dl.clear_sky(5)[0] < dl.clear_sky(30)[0]


def test_floor_light_falls_off_from_a_window():
    na0 = int(round((-1 + BOX["hz"]) / dl.CELL))
    windows = wall("+x", [[a, h] for a in range(na0, na0 + 8) for h in range(4, 10)])
    grid = dl.floor_grid(BOX, cell=0.5)
    fac = dl.diffuse_factors(grid, dl.window_cells_world(windows, BOX))["+x"]
    mid = grid["nz"] // 2
    row = fac[mid]
    assert row[-1] > row[len(row) // 2] > row[0] > 0   # brightest near the window wall (+x end)
    # Daylight-factor sanity: a 3 m^2 window gives a few percent of outside light near it.
    assert 0.005 < dl.TAU * row[-2] < 0.2


def test_lux_encoding_round_trips():
    lux = np.array([0, 5, 120, 300, 2500, 40000], float)
    back = dl.decode_lux(dl.encode_lux(lux))
    assert np.all(np.abs(back - lux) <= np.maximum(2, lux * 0.07))


def test_ray_blocker_finds_the_tall_building():
    tall = {"poly": [(-10, 40), (10, 40), (10, 60), (-10, 60)], "height_m": 40, "ground_m": 0, "name": "Tower", "floors": 11,
            "centroid": (0, 50)}
    low = {"poly": [(-10, 20), (10, 20), (10, 30), (-10, 30)], "height_m": 3, "ground_m": 0, "name": "Shed", "floors": 1,
           "centroid": (0, 25)}
    # Sun due north (az 0) at 30 degrees: at 40 m the ray is 1.5 + 23 m up, under the tower's 40 m.
    blk = dl.ray_blocker((0, 0, 1.5), 30, 0, [low, tall])
    assert blk and blk["name"] == "Tower"
    # High sun clears it; sun to the south misses it entirely.
    assert dl.ray_blocker((0, 0, 1.5), 60, 0, [low, tall]) is None
    assert dl.ray_blocker((0, 0, 1.5), 30, 180, [low, tall]) is None


def test_floor_height_from_room_name():
    assert dl.room_floor_height("Rooftop Lounge Interior", 60)[0] == pytest.approx(55.5)
    assert dl.room_floor_height("Level 3 Club Room", 60)[0] == pytest.approx(2 * 12 * 0.3048)
    assert dl.room_floor_height("Lobby", 60)[0] == 0


# ----------------------------------------------------------------- photometry

def test_kelvin_to_rgb():
    assert ph.kelvin_rgb(6600) == pytest.approx((255, 255, 255), abs=3)
    r, g, b = ph.kelvin_rgb(2000)
    assert r == 255 and r > g > b               # candle orange
    r, g, b = ph.kelvin_rgb(10000)
    assert b == 255 and b > r                    # cold blue sky


def test_spot_intensity_and_inverse_square():
    bulb = ph.intensity_cd(1000, None)
    assert bulb == pytest.approx(1000 / (4 * math.pi))
    spot = ph.intensity_cd(1000, 15)
    assert spot > 10 * bulb                      # a narrow beam concentrates the same lumens
    assert ph.illuminance(spot, 4, 1) == pytest.approx(spot / 16)
    assert ph.illuminance(spot, 4, 0.5) == pytest.approx(spot / 32)


def test_exposure_matches_the_meter_equation():
    # 250 lux at ISO 100 with C = 250 is EV 6.64 (log2 100).
    assert ph.ev100(250) == pytest.approx(math.log2(100))
    # Each stop of light halves the shutter time.
    assert ph.shutter(800) == pytest.approx(ph.shutter(400) / 2)
    # A bright stage at 500 lux (EV100 7.6), ISO 800, f/2.8: about 1/200 s.
    assert ph.shutter(500) == pytest.approx(2.8 ** 2 / 2 ** (math.log2(200) + 3))
    assert 1 / 250 < ph.shutter(500) < 1 / 160
    # ISO needed for 24 fps at 1/48 s: brighter light, lower ISO.
    assert ph.iso_for(1000) < ph.iso_for(200)
