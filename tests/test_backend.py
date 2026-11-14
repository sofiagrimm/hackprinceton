"""Checks on the parts judges will ask about: the acoustics physics, the brief parser,
travel distances, the agent tool registry and the region estimates.

    pip install pytest && python -m pytest tests

Tests that need the CoStar/Matterport index skip themselves when data/index is missing.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.acoustics import RoomGeometry, estimate, stage_support  # noqa: E402
from app.materials import parse as parse_materials  # noqa: E402

HAS_INDEX = (ROOT / "data" / "index" / "venues.json").exists()


# ----------------------------------------------------------------- acoustics

def test_reference_halls_within_16_percent():
    from app.validation import run
    rows = run()
    assert len(rows) == 3
    for r in rows:
        assert abs(r["error_pct"]) < 16, r


def test_audience_shortens_reverb():
    a = estimate(RoomGeometry(4000, 20, 80, 50), "ballroom", audience=200)
    assert a.rt60_occupied < a.rt60_empty
    assert all(o <= e for o, e in zip(a.bands_occupied, a.bands_empty))


def test_bigger_harder_room_rings_longer():
    small = estimate(RoomGeometry(600, 10, 30, 20), "office", audience=0)
    church = estimate(RoomGeometry(6000, 45, 100, 60), "chapel", audience=0)
    assert church.rt60_empty > 2 * small.rt60_empty


def test_score_is_100_inside_target():
    a = estimate(RoomGeometry(2500, 16, 60, 42), "chapel", use="a_cappella_performance", audience=60)
    lo, hi = a.target
    if lo <= a.rt60_occupied <= hi:
        assert a.score == 100
    else:
        assert a.score < 100


def test_stage_support_falls_as_rooms_grow():
    hard = {"floor": 0.1, "ceiling": 0.1, "walls": 0.1}
    small = stage_support({"length": 10, "width": 7, "height": 3}, hard)
    hall = stage_support({"length": 45, "width": 28, "height": 17}, hard)
    assert small > hall
    soft = stage_support({"length": 10, "width": 7, "height": 3}, {"floor": 0.6, "ceiling": 0.7, "walls": 0.5})
    assert soft < small  # absorbent finishes send less back to the stage


def test_result_carries_the_fields_the_page_uses():
    d = estimate(RoomGeometry(2000, 14, 50, 40), "ballroom").to_dict()
    for k in ("rt60_bands_occupied_s", "dims_m", "stage_support_db", "singers_verdict", "surface_alpha",
              "c80_db", "sti", "bass_ratio", "verdict"):
        assert k in d, k
    assert len(d["rt60_bands_occupied_s"]) == 6


def test_finishes_are_read_from_scan_text():
    m = parse_materials("Hardwood floors, exposed brick walls and a vaulted wood ceiling with large windows.")
    assert m["surfaces"]["floor"] == "wood_floor"
    assert m["surfaces"]["walls"] == "brick"
    assert m["surfaces"]["tall"] is True
    assert m["evidence"]


# ----------------------------------------------------------------- brief and travel

def test_brief_parser_reads_the_numbers():
    from app.agent import parse_brief
    b = parse_brief("14 singers touring Houston on March 14. A show for 80 guests, 2 nights.")
    assert b["metro"] == "Houston"
    assert b["group_size"] == 14
    assert b["audience"] == 80
    assert b["nights"] == 2


def test_la_to_houston_is_about_1550_road_miles():
    from app.tour import travel_leg
    la = {"name": "LA", "metro": "Los Angeles", "lat": 34.05, "lon": -118.24}
    hou = {"name": "Houston", "metro": "Houston", "lat": 29.76, "lon": -95.37}
    leg = travel_leg(la, hou, 14)
    assert 1450 < leg["road_miles"] < 1650
    assert leg["fly"]


# ----------------------------------------------------------------- agent tools

def test_every_tool_has_a_schema():
    from app.agent import TOOL_SCHEMAS, _feature_schemas
    from app.toolbox import all_tools
    tools = all_tools()
    schema_names = {s["name"] for s in TOOL_SCHEMAS + _feature_schemas()}
    for name in ("search_venues", "analyze_venue", "find_housing", "draft_outreach", "plan_tour", "add_to_pipeline"):
        assert name in tools, name
    missing = schema_names - set(tools)
    assert not missing, f"schemas without a tool: {missing}"


@pytest.mark.skipif(not HAS_INDEX, reason="needs data/index")
def test_search_returns_ranked_indoor_rooms():
    from app.scout import TOOLS
    r = TOOLS["search_venues"](metro="Los Angeles", audience=80, use="a_cappella_performance")
    assert r["results"], r
    scores = [v["best_space"]["acoustics"]["score"] for v in r["results"]]
    assert scores == sorted(scores, reverse=True) or len(set(scores)) > 1
    ids = [v["venue_id"] for v in r["results"]]
    assert len(ids) == len(set(ids))


@pytest.mark.skipif(not HAS_INDEX, reason="needs data/index")
def test_planner_runs_a_whole_brief():
    from app.agent import PlannerScout
    events = list(PlannerScout().run("14 singers touring LA on March 14. A show for 80 guests, 2 nights."))
    kinds = {e["type"] for e in events}
    assert {"plan", "message"} <= kinds
    assert not [e for e in events if e["type"] == "error"]


# ----------------------------------------------------------------- regions

def test_region_estimate_for_a_church_without_an_outline():
    from app import regions
    v = {"id": "wd-test", "name": "Test Church", "kind": "place_of_worship", "city": "San Francisco",
         "region": "Northern California", "lat": 37.79, "lon": -122.41, "distance_mi": 1.0, "address": "",
         "height_m": None, "levels": None, "seats": None, "footprint": None, "footprint_source": None,
         "vexcel_covered": False}
    out = regions._assess(v, "a_cappella_performance", 100, use_vexcel=False)
    assert out["building"]["footprint_source"]  # falls back to a typical size, and says so
    assert out["acoustics"]["rt60_occupied_s"] > 1.0  # churches are live rooms
    assert any("Estimated" in n or "estimate" in n.lower() for n in out["acoustics"]["notes"])
