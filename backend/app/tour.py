"""Whole-tour planner: several shows in several cities, one plan.

A brief like "Our 14 singers want to do 3 shows: LA March 14, LA March 16,
Houston March 20. About 80 guests each, budget $6,000." becomes a list of stops.
For each stop we use the scout's own tools (search_venues, analyze_venue,
find_housing) to pick a room and a bed, never booking the same venue twice,
then add the travel between stops and total the lot.

Plans are saved to data/cache/tours/{id}.json so the group can open the same
link, vote on each stop's venue or its backup, and the treasurer can collect
dues for the whole tour through the Nessie sandbox (app.treasury).

Events streamed by /api/tour match /api/scout:
  {"type": "plan" | "message", "text": ...}
  {"type": "tool", "name": ..., "input": {...}}
  {"type": "tool_result", "name": ..., "result": {...}}
  {"type": "stop", "index": i, "stop": {...}}
  {"type": "leg", "index": i, "leg": {...}}
  {"type": "tour", "plan": {...}}
  {"type": "done"}
"""

from __future__ import annotations

import json
import math
import re
import secrets
import threading
from datetime import date, datetime
from typing import Iterator

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from . import data, scout
from .agent import parse_brief
from .config import CACHE_DIR

TOURS_DIR = CACHE_DIR / "tours"
TOURS_DIR.mkdir(parents=True, exist_ok=True)
_lock = threading.Lock()

ROAD_FACTOR = 1.25        # straight line to road miles
DRIVE_MPH = 55
FLY_OVER_MILES = 600      # road miles beyond which the group should fly
VAN_SEATS = 12
VAN_COST_PER_MILE = 0.70  # rental share plus fuel, per van
VAN_DAY_RATE = 120        # a 12-passenger van for a travel day

MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
CITY_RE = r"(los angeles|l\.a\.|hollywood|houston|htx|\bla\b)"
DATE_RE = r"((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2})(?:st|nd|rd|th)?"
AIRPORTS = {"Los Angeles": "LAX", "Houston": "IAH"}


# --------------------------------------------------------------------------- parsing

def _to_date(text: str, today: date | None = None) -> date | None:
    m = re.match(r"([a-z]+)\.?\s+(\d{1,2})", text.lower())
    if not m or m.group(1)[:3] not in MONTHS:
        return None
    today = today or date.today()
    month, day = MONTHS.index(m.group(1)[:3]) + 1, int(m.group(2))
    try:
        d = date(today.year, month, day)
        return d if d >= today else date(today.year + 1, month, day)
    except ValueError:
        return None


def parse_tour_brief(text: str, today: date | None = None) -> dict:
    """Pull the group, the budget and an ordered list of stops out of a free-text tour brief."""
    base = parse_brief(text)
    t = text.lower()

    budget = None
    m = re.search(r"budget\D{0,12}\$?\s*([\d,]+(?:\.\d+)?)\s*(k)?", t) or \
        re.search(r"\$\s*([\d,]+(?:\.\d+)?)\s*(k)?", t)
    if m:
        budget = float(m.group(1).replace(",", "")) * (1000 if m.group(2) else 1)

    # Pair each date with the city named closest before it (or, failing that, after it).
    cities = [(m.start(), "Houston" if m.group(1) in ("houston", "htx") else "Los Angeles")
              for m in re.finditer(CITY_RE, t)]
    stops = []
    for m in re.finditer(DATE_RE, t):
        before = [c for c in cities if c[0] < m.start()]
        after = [c for c in cities if c[0] > m.end()]
        city = before[-1][1] if before else (after[0][1] if after else base["metro"])
        d = _to_date(m.group(1), today)
        if d:
            stops.append({"city": city, "date": d.isoformat(), "audience": base["audience"]})
    if not stops:  # no dates: one show per city mentioned, in order
        seen = []
        for _, city in cities:
            if not seen or seen[-1] != city:
                seen.append(city)
        stops = [{"city": c, "date": "", "audience": base["audience"]} for c in (seen or [base["metro"]])]
    stops.sort(key=lambda s: s["date"] or "9999")

    # Nights at each stop: the days until the next show, less a travel day for a flight; one night at the end.
    for i, stop in enumerate(stops):
        nxt = stops[i + 1] if i + 1 < len(stops) else None
        if nxt and stop["date"] and nxt["date"]:
            gap = (date.fromisoformat(nxt["date"]) - date.fromisoformat(stop["date"])).days
            travel_day = 1 if nxt["city"] != stop["city"] else 0
            stop["nights"] = max(1, min(gap - travel_day, 6))
        else:
            stop["nights"] = 1 if nxt is None else 2
    return {"group_size": base["group_size"], "audience": base["audience"], "use": base["use"],
            "budget": budget, "stops": stops}


