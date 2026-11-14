r"""Booking pipeline: who the group has written to, where each conversation stands, and what to send next.

Stored as one small JSON file (data/cache/pipeline.json), one entry per venue:

    drafted -> sent -> replied -> holding -> booked
                                         \-> declined (from any step)

Each entry keeps the outreach email (from scout.draft_outreach), a dated history, notes and the date the
group should next follow up. Also here: /api/compare, which lines two venues up side by side.

Agent tools (TOOLS / TOOL_SCHEMAS, same shape as agent.py): add_to_pipeline, update_status,
draft_follow_up, list_pipeline.
"""

from __future__ import annotations

import json
import threading
from datetime import date, datetime, timedelta

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import data, scout
from .acoustics import USES
from .config import CACHE_DIR

STORE = CACHE_DIR / "pipeline.json"
STATUSES = ["drafted", "sent", "replied", "holding", "booked", "declined"]
# How long to wait before nudging, by status. None means nothing to chase.
FOLLOW_UP_DAYS = {"drafted": None, "sent": 4, "replied": 2, "holding": 3, "booked": None, "declined": None}
_lock = threading.Lock()


# --------------------------------------------------------------------------- storage

def _today() -> date:
    return date.today()


def _load() -> dict:
    if not STORE.exists():
        return {"entries": {}}
    try:
        return json.loads(STORE.read_text())
    except json.JSONDecodeError:
        return {"entries": {}}


def _save(state: dict) -> None:
    STORE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STORE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2))
    tmp.replace(STORE)


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _next_follow_up(status: str, days: int | None = None) -> str | None:
    wait = FOLLOW_UP_DAYS.get(status) if days is None else days
    if wait is None:
        return None
    return (_today() + timedelta(days=wait)).isoformat()


def _view(entry: dict) -> dict:
    """An entry plus what the board needs to show: days since contact and whether a nudge is due."""
    out = dict(entry)
    sent = entry.get("sent_at")
    out["days_since_sent"] = (_today() - date.fromisoformat(sent[:10])).days if sent else None
    due = entry.get("next_follow_up")
    out["follow_up_due"] = bool(due and entry["status"] not in ("booked", "declined")
                                and date.fromisoformat(due) <= _today())
    return out


# --------------------------------------------------------------------------- tools

def add_to_pipeline(venue_id: int, event_date: str = "", audience: int = 60, group_size: int = 14,
                    nights: int = 2, space_name: str | None = None, group_name: str = "",
                    status: str = "drafted", notes: str = "") -> dict:
    """Start tracking a venue: draft the outreach email and file it under `status`."""
    venue = data.venues().get(int(venue_id))
    if not venue:
        return {"error": f"Unknown venue {venue_id}"}
    if status not in STATUSES:
        return {"error": f"status must be one of {', '.join(STATUSES)}"}
    if not space_name:
        best = (scout.analyze_venue(venue["id"], audience=audience).get("best_space") or {})
        space_name = best.get("space_name")
    draft = scout.draft_outreach(venue["id"], group_name=group_name, event_date=event_date, audience=audience,
                                 group_size=group_size, nights=nights, space_name=space_name)
    now = _now()
    with _lock:
        state = _load()
        key = str(venue["id"])
        existing = state["entries"].get(key)
        if existing:
            return {"already_tracking": True, "entry": _view(existing)}
        entry = {
            "venue_id": venue["id"],
            "name": venue["name"],
            "address": venue["address"],
            "metro": data.metro_of(venue),
            "space_name": space_name,
            "event_date": event_date,
            "audience": audience,
            "group_size": group_size,
            "nights": nights,
            "group_name": group_name,
            "status": status,
            "created_at": now,
            "updated_at": now,
            "sent_at": now if status != "drafted" else None,
            "next_follow_up": _next_follow_up(status),
            "contact": draft.get("to"),
            "email": {"subject": draft.get("subject"), "body": draft.get("body")},
            "notes": [{"at": now, "text": notes}] if notes else [],
            "history": [{"at": now, "status": status}],
            "follow_ups": [],
        }
        state["entries"][key] = entry
        _save(state)
    return {"added": True, "entry": _view(entry)}


