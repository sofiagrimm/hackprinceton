"""Each venue's pictures, chosen once on the server instead of in every visitor's browser.

The page used to work this out per card: ask Matterport for the venue's rooms (seconds),
download four walls of up to eight rooms' 360 photos (dozens of images) and score them in
the browser. Now the server does it once, keeps the answer on disk, and starts on the
Browse and shelf venues as soon as it boots, so their cards show a picture straight away.

The ranking and the photo score are the same as the page's (layout.js rankRooms/photoScore).
"""

from __future__ import annotations

import io
import json
import math
import re
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from .config import CACHE_DIR

DULL = re.compile(r"fitness|gym|bath|rest ?room|toilet|\bwc\b|powder|closet|laundry|storage|utility|mechanical|electrical|"
                  r"elevator|stair|corridor|hallway|garage|janitor|trash|locker|shower|server|mail|bedroom|kitchen(?!.*living)", re.I)
SHOWY = re.compile(r"ballroom|lounge|rooftop|roof|terrace|hall\b|theat|stage|studio|gallery|atrium|chapel|sanctuary|auditorium|"
                   r"event|great room|club|courtyard|pool|bar\b|library|lobby|living|loft|music|dance|ballet|meeting|conference", re.I)
ROOMS_TO_SCORE = 4
OUT = CACHE_DIR / "pictures"
_mem: dict[int, list[str]] = {}
_locks: dict[int, threading.Lock] = {}
_pool = ThreadPoolExecutor(max_workers=4)


def _rank(rooms: list[dict], model: str | None) -> list[dict]:
    def score(r):
        text = f"{r.get('room') or ''} {r.get('scan') or ''}"
        return math.log10((r.get("area_sqft") or 100) + 10) * 2 + (2 if SHOWY.search(text) else 0) + (1.5 if r.get("model_id") == model else 0)
    keep = [r for r in rooms if not DULL.search(f"{r.get('room') or ''} {r.get('scan') or ''}")]
    return sorted(keep, key=score, reverse=True)


def photo_score(jpeg: bytes) -> float:
    """Colourful, well exposed, with detail; penalise blank white walls (same as the page's)."""
    import numpy as np
    from PIL import Image
    img = Image.open(io.BytesIO(jpeg)).convert("RGB").resize((48, 48))
    d = np.asarray(img, dtype=np.float32)
    r, g, b = d[..., 0], d[..., 1], d[..., 2]
    L = 0.299 * r + 0.587 * g + 0.114 * b
    a, y = r - g, 0.5 * (r + g) - b
    mean, std = L.mean(), L.std()
    color = math.hypot(a.std(), y.std()) + 0.3 * math.hypot(a.mean(), y.mean())
    edges = np.abs(np.diff(L, axis=1)).mean()
    exposure = (55 - mean) * 1.5 if mean < 55 else (mean - 215) * 1.5 if mean > 215 else 0
    clinical = 25 if mean > 165 and color < 26 else 0
    return float(color + std * 0.6 + edges * 2 - exposure - clinical)


def _best_face(room: dict) -> tuple[str, float] | None:
    from .panos import face_small, CACHE_DIR as PC
    best = None
    for f in (1, 2, 3, 4):
        jpeg = face_small(room["model_id"], room["pano_id"], f)
        # the full-size face is only a stepping stone; don't keep 850 KB of it on disk
        full = PC / f"pano_{room['model_id']}_{room['pano_id']}_{f}.jpg"
        if full.exists():
            full.unlink(missing_ok=True)
        if not jpeg:
            continue
        s = photo_score(jpeg)
        if best is None or s > best[1]:
            best = (f"/api/pano/{room['model_id']}/{room['pano_id']}/{f}.jpg", s)
    return best


def pictures(venue_id: int) -> list[str]:
    """Best inside view first, then the CoStar photo, other rooms, then the building from four sides."""
    venue_id = int(venue_id)
    if venue_id in _mem:
        return _mem[venue_id]
    path = OUT / f"{venue_id}.json"
    if path.exists():
        _mem[venue_id] = json.loads(path.read_text())
        return _mem[venue_id]
    with _locks.setdefault(venue_id, threading.Lock()):
        if venue_id in _mem:
            return _mem[venue_id]
        from . import data
        from .panos import rooms_for_venue
        v = data.venues().get(venue_id) or {}
        model = (v.get("matterport_models") or [None])[0]
        model = model.get("id") if isinstance(model, dict) else model
        try:
            ranked = _rank(rooms_for_venue(venue_id), model)[:ROOMS_TO_SCORE]
        except Exception:
            ranked = []
        views = []
        for i, room in enumerate(ranked):
            hit = _best_face(room)
            if hit:
                views.append((hit[0], hit[1] + ([14, 8, 3][i] if i < 3 else 0)))
        inside = [u for u, _ in sorted(views, key=lambda x: -x[1])]
        urls = inside[:1] + ([v["photo"]] if v.get("photo") else []) + inside[1:] + \
            [f"/api/film/{venue_id}/oblique/{s}.jpg" for s in "snew"]
        OUT.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(urls))
        _mem[venue_id] = urls
        return urls


def quick(venue_id: int) -> list[str]:
    """Never make a page wait: the finished list if we have it, otherwise the CoStar photo and the
    aerial views right away while the inside views are worked out in the background."""
    venue_id = int(venue_id)
    if venue_id in _mem or (OUT / f"{venue_id}.json").exists():
        return pictures(venue_id)
    from . import data
    v = data.venues().get(venue_id) or {}
    _pool.submit(lambda: _safe(venue_id))
    return ([v["photo"]] if v.get("photo") else []) + [f"/api/film/{venue_id}/oblique/{s}.jpg" for s in "snew"]


def warm(venue_ids: list[int]) -> None:
    """Prepare these venues in the background, in order (the first cards on the page first)."""
    for vid in venue_ids:
        _pool.submit(lambda v=vid: _safe(v))


def _safe(vid: int) -> None:
    try:
        pictures(vid)
    except Exception:
        pass


def warm_on_boot() -> None:
    ids: list[int] = []
    try:
        ids += json.loads(Path(__file__).with_name("browse_venues.json").read_text())["venue_ids"]
    except Exception:
        pass
    # the opening page's and search shelf's venues, and the demo default
    shelf = [6531330, 9530669, 9956355, 9438497, 10183484, 5316122]
    order = list(dict.fromkeys(shelf + ids))
    threading.Thread(target=warm, args=(order,), daemon=True).start()