# --------------------------------------------------------------------------- travel

def travel_leg(a: dict, b: dict, group_size: int) -> dict:
    """Driving distance and time between two venues, and whether the group should fly instead."""
    straight = data.miles_between(a["lat"], a["lon"], b["lat"], b["lon"])
    road = straight * ROAD_FACTOR
    hours = road / DRIVE_MPH
    vans = math.ceil(group_size / VAN_SEATS)
    leg = {
        "from": a["name"], "to": b["name"],
        "from_city": a["metro"], "to_city": b["metro"],
        "road_miles": round(road), "drive_hours": round(hours, 1),
        "vans": vans, "fly": road > FLY_OVER_MILES,
    }
    if leg["fly"]:
        fare = round(60 + 0.11 * straight, -1)  # rough one-way economy fare for this distance
        bags = 35  # one checked bag, people sing with their gear
        ground = vans * VAN_DAY_RATE * 2  # a van at each end
        leg.update({
            "mode": "fly",
            "airports": f"{AIRPORTS.get(a['metro'], '')} to {AIRPORTS.get(b['metro'], '')}".strip(),
            "fare_per_person": fare,
            "cost": round((fare + bags) * group_size + ground),
            "why": (f"{leg['road_miles']:,} miles by road is about {round(hours)} hours behind the wheel, "
                    f"so fly. About ${fare:,.0f} a person plus a bag, and a van at each end."),
        })
    else:
        cost = vans * road * VAN_COST_PER_MILE + (vans * VAN_DAY_RATE if road > 60 else 0)
        leg.update({
            "mode": "drive",
            "cost": round(cost),
            "why": (f"{_miles(road)} by road, about {_duration(hours)} in "
                    f"{vans} van{'s' if vans > 1 else ''}."),
        })
    return leg


def _miles(m: float) -> str:
    return "Under a mile" if m < 1 else f"{round(m):,} miles"


def _duration(hours: float) -> str:
    mins = round(hours * 60)
    if mins < 60:
        return f"{max(mins, 5)} minutes"
    h, mm = divmod(mins, 60)
    return f"{h} hour{'s' if h > 1 else ''}" + (f" {mm} minutes" if mm >= 5 else "")


# --------------------------------------------------------------------------- planning

def _call(name: str, fn, args: dict):
    yield {"type": "tool", "name": name, "input": args}
    try:
        result = fn(**args)
    except Exception as exc:  # keep the stream alive
        result = {"error": f"{type(exc).__name__}: {exc}"}
    yield {"type": "tool_result", "name": name, "result": result}
    return result


def _short_space(space: dict | None, venue_name: str) -> str | None:
    if not space:
        return None
    name = space["space_name"]
    if name.lower().startswith(venue_name.lower()):
        name = name[len(venue_name):].lstrip(" -:") or name
    return name


def _venue_summary(card: dict) -> dict:
    best = card.get("best_space") or {}
    a = best.get("acoustics") or {}
    return {
        "venue_id": card["venue_id"], "name": card["name"], "address": card["address"],
        "metro": card["metro"], "lat": card["lat"], "lon": card["lon"], "photo": card.get("photo"),
        "space": _short_space(best, card["name"]), "area_sqft": best.get("area_sqft"),
        "rt60_occupied_s": a.get("rt60_occupied_s"), "rt60_empty_s": a.get("rt60_empty_s"),
        "verdict": a.get("verdict"), "capacity_seated": a.get("capacity_seated"),
        "match_score": card.get("match_score"),
    }