def update_status(venue_id: int, status: str, note: str = "", follow_up_in_days: int | None = None) -> dict:
    """Move a venue to a new status, optionally with a note and a custom follow-up date."""
    if status not in STATUSES:
        return {"error": f"status must be one of {', '.join(STATUSES)}"}
    now = _now()
    with _lock:
        state = _load()
        entry = state["entries"].get(str(int(venue_id)))
        if not entry:
            return {"error": f"Venue {venue_id} isn't in the pipeline yet. Add it first."}
        if status != entry["status"]:
            entry["history"].append({"at": now, "status": status})
        entry["status"] = status
        if status == "sent" and not entry.get("sent_at"):
            entry["sent_at"] = now
        if note:
            entry["notes"].append({"at": now, "text": note})
        entry["next_follow_up"] = _next_follow_up(status, follow_up_in_days)
        entry["updated_at"] = now
        _save(state)
    return {"updated": True, "entry": _view(entry)}


def draft_follow_up(venue_id: int, days_since: int | None = None, sender_name: str = "") -> dict:
    """A short, polite nudge for a venue that hasn't answered (or that answered and went quiet)."""
    with _lock:
        state = _load()
        entry = state["entries"].get(str(int(venue_id)))
    if not entry:
        return {"error": f"Venue {venue_id} isn't in the pipeline yet. Add it first."}
    view = _view(entry)
    days = days_since if days_since is not None else (view["days_since_sent"] or 0)
    contact = entry.get("contact") or {}
    first = (contact.get("name") or "").split()[0] if contact.get("name") else ""
    greeting = f"Hi {first}," if first and contact.get("name") != "Sales & Events Team" else "Hello,"
    when = f" on {entry['event_date']}" if entry.get("event_date") else ""
    space = entry.get("space_name") or "your space"
    if space.startswith(entry["name"].lower()):
        space = space[len(entry["name"]):].lstrip(" -:") or space
    if days <= 0:
        ago = "recently"
    elif days == 1:
        ago = "yesterday"
    elif days < 7:
        ago = f"{days} days ago"
    elif days < 14:
        ago = "last week"
    else:
        ago = f"{days // 7} weeks ago"
    sign = sender_name or "[Your name]"
    if entry.get("group_name"):
        sign += "\n" + entry["group_name"]

    status = entry["status"]
    if status == "holding":
        middle = (f"Thanks again for holding the {space} for us{when}. We're still keen. "
                  "Could you tell me how long the hold lasts and what you need from us to confirm it? "
                  "If there's a deposit, I can send it this week.")
    elif status == "replied":
        middle = (f"Thanks for getting back to us about the {space}{when}. "
                  "I wanted to pick the thread back up so it doesn't slip. "
                  "Is the date still open, and is there anything else you need from us to put a hold on it?")
    elif status == "booked":
        middle = (f"Just checking in ahead of our show{when}. "
                  "Is there anything you need from us before load-in, like a list of names or a time to arrive?")
    else:
        middle = (f"I wrote {ago} about singing in the {space} at {entry['name']}{when}, "
                  f"for an audience of about {entry.get('audience') or 60}. "
                  "I know inboxes fill up, so I wanted to check it reached the right person. "
                  "If the date doesn't work, we're happy to hear about other evenings that week.")
    body = f"{greeting}\n\n{middle}\n\nThanks so much,\n{sign}\n"
    subject = "Re: " + (entry.get("email") or {}).get("subject", f"Booking a concert at {entry['name']}")
    draft = {"to": contact, "subject": subject, "body": body, "days_since_sent": days}

    now = _now()
    with _lock:
        state = _load()
        live = state["entries"].get(str(int(venue_id)))
        if live:
            live.setdefault("follow_ups", []).append({"at": now, "subject": subject, "body": body})
            live["updated_at"] = now
            _save(state)
    return {"venue": entry["name"], "status": status, **draft}


def list_pipeline(status: str | None = None) -> dict:
    """Every tracked venue, grouped by status, with the ones due a follow-up called out."""
    with _lock:
        entries = [_view(e) for e in _load()["entries"].values()]
    if status:
        entries = [e for e in entries if e["status"] == status]
    entries.sort(key=lambda e: (STATUSES.index(e["status"]), e.get("next_follow_up") or "9999", e["name"]))
    groups = [{"status": s, "entries": [e for e in entries if e["status"] == s]} for s in STATUSES]
    return {
        "count": len(entries),
        "groups": [g for g in groups if g["entries"]],
        "due": [{"venue_id": e["venue_id"], "name": e["name"], "status": e["status"],
                 "next_follow_up": e["next_follow_up"]} for e in entries if e["follow_up_due"]],
        "statuses": STATUSES,
    }


def remove_from_pipeline(venue_id: int) -> dict:
    with _lock:
        state = _load()
        gone = state["entries"].pop(str(int(venue_id)), None)
        _save(state)
    return {"removed": bool(gone)}


# --------------------------------------------------------------------------- compare

