"""The scouting agent.

Two brains share the same tools (app.scout):

* ClaudeScout - Claude plans the search, calls the tools, reacts to what they
  return (e.g. widens the search when nothing fits, swaps the room when one is
  too live) and writes the recommendation. Used when ANTHROPIC_API_KEY is set.
* PlannerScout - our own rule-based planner: parses the brief with patterns and
  runs a fixed plan. Always available, no outside AI needed.

Both yield the same stream of events, which the API forwards to the browser:
  {"type": "plan", "text": ...}
  {"type": "tool", "name": ..., "input": {...}}
  {"type": "tool_result", "name": ..., "result": {...}}
  {"type": "message", "text": ...}           (agent narration / final report)
  {"type": "done", "brief": {...}}
  {"type": "error", "text": ...}
"""

from __future__ import annotations

import json
import re
from typing import Iterator

from . import scout
from .acoustics import USES
from .config import ANTHROPIC_API_KEY, SCOUT_MODEL

Event = dict

# --------------------------------------------------------------------------- brief parsing

USE_WORDS = [
    (("film", "dialogue", "shoot", "movie", "video"), "film_dialogue"),
    (("record", "recording", "album", "track"), "recording"),
    (("rehears", "practice", "warm-up", "warmup"), "rehearsal"),
    (("choir", "chorale", "choral", "sacred"), "choral_performance"),
    (("amplified", " pa ", "band", "dj"), "amplified_show"),
]


def parse_brief(text: str) -> dict:
    """Pull the key numbers out of a free-text brief with simple patterns."""
    t = f" {text.lower()} "
    metro = "Houston" if "houston" in t else "Los Angeles"

    def num(patterns: list[str], default: int) -> int:
        for p in patterns:
            m = re.search(p, t)
            if m:
                return int(m.group(1))
        return default

    group = num([r"(\d+)\s*(?:-\s*)?(?:singers|members|people in (?:the|our) group|person group|-person|voices|performers)",
                 r"group of (\d+)"], 14)
    audience = num([r"(\d+)\s*(?:guests|audience|attendees|seats|seated|people)",
                    r"audience of (\d+)", r"for (\d+)"], 60)
    if audience == group:
        audience = max(audience * 4, 40)
    nights = num([r"(\d+)\s*nights?", r"(\d+)\s*days?"], 2)
    weeks = re.search(r"(\d+)\s*weeks?", t)
    if weeks:
        nights = int(weeks.group(1)) * 7
    use = "a_cappella_performance"
    for words, u in USE_WORDS:
        if any(w in t for w in words):
            use = u
            break
    stay = any(w in t for w in ("stay", "sleep", "housing", "lodging", "hotel", "overnight", "same building"))
    date = re.search(r"(?:on|for)\s+((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2})", t)
    return {
        "metro": metro, "group_size": group, "audience": audience, "nights": nights,
        "use": use, "use_label": USES[use][2], "stay_and_perform": stay,
        "event_date": date.group(1).title() if date else "",
    }


# --------------------------------------------------------------------------- our planner

class PlannerScout:
    name = "planner"

    def run(self, brief_text: str) -> Iterator[Event]:
        brief = parse_brief(brief_text)
        yield {"type": "plan", "text": (
            f"Brief: {brief['group_size']} performers, ~{brief['audience']} guests, {brief['nights']} night(s) "
            f"in {brief['metro']}; target sound: {brief['use_label']}. Plan: rank scanned spaces by acoustics "
            "and capacity -> inspect the top venues -> check the site from the air -> find lodging -> draft outreach.")}

        args = {"metro": brief["metro"], "audience": brief["audience"], "use": brief["use"],
                "stay_and_perform": brief["stay_and_perform"]}
        found = yield from _call("search_venues", args)
        if not found.get("results") and brief["stay_and_perform"]:
            yield {"type": "message", "text": "No stay-and-perform match; widening to every venue type."}
            args["stay_and_perform"] = False
            found = yield from _call("search_venues", args)
        if not found.get("results"):
            yield {"type": "message", "text": "No scanned space fits that audience. Try a smaller audience."}
            yield {"type": "done", "brief": brief}
            return

        top = found["results"][:3]
        analyses = []
        for venue in top:
            analyses.append((yield from _call("analyze_venue", {
                "venue_id": venue["venue_id"], "use": brief["use"], "audience": brief["audience"]})))
        pick = top[0]
        yield from _call("site_check", {"venue_id": pick["venue_id"]})
        housing = yield from _call("find_housing", {
            "venue_id": pick["venue_id"], "group_size": brief["group_size"], "nights": brief["nights"]})
        best = pick["best_space"]
        budget = yield from _call("tour_budget", {
            "venue_id": pick["venue_id"], "group_size": brief["group_size"], "nights": brief["nights"],
            "audience": brief["audience"], "space_area_sqft": best["area_sqft"]})
        yield from _call("draft_outreach", {
            "venue_id": pick["venue_id"], "event_date": brief["event_date"], "audience": brief["audience"],
            "group_size": brief["group_size"], "nights": brief["nights"], "space_name": best["space_name"]})

        a = best["acoustics"]
        stay = (housing.get("options") or [{}])[0]
        space = best["space_name"]
        if space.lower().startswith(pick["name"].lower()):
            space = space[len(pick["name"]):].lstrip(" -:") or space
        lines = [
            f"I'd book the {space.lower()} at **{pick['name']}**. {a['verdict']} "
            f"It's {best['area_sqft']:,} sq ft, enough for about {a['capacity_seated']} people seated.",
        ]
        more = []
        if stay:
            where = "in the same building" if stay.get("same_building") else f"{stay.get('distance_miles')} miles away"
            cost = f" for about ${stay['estimated_total']:,}" if stay.get("estimated_total") else ""
            more.append(f"The group can stay at {stay.get('name')}, {where}{cost}.")
        if budget.get("costs"):
            more.append(_budget_line(budget))
        backups = [f"{alt['name']} ({alt['best_space']['acoustics']['rt60_occupied_s']}s)" for alt in top[1:]]
        if backups:
            more.append("If it's booked, try " + " or ".join(backups) + ".")
        lines.append(" ".join(more))
        yield {"type": "message", "text": "\n".join(lines)}
        yield {"type": "done", "brief": brief}


