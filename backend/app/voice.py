"""Call the scout: a phone line on Photon 2.0, answered by a Retell voice agent.

    caller -> Photon SMS number -> (SIP) -> Retell agent -> custom functions -> POST /api/voice/retell/{name}

Photon owns the number and routes calls over SIP to Retell (photon.codes/docs/beta/cookbooks/voice/retell).
Retell does the listening and talking. When the caller asks for a room, the Retell agent calls one of our
custom functions; Retell POSTs {"name", "args", "call": {"call_id", "from_number", ...}} and speaks whatever
short answer we return. At the end the agent calls `text_me_the_link`, and we text the caller the
hear-the-room link from the same Photon number:

    POST /v1/projects/{p}/users   {"platform": "sms", "handle": "+1..."}      (caller, and our line)
    POST /v1/projects/{p}/spaces  {"platform": "sms", "participantIds": [...]} (Idempotency-Key header)
    POST /v1/projects/{p}/messages {"spaceId", "senderId", "content": {"type": "text", ...}}

Environment:
    VOICE_WEBHOOK_TOKEN  random string; Retell function URLs end in ?token=<this>
    PHOTON_API_KEY, PHOTON_PROJECT_ID   already used by photon.py
    PHOTON_SMS_NUMBER    the Photon number callers dial, E.164 (+1...)
    PUBLIC_URL           the deployed site, for the link
Without Photon keys, texts go to data/cache/voice_outbox.json instead, so the whole call can be
exercised locally (scripts/voice_sim.py).
"""

from __future__ import annotations

import json
import os
import re
import threading
import time

import httpx
from fastapi import APIRouter, HTTPException, Request

from . import data, scout
from .config import CACHE_DIR

API = "https://api.photon.codes/v1"
OUTBOX = CACHE_DIR / "voice_outbox.json"
CALLS: dict[str, dict] = {}   # call_id -> what this caller asked for and what we offered
_lock = threading.Lock()


# --------------------------------------------------------------------------- speech helpers

SUFFIX = {"blvd": "Boulevard", "st": "Street", "ave": "Avenue", "rd": "Road", "dr": "Drive", "pkwy": "Parkway",
          "ln": "Lane", "way": "Way", "pl": "Place"}


def _street(address: str) -> str:
    """'3033 Wilshire Blvd, Los Angeles' -> 'Wilshire Boulevard'; '3600 W 6th St' -> '6th Street'."""
    first = (address or "").split(",")[0]
    words = [w for w in first.split() if not w.isdigit() and w.lower().rstrip(".") not in ("n", "s", "e", "w")]
    words = [SUFFIX.get(w.lower().rstrip("."), w) for w in words]
    return " ".join(words) or first


def _space(pick: dict) -> str:
    space = pick["best_space"]["space_name"]
    if space.lower().startswith(pick["name"].lower()):
        space = space[len(pick["name"]):].lstrip(" -:") or space
    if "(" in space:
        space = space.split("(")[0].strip()
    return space.lower()


def _seconds(x: float) -> str:
    return f"{x:.1f}".rstrip("0").rstrip(".") + (" second" if abs(x - 1) < 0.05 else " seconds")


def _round_people(n: int) -> int:
    return n if n < 100 else int(round(n, -1))


def _money(x: float) -> str:
    return f"${round(x, -1):,.0f}" if x >= 100 else f"${x:,.0f}"


def _rt_words(a: dict) -> str:
    lo, hi = a["target_s"]
    rt = a["rt60_occupied_s"]
    if rt < lo:
        feel = "a little dry, so the blend will be clear but you'll want to sing out"
    elif rt > hi:
        feel = "quite live, so keep the tempos steady and the consonants crisp"
    else:
        feel = "right where you want it for unamplified voices"
    return f"With a full house the sound hangs for about {_seconds(rt)}, which is {feel}"


def _say_pick(pick: dict, stay: dict | None) -> str:
    a = pick["best_space"]["acoustics"]
    parts = [f"I'd try the {_space(pick)} at {pick['name']}, on {_street(pick['address'])}.",
             _rt_words(a) + f". It seats around {_round_people(a['capacity_seated'])}."]
    if stay:
        where = ("in the same building" if stay.get("same_building")
                 else f"{stay['distance_miles']} miles away")
        cost = f", for about {_money(stay['estimated_total'])} all told" if stay.get("estimated_total") else ""
        if stay.get("same_building"):
            parts.append(f"You can sleep in the same building{cost}.")
        else:
            parts.append(f"You could sleep at {stay['name']}, {where}{cost}.")
    parts.append("Want me to text you a link so you can hear it?")
    return " ".join(parts)