def _compare_one(venue_id: int, use: str, audience: int, group_size: int, nights: int) -> dict:
    from .treasury import venue_fee_estimate
    venue = data.venues().get(int(venue_id))
    if not venue:
        return {"error": f"Unknown venue {venue_id}"}
    analysis = scout.analyze_venue(venue["id"], use=use, audience=audience)
    best = analysis.get("best_space")
    housing = scout.find_housing(venue["id"], group_size=group_size, nights=nights)
    stay = (housing.get("options") or [None])[0]
    fee = venue_fee_estimate(venue, best and best.get("area_sqft"))
    lodging = (stay or {}).get("estimated_total") or 0
    total = fee["fee"] + lodging
    a = (best or {}).get("acoustics") or {}
    target = a.get("target_s") or list(USES[use][:2])
    rt = a.get("rt60_occupied_s")
    off = None
    if rt is not None:
        off = 0.0 if target[0] <= rt <= target[1] else round(min(abs(rt - target[0]), abs(rt - target[1])), 2)
    room_name = (best or {}).get("space_name") or ""
    if room_name.lower().startswith(venue["name"].lower()):
        room_name = room_name[len(venue["name"]):].lstrip(" -:") or room_name
    return {
        "venue_id": venue["id"],
        "name": venue["name"],
        "address": venue["address"],
        "metro": data.metro_of(venue),
        "photo": venue.get("photo"),
        "is_hotel": bool(venue.get("hotel")),
        "parking_spaces": venue.get("parking_spaces"),
        "room": best and {
            "name": room_name,
            "model_id": best.get("model_id"),
            "area_sqft": best["area_sqft"],
            "height_ft": best.get("height_ft"),
            "volume_m3": a.get("volume_m3"),
            "rt60_empty_s": a.get("rt60_empty_s"),
            "rt60_occupied_s": rt,
            "target_s": target,
            "seconds_off_target": off,
            "capacity_seated": a.get("capacity_seated"),
            "capacity_standing": a.get("capacity_standing"),
            "verdict": a.get("verdict"),
        },
        "other_rooms": [{"name": s["space_name"], "rt60_occupied_s": s["acoustics"]["rt60_occupied_s"],
                         "volume_m3": s["acoustics"]["volume_m3"], "area_sqft": s["area_sqft"],
                         "capacity_seated": s["acoustics"]["capacity_seated"]}
                        for s in (analysis.get("spaces") or [])[1:4]],
        "lodging": stay and {k: stay.get(k) for k in ("kind", "name", "distance_miles", "same_building",
                                                       "estimated_total", "nightly_rate_per_room", "rooms_needed")},
        "cost": {"venue_fee_estimate": fee["fee"], "venue_fee_basis": fee["basis"],
                 "lodging_estimate": lodging, "total": total,
                 "per_member": round(total / max(group_size, 1), 2),
                 "break_even_ticket": round(total / max(audience, 1), 2)},
    }


def _compare_summary(a: dict, b: dict) -> str:
    lines = []
    ra, rb = a.get("room") or {}, b.get("room") or {}
    if ra.get("rt60_occupied_s") is not None and rb.get("rt60_occupied_s") is not None:
        oa, ob = ra["seconds_off_target"], rb["seconds_off_target"]
        if oa == ob == 0:
            lines.append("Both rooms land in the target reverb with a full house.")
        elif oa != ob:
            better, worse = (a, b) if oa < ob else (b, a)
            lines.append(f"{better['name']} sounds closer to right for this, "
                         f"{better['room']['rt60_occupied_s']}s against {worse['room']['rt60_occupied_s']}s.")
        else:
            lines.append("The two rooms are equally far from the target reverb.")
    ca, cb = a["cost"]["total"], b["cost"]["total"]
    if abs(ca - cb) >= 50:
        cheap, dear = (a, b) if ca < cb else (b, a)
        lines.append(f"{cheap['name']} is about ${abs(ca - cb):,.0f} cheaper all in.")
    else:
        lines.append("They cost about the same all in.")
    for v in (a, b):
        if (v.get("lodging") or {}).get("same_building"):
            lines.append(f"At {v['name']} the group can sleep in the same building.")
    return " ".join(lines)


def compare_venues(a: int, b: int, use: str = "a_cappella_performance", audience: int = 60,
                   group_size: int = 14, nights: int = 2) -> dict:
    if use not in USES:
        use = "a_cappella_performance"
    left = _compare_one(a, use, audience, group_size, nights)
    right = _compare_one(b, use, audience, group_size, nights)
    if "error" in left or "error" in right:
        return {"error": left.get("error") or right.get("error")}
    return {
        "use": use, "use_label": USES[use][2], "audience": audience, "group_size": group_size, "nights": nights,
        "a": left, "b": right,
        "summary": _compare_summary(left, right),
        "note": "Reverb is a physics estimate from the scan. Fees and lodging are estimates, not quotes.",
    }