def _budget_line(budget: dict) -> str:
    total = budget["costs"]["total"]
    if budget.get("affordable"):
        verdict = "and the tour fund can cover it"
    elif budget.get("shortfall"):
        verdict = f"which is ${budget['shortfall']:,.0f} more than the tour fund has"
    else:
        verdict = "(the bank isn't connected, so I couldn't check the fund)"
    return (f"The whole stop comes to about ${total:,.0f}, {verdict}. Tickets would need to be "
            f"${budget['break_even_ticket']:.2f} to break even.")


def _call(name: str, args: dict):
    yield {"type": "tool", "name": name, "input": args}
    try:
        result = scout.TOOLS[name](**args)
    except Exception as exc:  # surface tool failures instead of crashing the stream
        result = {"error": f"{type(exc).__name__}: {exc}"}
    yield {"type": "tool_result", "name": name, "result": result}
    return result


# --------------------------------------------------------------------------- Claude

SYSTEM_PROMPT = """You are Encore Scout, a location scout for touring performers: a cappella groups, \
choirs and, later, film crews. You find spaces in Los Angeles and Houston where a group can perform \
(or rehearse, record or shoot) and somewhere for them to stay, using real CoStar, Matterport and Vexcel data \
through your tools.

How to work:
1. Read the brief and decide the metro, group size, audience, nights, intended use and whether they want \
to stay and perform in the same building. State your plan in one or two sentences.
2. Call search_venues. If results are thin or the acoustics miss the target, adjust (different use, \
audience or stay_and_perform) and search again rather than settling.
3. Call analyze_venue on the 2-3 most promising venues to compare their scanned rooms. Prefer rooms whose \
occupied RT60 lands in the target band; a room that is a little dry is better than one that is very live.
4. Call site_check on your top pick to look at parking and the building from the air.
5. Call find_housing for the top pick with the group size and nights.
6. Call tour_budget for the top pick to check the group's fund; if it is over budget, consider a cheaper \
backup or lodging option and say so.
7. Call draft_outreach for the top pick, naming the specific room.
8. Finish with a short recommendation: the pick and why (cite RT60 numbers and capacity), lodging and \
estimated cost, one or two backups, and any caveats. Keep it under 150 words. Write it the way a friend who \
books venues would text it: two short plain paragraphs, first person, no headings, no bullet points, no bold \
labels like "Sound:", no emoji, no em dashes, no sales language. Before calling a tool you may say one short \
sentence about what you're checking.

The acoustic numbers are physics estimates from scan geometry and assumed finishes; say so briefly. \
Rates are CoStar averages, not quotes. Never invent data the tools did not return."""