def plan_tour_events(brief_text: str) -> Iterator[dict]:
    from .treasury import venue_fee_estimate

    brief = parse_tour_brief(brief_text)
    stops_in = brief["stops"]
    group = brief["group_size"]
    where = ", ".join(f"{s['city']}{' ' + _nice_date(s['date']) if s['date'] else ''}" for s in stops_in)
    yield {"type": "plan", "text": (
        f"{group} singers, {len(stops_in)} show{'s' if len(stops_in) > 1 else ''}: {where}. "
        "For each stop I'll rank the scanned rooms, measure the best one, find beds nearby, "
        "then work out how you get from one stop to the next.")}

    used: set[int] = set()
    searches: dict[tuple, dict] = {}
    stops, legs = [], []
    for i, s in enumerate(stops_in):
        key = (s["city"], s["audience"])
        if key not in searches:
            searches[key] = yield from _call("search_venues", scout.search_venues, {
                "metro": s["city"], "audience": s["audience"], "use": brief["use"], "max_results": 12})
        found = [c for c in searches[key].get("results") or [] if c["venue_id"] not in used]
        if not found:
            yield {"type": "message", "text": f"Nothing left in {s['city']} that fits {s['audience']} people."}
            stops.append({**s, "venue": None, "backup": None, "lodging": None, "costs": None})
            continue
        pick, backup = found[0], (found[1] if len(found) > 1 else None)
        used.add(pick["venue_id"])
        if backup:
            used.add(backup["venue_id"])  # a backup is someone else's pick only if nothing else is left
        analysis = yield from _call("analyze_venue", scout.analyze_venue, {
            "venue_id": pick["venue_id"], "use": brief["use"], "audience": s["audience"]})
        if analysis.get("best_space"):
            pick = {**pick, "best_space": analysis["best_space"]}
        housing = yield from _call("find_housing", scout.find_housing, {
            "venue_id": pick["venue_id"], "group_size": group, "nights": s["nights"]})
        stay = (housing.get("options") or [None])[0]
        venue_rec = data.venues()[pick["venue_id"]]
        fee = venue_fee_estimate(venue_rec, (pick.get("best_space") or {}).get("area_sqft"))
        lodging = (stay or {}).get("estimated_total") or 0
        stop = {
            **s,
            "venue": _venue_summary(pick),
            "backup": backup and _venue_summary(backup),
            "lodging": stay and {k: stay.get(k) for k in ("kind", "name", "address", "distance_miles",
                                                          "same_building", "rooms_needed",
                                                          "nightly_rate_per_room", "estimated_total", "why")},
            "costs": {"venue_fee": fee["fee"], "venue_fee_basis": fee["basis"], "lodging": lodging,
                      "total": round(fee["fee"] + lodging)},
        }
        stop["costs"]["break_even_ticket"] = round(stop["costs"]["total"] / max(s["audience"], 1), 2)
        stops.append(stop)
        yield {"type": "stop", "index": i, "stop": stop}

        prev = next((p for p in reversed(stops[:-1]) if p.get("venue")), None)
        if prev:
            leg = travel_leg(prev["venue"], stop["venue"], group)
            leg["after_stop"] = stops.index(prev)
            legs.append(leg)
            yield {"type": "leg", "index": len(legs) - 1, "leg": leg}

    plan = _totals(brief, brief_text, stops, legs)
    plan["id"] = secrets.token_hex(4)
    plan["share_url"] = f"/?tour={plan['id']}"
    plan["created_at"] = datetime.utcnow().isoformat(timespec="seconds") + "Z"
    plan["votes"] = {}
    save_plan(plan)
    yield {"type": "message", "text": _summary(plan)}
    yield {"type": "tour", "plan": with_tallies(plan)}
    yield {"type": "done"}


def _totals(brief: dict, text: str, stops: list[dict], legs: list[dict]) -> dict:
    booked = [s for s in stops if s.get("costs")]
    venue_fees = sum(s["costs"]["venue_fee"] for s in booked)
    lodging = sum(s["costs"]["lodging"] for s in booked)
    travel = sum(l["cost"] for l in legs)
    total = round(venue_fees + lodging + travel)
    seats = sum(s["audience"] for s in booked) or 1
    group = brief["group_size"]
    totals = {
        "venue_fees": round(venue_fees), "lodging": round(lodging), "travel": round(travel), "total": total,
        "per_member": round(total / max(group, 1), 2),
        "tickets_sold": seats,
        "break_even_ticket": round(total / seats, 2),
        "nights": sum(s["nights"] for s in booked),
    }
    if brief.get("budget"):
        totals["budget"] = brief["budget"]
        totals["under_budget_by"] = round(brief["budget"] - total)
    return {"brief": text, "group_size": group, "use": brief["use"], "stops": stops, "legs": legs,
            "totals": totals}


def _nice_date(iso: str) -> str:
    if not iso:
        return ""
    d = date.fromisoformat(iso)
    return f"{d.strftime('%B')} {d.day}"