# --------------------------------------------------------------------------- functions the voice agent calls

def _call_state(call_id: str) -> dict:
    with _lock:
        return CALLS.setdefault(call_id, {"offered": [], "results": [], "brief": {}, "created": time.time()})


def find_rooms(call_id: str = "local", city: str = "Los Angeles", audience: int = 60, group_size: int = 14,
               nights: int = 2, event_date: str = "", stay_same_building: bool = False,
               use: str = "a_cappella_performance") -> dict:
    """Search and pick: the best room for the stop, plus where to sleep. Returns a short spoken answer."""
    st = _call_state(call_id)
    metro = data.CITY_ALIASES.get((city or "").lower().strip(), city or "Los Angeles")
    if metro not in data.CITY_CENTERS:
        return {"say": "I only know Los Angeles and Houston so far. Would either of those work?"}
    found = scout.search_venues(metro, audience=audience, use=use, stay_and_perform=stay_same_building)
    if not found.get("results") and stay_same_building:
        found = scout.search_venues(metro, audience=audience, use=use)
    results = found.get("results") or []
    if not results:
        return {"say": f"I couldn't find a scanned room in {metro} that holds {audience}. "
                       "Could you go a bit smaller?"}
    st["brief"] = {"metro": metro, "audience": audience, "group_size": group_size, "nights": nights,
                   "event_date": event_date, "use": use}
    st["results"] = results
    st["offered"] = [0]
    return _offer(st, 0)


def _offer(st: dict, i: int) -> dict:
    pick = st["results"][i]
    b = st["brief"]
    housing = scout.find_housing(pick["venue_id"], group_size=b["group_size"], nights=b["nights"])
    stay = (housing.get("options") or [None])[0]
    st["pick"] = pick
    st["stay"] = stay
    a = pick["best_space"]["acoustics"]
    return {
        "say": _say_pick(pick, stay),
        "venue_id": pick["venue_id"],
        "venue": pick["name"],
        "room": pick["best_space"]["space_name"],
        "rt60_full_house_s": a["rt60_occupied_s"],
        "seats": a["capacity_seated"],
        "lodging": stay and {"name": stay["name"], "miles": stay["distance_miles"],
                             "total": stay.get("estimated_total")},
        "options_left": len(st["results"]) - i - 1,
    }


def next_option(call_id: str = "local") -> dict:
    """The caller didn't like the pick: offer the next one."""
    st = _call_state(call_id)
    if not st["results"]:
        return {"say": "Tell me the city, the date and roughly how many people, and I'll look."}
    i = max(st["offered"]) + 1
    if i >= len(st["results"]):
        return {"say": "That's everything I have that fits. The first one is still my favourite."}
    st["offered"].append(i)
    out = _offer(st, i)
    out["say"] = "Another good one. " + out["say"]
    return out


def find_lodging(call_id: str = "local", nights: int | None = None, group_size: int | None = None) -> dict:
    """More places to sleep near the current pick."""
    st = _call_state(call_id)
    pick = st.get("pick")
    if not pick:
        return {"say": "Let's find the room first, then I'll find you beds nearby."}
    b = st["brief"]
    nights = nights or b["nights"]
    group_size = group_size or b["group_size"]
    b.update(nights=nights, group_size=group_size)
    options = scout.find_housing(pick["venue_id"], group_size=group_size, nights=nights).get("options") or []
    if not options:
        return {"say": f"I don't see anywhere to stay within eight miles of {pick['name']}, sorry."}
    lines = []
    for o in options[:3]:
        where = "in the building" if o.get("same_building") else f"{o['distance_miles']} miles away"
        cost = f", about {_money(o['estimated_total'])}" if o.get("estimated_total") else ""
        lines.append(f"{o['name']}, {where}{cost}")
    st["stay"] = options[0]
    return {"say": f"For {group_size} people and {nights} nights: " + ". ".join(lines)
                   + ". Those are average rates, so ask for a group price.",
            "options": options[:3]}


def text_me_the_link(call_id: str = "local", to_number: str = "") -> dict:
    """Text the caller the hear-the-room link for the current pick."""
    st = _call_state(call_id)
    pick = st.get("pick")
    to_number = to_number or st.get("from_number", "")
    if not pick:
        return {"say": "I haven't picked a room yet. Where and when is the show?"}
    if not to_number:
        return {"say": "I can't see your number on this call. You can find it on the site under the venue name."}
    text = listen_text(pick, st.get("stay"))
    try:
        where = send_sms(to_number, text)
    except Exception as exc:  # the call should carry on even if texting fails
        return {"say": "I couldn't send the text just now. The venue is " + pick["name"] + ".",
                "error": f"{type(exc).__name__}: {exc}"}
    st["texted"] = True
    return {"say": "Done, I've texted you the link. Press play and you'll hear a chord in that room.",
            "sent_via": where}