TOOL_SCHEMAS = [
    {
        "name": "search_venues",
        "description": "Rank Matterport-scanned spaces in a metro (Los Angeles or Houston) by how well their "
                       "estimated acoustics and capacity fit the use and audience. Returns venue cards with the best "
                       "space at each venue, its RT60 estimate and a match score.",
        "input_schema": {
            "type": "object",
            "properties": {
                "metro": {"type": "string", "enum": ["Los Angeles", "Houston"]},
                "audience": {"type": "integer", "description": "Expected guests (not counting performers)."},
                "use": {"type": "string", "enum": list(USES)},
                "stay_and_perform": {"type": "boolean",
                                     "description": "Only hotels and apartment communities, so the group can sleep on site."},
                "max_results": {"type": "integer", "description": "Default 8."},
            },
            "required": ["metro", "audience", "use"],
        },
    },
    {
        "name": "analyze_venue",
        "description": "Acoustic breakdown of every scanned room at one venue: RT60 empty and occupied, capacity, "
                       "assumed finishes and a verdict for the intended use.",
        "input_schema": {
            "type": "object",
            "properties": {
                "venue_id": {"type": "integer"},
                "use": {"type": "string", "enum": list(USES)},
                "audience": {"type": "integer"},
            },
            "required": ["venue_id", "use", "audience"],
        },
    },
    {
        "name": "site_check",
        "description": "Vexcel aerial attributes for a venue (footprint, roof, vehicles counted on the parcel) plus "
                       "CoStar's parking count. Use it to judge load-in, parking and rooftop potential.",
        "input_schema": {"type": "object", "properties": {"venue_id": {"type": "integer"}},
                         "required": ["venue_id"]},
    },
    {
        "name": "find_housing",
        "description": "Lodging near a venue for the group: hotels (CoStar average daily rates) for short stays, "
                       "apartment communities with availability and short-term lease info for long stays.",
        "input_schema": {
            "type": "object",
            "properties": {
                "venue_id": {"type": "integer"},
                "group_size": {"type": "integer"},
                "nights": {"type": "integer"},
                "radius_miles": {"type": "number", "description": "Default 8."},
            },
            "required": ["venue_id", "group_size", "nights"],
        },
    },
    {
        "name": "tour_budget",
        "description": "Check the group's tour fund (Capital One Nessie bank account) against this stop: "
                       "venue fee estimate, lodging, break-even ticket price and per-member share. Moves no money.",
        "input_schema": {
            "type": "object",
            "properties": {
                "venue_id": {"type": "integer"},
                "group_size": {"type": "integer"},
                "nights": {"type": "integer"},
                "audience": {"type": "integer"},
                "space_area_sqft": {"type": "number"},
            },
            "required": ["venue_id", "group_size", "nights", "audience"],
        },
    },
    {
        "name": "draft_outreach",
        "description": "Draft the inquiry email to the venue's listing broker or hotel sales team.",
        "input_schema": {
            "type": "object",
            "properties": {
                "venue_id": {"type": "integer"},
                "group_name": {"type": "string"},
                "event_date": {"type": "string"},
                "audience": {"type": "integer"},
                "group_size": {"type": "integer"},
                "nights": {"type": "integer"},
                "space_name": {"type": "string"},
            },
            "required": ["venue_id"],
        },
    },
]


class ClaudeScout:
    name = "claude"
    max_turns = 14

    def __init__(self):
        import anthropic
        self.anthropic = anthropic
        self.client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY, base_url="https://api.anthropic.com")

    def run(self, brief_text: str) -> Iterator[Event]:
        messages: list[dict] = [{"role": "user", "content": brief_text}]
        for _ in range(self.max_turns):
            try:
                response = self.client.beta.messages.create(
                    model=SCOUT_MODEL,
                    max_tokens=16000,
                    system=SYSTEM_PROMPT,
                    tools=TOOL_SCHEMAS,
                    thinking={"type": "adaptive"},
                    output_config={"effort": "medium"},
                    betas=["server-side-fallback-2026-07-01"],
                    fallbacks="default",
                    messages=messages,
                )
            except self.anthropic.APIStatusError as exc:
                yield {"type": "error", "text": f"Claude API error {exc.status_code}: {exc.message}"}
                return
            except self.anthropic.APIConnectionError as exc:
                yield {"type": "error", "text": f"Could not reach the Claude API: {exc}"}
                return

            if response.stop_reason == "refusal":
                yield {"type": "error", "text": "The model declined this request."}
                return
            for block in response.content:
                if block.type == "text" and block.text.strip():
                    yield {"type": "message", "text": block.text}
            messages.append({"role": "assistant", "content": response.content})
            if response.stop_reason != "tool_use":
                break

            results = []
            for block in response.content:
                if block.type != "tool_use":
                    continue
                if block.name not in scout.TOOLS:
                    out = {"error": f"Unknown tool {block.name}"}
                    yield {"type": "tool_result", "name": block.name, "result": out}
                else:
                    out = yield from _call(block.name, dict(block.input))
                results.append({"type": "tool_result", "tool_use_id": block.id,
                                "content": json.dumps(out, default=str)[:60000],
                                "is_error": "error" in out})
            messages.append({"role": "user", "content": results})
        yield {"type": "done", "brief": parse_brief(brief_text)}


def make_scout(prefer: str | None = None):
    """Deep Agents if SCOUT_LLM is set, else Claude directly if a key is set, else our planner."""
    import os
    if prefer == "planner":
        return PlannerScout()
    if os.environ.get("SCOUT_LLM"):
        from .deep_scout import DeepScout
        return DeepScout()
    if ANTHROPIC_API_KEY:
        return ClaudeScout()
    return PlannerScout()
