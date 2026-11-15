"""The scout as a LangChain Deep Agent.

Deep Agents gives us planning (write_todos), a virtual file system the agent
keeps its notes and final report in, and subagents it delegates to with the
task() tool. We use two specialists:

* acoustics-analyst - compares scanned rooms at shortlisted venues and picks
  the one whose estimated RT60 best fits the intended use.
* stay-planner      - checks the site from the air and finds lodging near the
  chosen venue, with a cost estimate.

The lead agent searches, delegates, drafts outreach and writes /report.md.

The model is any LangChain chat model, picked with SCOUT_LLM in .env:
    SCOUT_LLM=anthropic:claude-opus-5-5
    SCOUT_LLM=openrouter:<model id from openrouter.ai/collections/free-models>
"""

from __future__ import annotations

import json
import os
import queue
import threading
from typing import Iterator

from . import scout
from .agent import _call, parse_brief

SCOUT_LLM = os.environ.get("SCOUT_LLM", "")

LEAD_PROMPT = """You are Encore Scout, a location scout for touring performers (a cappella groups, choirs, \
and film crews). You use real CoStar, Matterport and Vexcel data for Los Angeles and Houston.

Work like this:
1. Use write_todos to lay out your plan from the brief: metro, group size, audience, nights, intended use \
(a_cappella_performance, choral_performance, rehearsal, recording, film_dialogue, amplified_show) and \
whether they want to stay and perform in the same building.
2. Call search_venues. If the matches are weak, change the parameters and search again.
3. Delegate to the acoustics-analyst subagent with the venue_ids of your top 3 and the use and audience; \
ask it which room fits best and why.
4. Delegate to the stay-planner subagent with the chosen venue_id, group size and nights.
5. Call draft_outreach for the chosen venue and room, then add_to_pipeline to track it.
If the brief lists several shows, call plan_tour with the whole brief instead. For Northern California or the
Florida Panhandle, use search_region_venues and the other region tools; those numbers are estimates.
6. Write the final recommendation to /report.md with write_file, then reply with the same text: the pick and \
why (cite RT60 and capacity), lodging with estimated cost, one or two backups, caveats. Under 150 words.

Write the recommendation the way a friend who books venues would text it: two short plain paragraphs, first \
person, no headings, no bullet points, no bold labels like "Sound:", no emoji, no em dashes, no sales language, no stock phrases like "sweet spot", "perfect for" or "plenty of room".

Acoustic numbers are physics estimates from scan geometry and assumed finishes; rates are CoStar averages. \
Never invent data the tools did not return."""

ACOUSTICS_PROMPT = """You are an acoustics analyst. For each venue_id you are given, call analyze_venue with \
the intended use and audience. Compare the rooms: prefer the room whose occupied RT60 lands inside the target \
band; a little dry beats very live; check capacity covers the audience. Return the best venue_id, room name, \
its RT60 (empty and occupied), capacity, and one sentence on why it beats the others. If the best room's \
reverb is outside the target, or the group has low basses, call plan_room for it and pass on the fix \
(how many sq ft of curtains or rugs) and any notes that boom."""

STAY_PROMPT = """You are a tour logistics planner. For the venue_id you are given, call site_check to judge \
parking and load-in from the aerial data, then find_housing with the group size and nights. Return the best \
lodging option with distance and estimated total cost, plus one line on parking / load-in. Then call \
tour_budget with the venue_id, group size, nights and audience to check the group's bank balance, and report \
whether the stop is affordable, the break-even ticket price and each member's share."""


def _make_model(spec: str):
    if spec.startswith("openrouter:"):
        from langchain_openai import ChatOpenAI
        return ChatOpenAI(model=spec.split(":", 1)[1], base_url="https://openrouter.ai/api/v1",
                          api_key=os.environ.get("OPENROUTER_API_KEY", ""), temperature=0.2)
    return spec  # "provider:model" strings are resolved by LangChain


