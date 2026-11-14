"""Cache Matterport's generated description of every scan in the venue index.

Matterport writes a plain-English description for each scan ("large-format tile
flooring", "floor-to-ceiling windows", "leather seating"). backend/app/materials.py
reads the finishes out of it, which is what the acoustics need. Safe to re-run.

    python scripts/fetch_descriptions.py
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
OUT = INDEX / "descriptions.json"
API = "https://api.matterport.com/api/models/graph"
BATCH = 20


def main() -> int:
    load_dotenv(ROOT / ".env")
    auth = (os.environ.get("MATTERPORT_API_KEY", ""), os.environ.get("MATTERPORT_API_TOKEN", ""))
    if not all(auth):
        print("Set MATTERPORT_API_KEY and MATTERPORT_API_TOKEN in .env")
        return 1
    models = json.loads((INDEX / "models.json").read_text())
    # Only scans that can hold a performance: skip unit and room scans with no big indoor room.
    wanted = sorted(mid for mid, m in models.items()
                    if m and any((r.get("area") or 0) >= 250 for r in m.get("rooms") or []))
    cache = json.loads(OUT.read_text()) if OUT.exists() else {}
    todo = [m for m in wanted if m not in cache]
    print(f"{len(wanted)} scans with a big room, {len(todo)} to fetch")
    with httpx.Client(auth=auth) as client:
        for start in range(0, len(todo), BATCH):
            ids = todo[start:start + BATCH]
            query = "query {" + " ".join(
                f'm{i}: model(id: "{mid}") {{ generatedDescription {{ summary description }} }}'
                for i, mid in enumerate(ids)) + "}"
            for attempt in range(5):
                try:
                    r = client.post(API, json={"query": query}, timeout=120)
                except httpx.HTTPError:
                    time.sleep(2 ** attempt)
                    continue
                if r.status_code in (429, 500, 502, 503, 504):
                    time.sleep(2 ** attempt)
                    continue
                break
            data = (r.json().get("data") or {}) if r.status_code == 200 else {}
            for i, mid in enumerate(ids):
                gd = ((data.get(f"m{i}") or {}).get("generatedDescription")) or {}
                cache[mid] = {"summary": gd.get("summary"), "description": gd.get("description")}
            if (start // BATCH) % 20 == 0:
                OUT.write_text(json.dumps(cache))
                print(f"  {min(start + BATCH, len(todo))}/{len(todo)}", flush=True)
    OUT.write_text(json.dumps(cache))
    print(f"cached {sum(1 for v in cache.values() if v.get('description'))} descriptions")
    return 0


if __name__ == "__main__":
    sys.exit(main())
