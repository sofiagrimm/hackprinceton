"""Text the scout: an iMessage agent on Photon 2.0.

A tour manager texts the scout's iMessage line ("14 singers, LA, March 14, 80
guests, 2 nights"). Photon delivers a `message.received` webhook here; we run
the same scouting agent the web app uses and reply in the thread with:

  1. the pick and why (acoustics, capacity, lodging, budget),
  2. a Vexcel aerial photo of the venue (iMessage on the Photon beta supports
     text and images),
  3. a link that opens the venue on the web app with "hear the room" ready.

Follow-ups in the same thread ("something cheaper", "what about Houston?",
"for 120 people") are folded into the conversation's brief and re-run.

Environment: PHOTON_API_KEY (pho_sk_...), PHOTON_PROJECT_ID (pho_prj_...),
PHOTON_WEBHOOK_TOKEN (any random string, also put in the webhook URL as
?token=...), PUBLIC_URL (the deployed site, for the listen link).
"""

from __future__ import annotations

import json
import os
import re
import threading
import uuid

import httpx

from . import data, vexcel
from .agent import PlannerScout, make_scout

API = "https://api.photon.codes/v1"
BRIEFS: dict[str, str] = {}  # spaceId -> running brief for follow-ups
SEEN: set[str] = set()       # message ids already handled (webhooks can retry)


def _cfg() -> tuple[str, str]:
    key, project = os.environ.get("PHOTON_API_KEY", ""), os.environ.get("PHOTON_PROJECT_ID", "")
    if not key or not project:
        raise RuntimeError("Set PHOTON_API_KEY and PHOTON_PROJECT_ID")
    return key, project


def _headers(extra: dict | None = None) -> dict:
    key, _ = _cfg()
    return {"Authorization": f"Bearer {key}", **(extra or {})}


def send_text(space_id: str, sender_id: str, text: str) -> None:
    _, project = _cfg()
    httpx.post(f"{API}/projects/{project}/messages", headers=_headers(), timeout=30, json={
        "spaceId": space_id, "senderId": sender_id,
        "content": {"type": "text", "format": "plain", "text": text},
    }).raise_for_status()


def send_image(space_id: str, sender_id: str, jpeg: bytes, filename: str) -> None:
    _, project = _cfg()
    boundary = uuid.uuid4().hex
    meta = json.dumps({"contentType": "image/jpeg", "sizeBytes": len(jpeg), "filename": filename}).encode()
    body = (f"--{boundary}\r\nContent-Type: application/json\r\n\r\n".encode() + meta
            + f"\r\n--{boundary}\r\nContent-Type: image/jpeg\r\n\r\n".encode() + jpeg
            + f"\r\n--{boundary}--\r\n".encode())
    r = httpx.post(f"{API}/projects/{project}/attachments", content=body, timeout=60, headers=_headers({
        "Content-Type": f'multipart/related; boundary="{boundary}"',
        "Idempotency-Key": uuid.uuid4().hex,
    }))
    r.raise_for_status()
    attachment_id = r.json()["id"]
    httpx.post(f"{API}/projects/{project}/messages", headers=_headers(), timeout=30, json={
        "spaceId": space_id, "senderId": sender_id,
        "content": {"type": "attachment", "attachmentId": attachment_id},
    }).raise_for_status()


def set_typing(space_id: str, typing: bool = True) -> None:
    _, project = _cfg()
    try:
        httpx.post(f"{API}/projects/{project}/spaces/{space_id}/typing", headers=_headers(),
                   json={"typing": typing}, timeout=10)
    except httpx.HTTPError:
        pass


# --------------------------------------------------------------------------- conversation

HELP = ("Hi! I'm Encore Scout. Tell me about your tour stop and I'll find a room that sounds right, "
        "somewhere to stay and who to call. Try: \"14 singers in LA on March 14, 80 guests, 2 nights\".")

FOLLOW_UPS = [
    (r"\bhouston\b", lambda b: re.sub(r"\b(la|los angeles)\b", "Houston", b, flags=re.I) + " in Houston"),
    (r"\b(la|los angeles)\b", lambda b: re.sub(r"\bhouston\b", "Los Angeles", b, flags=re.I) + " in Los Angeles"),
]


def merge_brief(space_id: str, text: str) -> str:
    """New brief, or the previous one plus this follow-up."""
    previous = BRIEFS.get(space_id)
    looks_new = len(text) > 60 or re.search(r"\d+\s*(singers|people|guests|members|voices)", text, re.I)
    brief = text if (looks_new or not previous) else f"{previous}. Update: {text}"
    BRIEFS[space_id] = brief
    return brief