class DeepScout:
    name = "deepagents"

    def __init__(self, spec: str | None = None):
        self.spec = spec or SCOUT_LLM

    def run(self, brief_text: str) -> Iterator[dict]:
        from datetime import date

        from deepagents import create_deep_agent

        # Same answer as the planner for a city we have no scanned rooms in, without spending a model run on it.
        brief = parse_brief(brief_text)
        if not brief["metro"]:
            yield {"type": "message", "text": f"None available in {brief['elsewhere']}. We only have scanned rooms in Los Angeles and Houston so far."}
            yield {"type": "done", "brief": brief, "none": "location"}
            return
        found = {"any": False}

        events: queue.Queue = queue.Queue()

        def traced(name):
            from .toolbox import all_tools
            fn = all_tools()[name]

            def tool(**kwargs):
                gen = _call(name, kwargs)
                result = None
                try:
                    while True:
                        events.put(next(gen))
                except StopIteration as stop:
                    result = stop.value
                if name == "search_venues" and isinstance(result, dict) and result.get("results"):
                    found["any"] = True
                return json.dumps(result, default=str)[:30000]

            tool.__name__ = name
            tool.__doc__ = fn.__doc__
            tool.__annotations__ = {k: v for k, v in fn.__annotations__.items()}
            tool.__annotations__["return"] = str
            import inspect
            tool.__signature__ = inspect.signature(fn).replace(return_annotation=str)
            return tool

        from .toolbox import all_tools
        tools = {n: traced(n) for n in all_tools()}
        extra = [tools[n] for n in ("plan_tour", "add_to_pipeline", "search_region_venues", "analyze_region_venue",
                                    "find_region_lodging") if n in tools]
        agent = create_deep_agent(
            model=_make_model(self.spec),
            tools=[tools["search_venues"], tools["draft_outreach"], *extra],
            system_prompt=LEAD_PROMPT + f"\n\nToday is {date.today():%A, %B %d, %Y}. A date with no year is the next one coming up.",
            subagents=[
                {"name": "acoustics-analyst",
                 "description": "Compares the scanned rooms at shortlisted venues and picks the one whose "
                                "estimated reverberation best fits the intended use and audience.",
                 "system_prompt": ACOUSTICS_PROMPT,
                 "tools": [tools["analyze_venue"]] + ([tools["plan_room"]] if "plan_room" in tools else [])},
                {"name": "stay-planner",
                 "description": "Checks parking and load-in from aerial data, finds lodging near a chosen "
                                "venue, and checks the cost against the group's tour fund.",
                 "system_prompt": STAY_PROMPT,
                 "tools": [tools["site_check"], tools["find_housing"], tools["tour_budget"]]},
            ],
            name="encore-scout",
        )

        done = threading.Event()
        final: dict = {}

        def worker():
            try:
                for chunk in agent.stream({"messages": [{"role": "user", "content": brief_text}]},
                                          stream_mode="updates", subgraphs=True):
                    for ev in _safe_translate(chunk):
                        events.put(ev)
                    final["last"] = chunk
            except Exception as exc:
                events.put({"type": "error", "text": f"{type(exc).__name__}: {exc}"})
            finally:
                done.set()

        threading.Thread(target=worker, daemon=True).start()
        while not (done.is_set() and events.empty()):
            try:
                yield events.get(timeout=0.2)
            except queue.Empty:
                continue
        yield {"type": "done", "brief": brief, **({} if found["any"] else {"none": "audience"})}


def _safe_translate(chunk) -> list[dict]:
    """Never let a display hiccup on one update stop the agent run."""
    try:
        return _translate(chunk)
    except Exception:
        return []


def _translate(chunk) -> list[dict]:
    """Turn Deep Agents graph updates into the UI's event stream."""
    namespace, update = chunk if isinstance(chunk, tuple) else ((), chunk)
    in_subagent = bool(namespace)
    out = []
    for node in (update or {}).values():
        if not isinstance(node, dict):
            continue
        for msg in node.get("messages") or []:
            calls = getattr(msg, "tool_calls", None) or []
            for call in calls:
                if call["name"] == "write_todos":
                    args = call.get("args") or {}
                    if isinstance(args, str):
                        try:
                            args = json.loads(args)
                        except ValueError:
                            args = {}
                    todos = args.get("todos") or [] if isinstance(args, dict) else []
                    if isinstance(todos, str):  # some models send the list as a JSON string
                        try:
                            todos = json.loads(todos)
                        except ValueError:
                            todos = [todos]
                    if isinstance(todos, dict):
                        todos = [todos]
                    steps = [t.get("content", "") if isinstance(t, dict) else str(t) for t in todos]
                    out.append({"type": "plan", "text": " -> ".join(x for x in steps if x)})
                elif call["name"] == "task":
                    out.append({"type": "delegate", "agent": call["args"].get("subagent_type"),
                                "text": call["args"].get("description", "")[:300]})
                elif call["name"] == "write_file":
                    out.append({"type": "file", "path": call["args"].get("file_path")})
            if getattr(msg, "type", "") == "ai" and not calls and not in_subagent:
                text = msg.content if isinstance(msg.content, str) else "".join(
                    b.get("text", "") for b in msg.content if isinstance(b, dict))
                if text.strip():
                    out.append({"type": "message", "text": text})
    return out
