"""List the venues the Browse by acoustics and Browse by lighting pages show.

A venue makes the list when it has measured rooms, a cover photo and at least one
indoor room with a 360 photo on Matterport (so the lighting lab has something to show).

    python scripts/build_browse.py     (needs the data index and Matterport keys)
"""

from __future__ import annotations

import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app import data, panos, scout  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "backend" / "app" / "browse_venues.json"


def main() -> None:
    ids = [v["id"] for v in data.venues().values()
           if v.get("photo") and scout._spaces_for_venue(v, "a_cappella_performance", 80)]
    with ThreadPoolExecutor(8) as pool:
        counts = dict(zip(ids, pool.map(lambda i: len(panos.rooms_for_venue(i)), ids)))
    keep = sorted(i for i, n in counts.items() if n > 0)
    OUT.write_text(json.dumps({
        "about": "Venues shown on the Browse by acoustics and Browse by lighting pages: each has measured rooms, "
                 "a cover photo and at least one 360 photo. Rebuild with scripts/build_browse.py.",
        "venue_ids": keep,
    }))
    print(f"{len(keep)} of {len(ids)} venues with rooms and a cover photo have a 360 photo -> {OUT.name}")


if __name__ == "__main__":
    main()