def listen_text(pick: dict, stay: dict | None) -> str:
    public = os.environ.get("PUBLIC_URL", "").rstrip("/") or "http://localhost:8000"
    a = pick["best_space"]["acoustics"]
    lines = [f"{pick['name']}, {pick['address']}.",
             f"The {_space(pick)}: about {a['rt60_occupied_s']}s of reverb with a full house, "
             f"{a['capacity_seated']} seats."]
    if stay:
        lines.append(f"Stay: {stay['name']}, {stay['distance_miles']} mi away.")
    lines.append(f"Hear the room: {public}/?venue={pick['venue_id']}&listen=1")
    return "\n".join(lines)


# --------------------------------------------------------------------------- texting through Photon

def _photon() -> tuple[str, str, str] | None:
    key, project = os.environ.get("PHOTON_API_KEY", ""), os.environ.get("PHOTON_PROJECT_ID", "")
    line = os.environ.get("PHOTON_SMS_NUMBER", "")
    return (key, project, line) if key and project and line else None


def _e164(number: str) -> str:
    digits = re.sub(r"[^\d+]", "", number or "")
    if digits and not digits.startswith("+"):
        digits = ("+1" + digits) if len(digits) == 10 else "+" + digits
    return digits


_user_ids: dict[str, str] = {}


def _sms_user(client: httpx.Client, project: str, handle: str) -> str:
    if handle not in _user_ids:
        r = client.post(f"{API}/projects/{project}/users", json={"platform": "sms", "handle": handle})
        r.raise_for_status()
        _user_ids[handle] = r.json()["id"]
    return _user_ids[handle]


def send_sms(to_number: str, text: str) -> str:
    """Text a phone number from our Photon line. Returns 'photon' or 'outbox' (no keys: logged locally)."""
    to_number = _e164(to_number)
    cfg = _photon()
    if not cfg:
        with _lock:
            box = json.loads(OUTBOX.read_text()) if OUTBOX.exists() else []
            box.append({"at": time.strftime("%Y-%m-%dT%H:%M:%S"), "to": to_number, "text": text})
            OUTBOX.write_text(json.dumps(box, indent=2))
        return "outbox"
    key, project, line = cfg
    with httpx.Client(headers={"Authorization": f"Bearer {key}"}, timeout=30) as client:
        ours = _sms_user(client, project, _e164(line))
        theirs = _sms_user(client, project, to_number)
        r = client.post(f"{API}/projects/{project}/spaces",
                        headers={"Idempotency-Key": f"voice-{ours}-{theirs}"},
                        json={"platform": "sms", "participantIds": [ours, theirs]})
        r.raise_for_status()
        space_id = r.json()["id"]
        client.post(f"{API}/projects/{project}/messages", json={
            "spaceId": space_id, "senderId": ours,
            "content": {"type": "text", "format": "plain", "text": text},
        }).raise_for_status()
    return "photon"


# --------------------------------------------------------------------------- tool definitions

TOOLS = {
    "find_rooms": find_rooms,
    "next_option": next_option,
    "find_lodging": find_lodging,
    "text_me_the_link": text_me_the_link,
}

TOOL_SCHEMAS = [
    {
        "name": "find_rooms",
        "description": "Find the best-sounding room for the caller's show and somewhere nearby to sleep. "
                       "Call once you know the city and roughly how many guests. Speak the `say` field.",
        "input_schema": {
            "type": "object",
            "properties": {
                "city": {"type": "string", "enum": ["Los Angeles", "Houston"]},
                "audience": {"type": "integer", "description": "Expected guests, not counting singers."},
                "group_size": {"type": "integer", "description": "Singers in the group. Default 14."},
                "nights": {"type": "integer", "description": "Nights they need to stay. Default 2."},
                "event_date": {"type": "string", "description": "As the caller said it, e.g. March 14."},
                "stay_same_building": {"type": "boolean",
                                       "description": "True if they want to sleep where they sing."},
            },
            "required": ["city", "audience"],
        },
    },
    {
        "name": "next_option",
        "description": "The caller wants a different room. Offers the next best one. Speak the `say` field.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "find_lodging",
        "description": "More places to stay near the current pick, or redo lodging for a new number of nights "
                       "or people. Speak the `say` field.",
        "input_schema": {
            "type": "object",
            "properties": {"nights": {"type": "integer"}, "group_size": {"type": "integer"}},
        },
    },
    {
        "name": "text_me_the_link",
        "description": "Text the caller a link to hear the picked room. Call when they say yes to the link, "
                       "or before you say goodbye. Speak the `say` field.",
        "input_schema": {"type": "object", "properties": {}},
    },
]