def _summary(plan: dict) -> str:
    t = plan["totals"]
    flights = [l for l in plan["legs"] if l["fly"]]
    line = (f"The whole tour comes to about ${t['total']:,}, or ${t['per_member']:,.0f} each for "
            f"{plan['group_size']} singers. Tickets at ${math.ceil(t['break_even_ticket'])} cover it "
            f"if every show sells {round(t['tickets_sold'] / max(len(plan['stops']), 1))} seats.")
    if flights:
        line += f" You'll want to fly {flights[0]['airports']}."
    if "under_budget_by" in t:
        diff = t["under_budget_by"]
        line += (f" That's ${diff:,} under your budget." if diff >= 0
                 else f" That's ${-diff:,} over your budget, so look at the backups.")
    return line


# --------------------------------------------------------------------------- storage and votes

def _path(tour_id: str):
    if not re.fullmatch(r"[0-9a-f]{8}", tour_id or ""):
        raise HTTPException(404, "No such tour")
    return TOURS_DIR / f"{tour_id}.json"


def save_plan(plan: dict) -> None:
    with _lock:
        _path(plan["id"]).write_text(json.dumps(plan, indent=1, default=str))


def load_plan(tour_id: str) -> dict:
    path = _path(tour_id)
    if not path.exists():
        raise HTTPException(404, "No such tour")
    return json.loads(path.read_text())


def with_tallies(plan: dict) -> dict:
    tallies = []
    for i, _ in enumerate(plan["stops"]):
        ballots = plan.get("votes", {}).get(str(i), {})
        tallies.append({
            "venue": sorted(n for n, c in ballots.items() if c == "venue"),
            "backup": sorted(n for n, c in ballots.items() if c == "backup"),
        })
    return {**plan, "tallies": tallies}


def cast_vote(tour_id: str, stop: int, name: str, choice: str) -> dict:
    name = re.sub(r"\s+", " ", name or "").strip()[:40]
    if not name:
        raise HTTPException(400, "Say who's voting")
    if choice not in ("venue", "backup", "none"):
        raise HTTPException(400, "Vote for the venue or the backup")
    with _lock:
        plan = load_plan(tour_id)
        if not 0 <= stop < len(plan["stops"]):
            raise HTTPException(400, "No such stop")
        ballots = plan.setdefault("votes", {}).setdefault(str(stop), {})
        key = next((k for k in ballots if k.lower() == name.lower()), name)
        if choice == "none":
            ballots.pop(key, None)
        else:
            ballots[key] = choice  # one vote per person per stop; voting again changes it
        _path(tour_id).write_text(json.dumps(plan, indent=1, default=str))
    return with_tallies(plan)


# --------------------------------------------------------------------------- dues

def collect_tour_dues(tour_id: str) -> dict:
    """Treasurer-approved: hold every deposit, lodging and travel cost as bills on the tour fund,
    and collect each member's share of the whole tour by transfer. Uses the Nessie sandbox."""
    from . import treasury

    plan = load_plan(tour_id)
    state = treasury.ensure_group()
    fund_id = state["fund_account_id"]
    actions = []

    def bill(payee: str, nickname: str, amount: float):
        if amount <= 0:
            return
        b = treasury._req("POST", f"/accounts/{fund_id}/bills", {
            "status": "pending", "payee": payee, "nickname": nickname[:60], "payment_amount": round(amount, 2)})
        actions.append({"type": "bill", "payee": payee, "amount": b.get("payment_amount"), "id": b.get("id")})

    for s in plan["stops"]:
        if not s.get("costs"):
            continue
        when = _nice_date(s["date"])
        bill(s["venue"]["name"], f"Venue deposit (50%), {when}", s["costs"]["venue_fee"] * 0.5)
        if s.get("lodging"):
            bill(s["lodging"]["name"], f"Lodging hold, {s['nights']} night(s)", s["costs"]["lodging"])
    for leg in plan["legs"]:
        bill("Airline" if leg["fly"] else "Van rental", f"{leg['from_city']} to {leg['to_city']}", leg["cost"])

    share = plan["totals"]["per_member"]
    share_cents = int(round(share * 100))
    for m in state["members"]:
        try:
            available = treasury._req("GET", f"/accounts/{m['account_id']}").get("balance_cents", 0)
        except treasury.NessieError:
            available = 0
        pay = min(share_cents, max(0, available))
        if pay <= 0:
            actions.append({"type": "short", "from": m["name"], "amount": 0, "owed": share})
            continue
        try:
            t = treasury._req("POST", f"/accounts/{m['account_id']}/transfers", {
                "payee_id": fund_id, "amount_cents": pay, "description": f"Tour share {tour_id}"})
            if t.get("id") and t.get("status") == "pending":
                try:
                    t = treasury._req("POST", f"/transactions/{t['id']}/settle") or t
                except treasury.NessieError:
                    pass
        except treasury.NessieError as exc:
            actions.append({"type": "short", "from": m["name"], "amount": 0, "owed": share, "error": str(exc)[:200]})
            continue
        actions.append({"type": "transfer", "from": m["name"], "amount": round(pay / 100, 2),
                        "owed": round(share - pay / 100, 2), "id": t.get("id")})

    result = {"actions": actions, "fund": treasury.fund_snapshot(), "per_member": share,
              "members_in_bank": len(state["members"]),
              "note": (f"Bills are held on the tour fund. Dues came from the {len(state['members'])} members "
                       "mirrored in the sandbox bank.")}
    with _lock:
        plan = load_plan(tour_id)
        plan["dues"] = {"at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
                        "collected": round(sum(a["amount"] for a in actions if a["type"] == "transfer"), 2),
                        "billed": round(sum(a["amount"] or 0 for a in actions if a["type"] == "bill"), 2)}
        _path(tour_id).write_text(json.dumps(plan, indent=1, default=str))
    return result