def compose_reply(brief: str) -> tuple[str, dict | None]:
    """Run the agent and turn its result into a short text plus the chosen venue."""
    agent = make_scout()
    report, pick, housing, budget = [], None, None, None
    for ev in agent.run(brief):
        if ev["type"] == "message":
            report.append(ev["text"])
        elif ev["type"] == "tool_result":
            res = ev["result"]
            if ev["name"] == "search_venues" and res.get("results") and pick is None:
                pick = res["results"][0]
            elif ev["name"] == "find_housing":
                housing = res
            elif ev["name"] == "tour_budget":
                budget = res
            elif ev["name"] == "draft_outreach" and pick and res.get("venue") != pick["name"]:
                pick = next((v for v in [data.venues().get(pick["venue_id"])] if v), pick)
    if not pick:
        return ("I couldn't find a scanned room for that. Try a smaller audience, or say LA or Houston.", None)

    a = pick["best_space"]["acoustics"]
    space = pick["best_space"]["space_name"]
    if space.lower().startswith(pick["name"].lower()):
        space = space[len(pick["name"]):].lstrip(" -–:") or space
    lines = [
        f"🎤 {pick['name']} - {space}",
        f"{pick['address']}",
        f"Sound: {a['rt60_occupied_s']}s reverb with {a['audience']} guests ({a['verdict'].split(':')[0].lower()}). "
        f"Seats ~{a['capacity_seated']}.",
    ]
    stay = (housing or {}).get("options") or []
    if stay:
        s = stay[0]
        lines.append(f"🛏 {s['name']}, {s['distance_miles']} mi" + (f", ~${s['estimated_total']:,}" if s.get("estimated_total") else ""))
    if budget and budget.get("costs"):
        verdict = "fits your tour fund" if budget.get("affordable") else (
            f"${budget['shortfall']:,.0f} over your fund" if budget.get("shortfall") else "")
        lines.append(f"💵 ~${budget['costs']['total']:,.0f} total {verdict}; break-even ticket ${budget['break_even_ticket']:.2f}")
    public = os.environ.get("PUBLIC_URL", "").rstrip("/")
    if public:
        lines.append(f"🎧 Hear your group in this room: {public}/?venue={pick['venue_id']}&listen=1")
    lines.append("Reply with a new city (LA / Houston), audience size or number of nights to adjust.")
    return "\n".join(lines), pick


def handle_message(event: dict) -> None:
    obj = (event.get("data") or {}).get("object") or {}
    msg_id = obj.get("id")
    if msg_id in SEEN:
        return
    SEEN.add(msg_id)
    content = obj.get("content") or {}
    text = (content.get("text") or "").strip()
    space_id = (obj.get("space") or {}).get("id")
    our_line = (obj.get("receivedBy") or {}).get("id")
    if not (space_id and our_line):
        return
    try:
        if not text or text.lower() in ("hi", "hello", "hey", "help", "start"):
            send_text(space_id, our_line, HELP)
            return
        set_typing(space_id, True)
        send_text(space_id, our_line, "On it - searching 3,288 scanned buildings and measuring the rooms… 🎶")
        brief = merge_brief(space_id, text)
        reply, pick = compose_reply(brief)
        send_text(space_id, our_line, reply)
        if pick:
            venue = data.venues().get(pick["venue_id"])
            attrs = vexcel.property_attributes(venue["id"], venue["lat"], venue["lon"]) or {}
            image = vexcel.ortho_image(venue["id"], venue["lat"], venue["lon"], attrs.get("parcel_wkt"))
            if image:
                send_image(space_id, our_line, image, f"{venue['name']}-aerial.jpg")
    except Exception as exc:  # never leave the texter hanging
        try:
            send_text(space_id, our_line, f"Sorry, I hit a snag ({type(exc).__name__}). Try again in a moment.")
        except Exception:
            pass
    finally:
        set_typing(space_id, False)


def on_webhook(event: dict) -> None:
    """Called by the API route; replies on a background thread so Photon gets a fast 200."""
    if event.get("type") != "message.received":
        return
    threading.Thread(target=handle_message, args=(event,), daemon=True).start()


def planner_preview(brief: str) -> str:
    """Local test helper: the reply text the scout would send, without Photon."""
    return compose_reply(brief)[0]


__all__ = ["on_webhook", "planner_preview", "PlannerScout"]
