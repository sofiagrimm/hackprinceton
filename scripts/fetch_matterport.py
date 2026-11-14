"""Cache the name and room geometry of every Matterport scan in the venue index.

Matterport model names describe the captured space ("Theatre", "Clubhouse",
"Lobby", "1BR, 1BA - 695SF"), and the Model API returns per-room tags and
dimension estimates. Both are what the agent needs to find performable rooms,
so we fetch them once, in batches using GraphQL aliases, and cache the result
to data/index/models.json. Safe to re-run: already-cached models are skipped.

    python scripts/fetch_matterport.py
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import httpx
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
INDEX = ROOT / "data" / "index"
OUT = INDEX / "models.json"
API = "https://api.matterport.com/api/models/graph"
BATCH = 20

FIELDS = """
  id name
  rooms { tags dimensionEstimates { area width depth height units } }
"""


def fetch_batch(client: httpx.Client, ids: list[str]) -> dict[str, dict | None]:
    parts = [f'm{i}: model(id: "{mid}") {{ {FIELDS} }}' for i, mid in enumerate(ids)]
    query = "query {" + "\n".join(parts) + "}"
    for attempt in range(5):
        r = client.post(API, json={"query": query}, timeout=120)
        if r.status_code == 429 or r.status_code >= 500:
            time.sleep(2 ** attempt)
            continue
        r.raise_for_status()
        data = r.json().get("data") or {}
        return {mid: data.get(f"m{i}") for i, mid in enumerate(ids)}
    raise RuntimeError(f"Matterport API kept failing ({r.status_code})")


def compact(model: dict | None) -> dict | None:
    if not model:
        return None
    rooms = []
    for room in model.get("rooms") or []:
        dims = room.get("dimensionEstimates") or {}
        rooms.append({
            "tags": room.get("tags") or [],
            "area": dims.get("area"),
            "width": dims.get("width"),
            "depth": dims.get("depth"),
            "height": dims.get("height"),
            "units": dims.get("units"),
        })
    return {"name": model.get("name"), "rooms": rooms}


def main() -> int:
    load_dotenv(ROOT / ".env")
    key, token = os.environ.get("MATTERPORT_API_KEY"), os.environ.get("MATTERPORT_API_TOKEN")
    if not key or not token:
        print("Set MATTERPORT_API_KEY and MATTERPORT_API_TOKEN in .env")
        return 1

    venues = json.loads((INDEX / "venues.json").read_text())
    wanted = sorted({mid for v in venues for mid in v["matterport_models"]})
    cache: dict = json.loads(OUT.read_text()) if OUT.exists() else {}
    todo = [mid for mid in wanted if mid not in cache]
    print(f"{len(wanted)} models, {len(todo)} to fetch")

    with httpx.Client(auth=(key, token)) as client:
        for start in range(0, len(todo), BATCH):
            ids = todo[start:start + BATCH]
            try:
                for mid, model in fetch_batch(client, ids).items():
                    cache[mid] = compact(model)
            except Exception as exc:  # keep going; a re-run picks up the gaps
                print(f"batch at {start} failed: {exc}")
                continue
            if (start // BATCH) % 25 == 0:
                OUT.write_text(json.dumps(cache))
                print(f"  {min(start + BATCH, len(todo))}/{len(todo)}")
    OUT.write_text(json.dumps(cache))
    print(f"cached {sum(1 for v in cache.values() if v)} models -> {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