VOICE_PROMPT = """You are Encore Scout on the phone. You help a cappella groups and choirs find a room to \
sing in, in Los Angeles or Houston, and somewhere to stay.

Keep every turn short: one or two sentences, like a friend who books venues. Ask only for what you need: \
the city, the date, roughly how many guests, and how many nights. Assume 14 singers and 2 nights if they \
don't say. As soon as you have a city and a crowd size, call find_rooms and read its `say` field almost \
word for word. If they want something else, call next_option. If they ask about hotels, call find_lodging. \
When they want to hear the room, or before you hang up, call text_me_the_link.

Never read out venue IDs, decimals beyond one place, or URLs. Reverb numbers are estimates from 3D scans; \
prices are averages, not quotes. If they ask, say so plainly."""


def retell_functions(base_url: str, token: str) -> list[dict]:
    """The custom functions to paste into Retell, pointing at this server."""
    return [{
        "type": "custom",
        "name": t["name"],
        "description": t["description"],
        "url": f"{base_url}/api/voice/retell/{t['name']}?token={token}",
        "parameters": t["input_schema"],
        "speak_during_execution": t["name"] == "find_rooms",
        "speak_after_execution": True,
        "timeout_ms": 20000,
    } for t in TOOL_SCHEMAS]


# --------------------------------------------------------------------------- HTTP

router = APIRouter()


def _check(token: str) -> None:
    expected = os.environ.get("VOICE_WEBHOOK_TOKEN", "")
    if not expected or token != expected:
        raise HTTPException(401, "bad token")


def handle_function(name: str, body: dict) -> dict:
    """One Retell custom function call. Accepts both payload shapes Retell can send:
    {"name", "call": {...}, "args": {...}} and, with "args at root", the arguments at the top level."""
    if name not in TOOLS:
        raise HTTPException(404, f"Unknown function {name}")
    call = body.get("call") or {}
    call_id = call.get("call_id") or body.get("call_id") or "local"
    args = body.get("args")
    if args is None:
        args = {k: v for k, v in body.items() if k not in ("call", "name", "call_id")}
    st = _call_state(call_id)
    caller = call.get("from_number") if call.get("direction", "inbound") == "inbound" else call.get("to_number")
    if caller:
        st["from_number"] = caller
    allowed = TOOLS[name].__code__.co_varnames[:TOOLS[name].__code__.co_argcount]
    kwargs = {k: v for k, v in args.items() if k in allowed and k != "call_id"}
    try:
        return TOOLS[name](call_id=call_id, **kwargs)
    except Exception as exc:
        return {"say": "Sorry, I hit a snag looking that up. Could you say that again?",
                "error": f"{type(exc).__name__}: {exc}"}


@router.post("/api/voice/retell/{name}")
async def retell_function(name: str, request: Request, token: str = "") -> dict:
    _check(token)
    return handle_function(name, await request.json())


@router.post("/api/voice/retell-events")
async def retell_events(request: Request, token: str = "") -> dict:
    """Agent-level webhook. If a call ends with a pick but no text sent, send the link anyway."""
    _check(token)
    body = await request.json()
    if body.get("event") == "call_ended":
        call = body.get("call") or {}
        st = CALLS.get(call.get("call_id", ""))
        if st and st.get("pick") and not st.get("texted"):
            caller = call.get("from_number") or st.get("from_number")
            if caller:
                threading.Thread(target=send_sms, args=(caller, listen_text(st["pick"], st.get("stay"))),
                                 daemon=True).start()
                st["texted"] = True
        CALLS.pop(call.get("call_id", ""), None)
    return {"ok": True}


@router.get("/api/voice/retell-config")
def retell_config(token: str = "") -> dict:
    """Everything to paste into the Retell agent: prompt and custom functions with URLs filled in."""
    _check(token)
    base = os.environ.get("PUBLIC_URL", "").rstrip("/") or "http://localhost:8000"
    return {"general_prompt": VOICE_PROMPT,
            "begin_message": "Hi, this is Encore Scout. Where's the show, and about how many people?",
            "functions": retell_functions(base, token),
            "agent_webhook_url": f"{base}/api/voice/retell-events?token={token}"}


@router.get("/api/voice/status")
def voice_status() -> dict:
    return {"webhook_token_set": bool(os.environ.get("VOICE_WEBHOOK_TOKEN")),
            "photon_sms_ready": bool(_photon()),
            "public_url": os.environ.get("PUBLIC_URL", ""),
            "active_calls": len(CALLS)}