# --------------------------------------------------------------------------- agent tool

def plan_tour(brief: str) -> dict:
    """Plan a multi-stop tour from a free-text brief. Returns the saved plan with its share link."""
    plan = None
    for event in plan_tour_events(brief):
        if event["type"] == "tour":
            plan = event["plan"]
    if not plan:
        return {"error": "Could not plan that tour"}
    return {
        "id": plan["id"], "share_url": plan["share_url"], "totals": plan["totals"],
        "stops": [{"city": s["city"], "date": s["date"], "nights": s["nights"], "audience": s["audience"],
                   "venue": s["venue"] and {k: s["venue"][k] for k in ("venue_id", "name", "space", "rt60_occupied_s")},
                   "backup": s["backup"] and s["backup"]["name"],
                   "lodging": s["lodging"] and {k: s["lodging"][k] for k in ("name", "estimated_total")},
                   "cost": s["costs"] and s["costs"]["total"]} for s in plan["stops"]],
        "legs": [{k: l[k] for k in ("from_city", "to_city", "mode", "road_miles", "drive_hours", "cost", "why")}
                 for l in plan["legs"]],
    }


TOOLS = {"plan_tour": plan_tour}

TOOL_SCHEMAS = [
    {
        "name": "plan_tour",
        "description": (
            "Plan a whole multi-stop tour in one go: for each show (city, date, audience) pick a scanned room "
            "with good acoustics and a backup, never the same venue twice, find lodging nearby, work out the "
            "drive or flight between stops, and total venue fees, lodging and travel with each member's share "
            "and the break-even ticket price. Saves the plan and returns a share link the group can vote on. "
            "Use this when the brief has more than one show or more than one city."),
        "input_schema": {
            "type": "object",
            "properties": {
                "brief": {"type": "string", "description": (
                    "The tour in plain words, e.g. 'Our 14 singers want to do 3 shows: LA March 14, LA March 16, "
                    "Houston March 20. About 80 guests each, budget $6,000.'")},
            },
            "required": ["brief"],
        },
    },
]


# --------------------------------------------------------------------------- HTTP

router = APIRouter(prefix="/api/tour", tags=["tour"])


class TourRequest(BaseModel):
    brief: str


class VoteRequest(BaseModel):
    stop: int
    name: str
    choice: str  # "venue" | "backup" | "none"


@router.post("")
def run_tour(req: TourRequest) -> StreamingResponse:
    def stream():
        yield json.dumps({"type": "agent", "name": "tour"}) + "\n"
        try:
            for event in plan_tour_events(req.brief):
                yield json.dumps(event, default=str) + "\n"
        except Exception as exc:
            yield json.dumps({"type": "error", "text": f"{type(exc).__name__}: {exc}"}) + "\n"

    return StreamingResponse(stream(), media_type="application/x-ndjson")


@router.get("/{tour_id}")
def get_tour(tour_id: str) -> dict:
    return with_tallies(load_plan(tour_id))


@router.post("/{tour_id}/vote")
def vote(tour_id: str, req: VoteRequest) -> dict:
    return cast_vote(tour_id, req.stop, req.name, req.choice)


@router.post("/{tour_id}/dues")
def dues(tour_id: str) -> dict:
    from .treasury import NessieError
    try:
        return collect_tour_dues(tour_id)
    except NessieError as exc:
        raise HTTPException(503, str(exc))