# --------------------------------------------------------------------------- agent tool definitions

TOOLS = {
    "add_to_pipeline": add_to_pipeline,
    "update_status": update_status,
    "draft_follow_up": draft_follow_up,
    "list_pipeline": list_pipeline,
}

TOOL_SCHEMAS = [
    {
        "name": "add_to_pipeline",
        "description": "Start tracking outreach to a venue. Drafts the inquiry email (same as draft_outreach) and "
                       "files the venue under a status, with a next follow-up date.",
        "input_schema": {
            "type": "object",
            "properties": {
                "venue_id": {"type": "integer"},
                "event_date": {"type": "string"},
                "audience": {"type": "integer"},
                "group_size": {"type": "integer"},
                "nights": {"type": "integer"},
                "space_name": {"type": "string", "description": "The room to ask about. Defaults to the best one."},
                "group_name": {"type": "string"},
                "status": {"type": "string", "enum": STATUSES, "description": "Default drafted."},
                "notes": {"type": "string"},
            },
            "required": ["venue_id"],
        },
    },
    {
        "name": "update_status",
        "description": "Move a tracked venue to a new status (drafted, sent, replied, holding, booked, declined), "
                       "with an optional note. Resets the next follow-up date for that status unless "
                       "follow_up_in_days is given.",
        "input_schema": {
            "type": "object",
            "properties": {
                "venue_id": {"type": "integer"},
                "status": {"type": "string", "enum": STATUSES},
                "note": {"type": "string"},
                "follow_up_in_days": {"type": "integer"},
            },
            "required": ["venue_id", "status"],
        },
    },
    {
        "name": "draft_follow_up",
        "description": "Write a short, plain follow-up email for a tracked venue, worded for where the "
                       "conversation stands (no reply yet, replied, holding, booked).",
        "input_schema": {
            "type": "object",
            "properties": {
                "venue_id": {"type": "integer"},
                "days_since": {"type": "integer", "description": "Override the days since the first email."},
                "sender_name": {"type": "string"},
            },
            "required": ["venue_id"],
        },
    },
    {
        "name": "list_pipeline",
        "description": "List every venue the group has contacted, grouped by status, and which are due a follow-up.",
        "input_schema": {
            "type": "object",
            "properties": {"status": {"type": "string", "enum": STATUSES}},
        },
    },
]


# --------------------------------------------------------------------------- HTTP

router = APIRouter()


class AddRequest(BaseModel):
    venue_id: int
    event_date: str = ""
    audience: int = 60
    group_size: int = 14
    nights: int = 2
    space_name: str | None = None
    group_name: str = ""
    status: str = "drafted"
    notes: str = ""


class StatusRequest(BaseModel):
    status: str
    note: str = ""
    follow_up_in_days: int | None = None


class FollowUpRequest(BaseModel):
    days_since: int | None = None
    sender_name: str = ""


def _ok(result: dict, code: int = 400) -> dict:
    if "error" in result:
        raise HTTPException(404 if "Unknown" in result["error"] or "isn't in" in result["error"] else code,
                            result["error"])
    return result


@router.get("/api/pipeline")
def get_pipeline(status: str | None = None) -> dict:
    return list_pipeline(status)


@router.post("/api/pipeline")
def post_pipeline(req: AddRequest) -> dict:
    return _ok(add_to_pipeline(**req.model_dump()))


@router.patch("/api/pipeline/{venue_id}")
def patch_pipeline(venue_id: int, req: StatusRequest) -> dict:
    return _ok(update_status(venue_id, **req.model_dump()))


@router.post("/api/pipeline/{venue_id}/follow-up")
def post_follow_up(venue_id: int, req: FollowUpRequest | None = None) -> dict:
    req = req or FollowUpRequest()
    return _ok(draft_follow_up(venue_id, **req.model_dump()))


@router.delete("/api/pipeline/{venue_id}")
def delete_pipeline(venue_id: int) -> dict:
    return remove_from_pipeline(venue_id)


@router.get("/api/compare")
def get_compare(a: int, b: int, use: str = "a_cappella_performance", audience: int = 60,
                group_size: int = 14, nights: int = 2) -> dict:
    return _ok(compare_venues(a, b, use=use, audience=audience, group_size=group_size, nights=nights))


# The phone line lives in voice.py; mounting it here keeps main.py to one include_router line.
from .voice import router as _voice_router  # noqa: E402

router.include_router(_voice_router)
