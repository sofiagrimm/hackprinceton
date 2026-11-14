"""Simulate a phone call to the scout without Retell or Photon.

Plays a caller's lines one by one. A tiny rule-based stand-in for Retell's LLM decides which custom
function to call, then POSTs exactly what Retell would send to /api/voice/retell/<name>, and prints what
the agent would say. With no Photon keys, the closing text lands in data/cache/voice_outbox.json.

    python scripts/voice_sim.py                     # the built-in demo call
    python scripts/voice_sim.py transcript.txt      # one caller line per line
    python scripts/voice_sim.py -i                  # type the caller's lines yourself
"""

from __future__ import annotations

import os
import re
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
os.environ.setdefault("VOICE_WEBHOOK_TOKEN", "local-sim")

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402
from app import voice  # noqa: E402

DEMO = [
    "Hi, I run a 14 person a cappella group and we're doing a show in LA on March 14.",
    "Maybe 80 people. We'd stay two nights.",
    "Hmm, anything else?",
    "Where could we stay near that one?",
    "Yes please, text me the link.",
    "Thanks, bye.",
]
CALLER = "+15551234567"
WORDS = {"two": 2, "three": 3, "four": 4, "five": 5, "one": 1}


class StandIn:
    """What the Retell agent's LLM would do, reduced to keyword rules."""

    def __init__(self):
        self.slots: dict = {}
        self.searched = False

    def hear(self, text: str) -> tuple[str, dict] | None:
        t = text.lower()
        if "houston" in t:
            self.slots["city"] = "Houston"
        elif re.search(r"\b(la|l\.a\.|los angeles)\b", t):
            self.slots["city"] = "Los Angeles"
        m = re.search(r"(\d+)\s*(?:-\s*)?(?:person|people|singers|voices|members)", t)
        if m and ("group" in t or "singers" in t):
            self.slots["group_size"] = int(m.group(1))
        elif m:
            self.slots["audience"] = int(m.group(1))
        m = re.search(r"(\d+|one|two|three|four|five)\s+nights?", t)
        if m:
            self.slots["nights"] = int(WORDS.get(m.group(1), m.group(1)))
        m = re.search(r"\b((?:january|february|march|april|may|june|july|august|september|october|november|december|"
                      r"jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\.?\s+\d{1,2})\b", t)
        if m:
            self.slots["event_date"] = m.group(1).title()
        if "same building" in t or "stay where" in t:
            self.slots["stay_same_building"] = True

        if self.searched and any(w in t for w in ("text", "link", "send it", "yes please")):
            return "text_me_the_link", {}
        if self.searched and any(w in t for w in ("anything else", "another", "other option", "different")):
            return "next_option", {}
        if self.searched and any(w in t for w in ("stay", "hotel", "sleep", "lodging")):
            return "find_lodging", {}
        if not self.searched and "city" in self.slots and "audience" in self.slots:
            self.searched = True
            return "find_rooms", dict(self.slots)
        return None

    def small_talk(self, text: str) -> str:
        t = text.lower()
        if any(w in t for w in ("bye", "thanks", "thank you")):
            return "Good luck with the show. Bye now."
        if "city" not in self.slots:
            return "Which city, Los Angeles or Houston?"
        if "audience" not in self.slots:
            return "Sounds fun. About how many people in the audience?"
        return "Got it."


def run(lines: list[str], interactive: bool = False) -> None:
    client = TestClient(app)
    token = os.environ["VOICE_WEBHOOK_TOKEN"]
    call = {"call_id": f"sim_{uuid.uuid4().hex[:8]}", "from_number": CALLER, "to_number": "+15557654321",
            "direction": "inbound", "call_type": "phone_call"}
    agent = StandIn()
    print("Agent: Hi, this is Encore Scout. Where's the show, and about how many people?")
    source = iter(lines) if not interactive else iter(lambda: input("Caller: "), "")
    for line in source:
        if not interactive:
            print(f"Caller: {line}")
        decision = agent.hear(line)
        if not decision:
            print(f"Agent: {agent.small_talk(line)}")
            continue
        name, args = decision
        r = client.post(f"/api/voice/retell/{name}?token={token}", json={"name": name, "call": call, "args": args})
        r.raise_for_status()
        out = r.json()
        print(f"  [function {name}({args}) -> {r.status_code}]")
        print(f"Agent: {out['say']}")
    client.post(f"/api/voice/retell-events?token={token}", json={"event": "call_ended", "call": call})
    if voice.OUTBOX.exists():
        print(f"\nTexts (no Photon keys, so logged to {voice.OUTBOX}):")
        import json
        last = json.loads(voice.OUTBOX.read_text())[-1]
        print(f"To {last['to']}:\n{last['text']}")


if __name__ == "__main__":
    args = sys.argv[1:]
    if args and args[0] == "-i":
        run([], interactive=True)
    elif args:
        run([ln.strip() for ln in Path(args[0]).read_text().splitlines() if ln.strip()])
    else:
        run(DEMO)
