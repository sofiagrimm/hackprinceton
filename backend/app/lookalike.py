"""Find rooms that look like a picture: a film still, a mood-board frame, a phone photo of a set.

Every room we have a 360 photo for is already on disk as four wall views (the same files the
cards use). Each view is boiled down to a "look": its colour palette (a 2D histogram of hue in
Lab space), how light falls across the frame (a 4x4 grid of brightness, so a bright window on the
left matches a bright window on the left), and a few plain numbers: how bright, how contrasty,
how colourful, how warm, how much fine detail. The upload gets the same treatment and the
nearest rooms come back, one per venue, with the wall that matched best.

It is a colour-and-light match, not object recognition: a candle-lit dining room will find other
dim, amber rooms, which is what a cinematographer scouting a look usually wants. When an
Anthropic key is set, `rerank` asks Claude to look at the reference and the shortlist side by
side and reorder them by the whole feel of the space, with a line on why.
"""

from __future__ import annotations

import base64
import io
import json
import re
import threading
import uuid
from collections import OrderedDict
from pathlib import Path

from .config import ANTHROPIC_API_KEY, CACHE_DIR

INDEX = CACHE_DIR / "lookalike_index.json"
FACE = re.compile(r"^pano_(?P<model>[A-Za-z0-9]+)_(?P<pano>[a-z0-9]+)_(?P<face>[1-4])_1024\.jpg$")
LOOK_MODEL = "claude-sonnet-5-5"

_lock = threading.Lock()
_index: dict[str, list[float]] | None = None
_uploads: "OrderedDict[str, bytes]" = OrderedDict()  # recent references, for the rerank step


# ------------------------------------------------------------------ the look of one picture

def _lab(rgb):
    import numpy as np
    c = rgb / 255.0
    c = np.where(c > 0.04045, ((c + 0.055) / 1.055) ** 2.4, c / 12.92)
    xyz = c @ np.array([[0.4124, 0.2126, 0.0193], [0.3576, 0.7152, 0.1192], [0.1805, 0.0722, 0.9505]])
    xyz /= np.array([0.9505, 1.0, 1.089])
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    L = 116 * f[..., 1] - 16
    a = 500 * (f[..., 0] - f[..., 1])
    b = 200 * (f[..., 1] - f[..., 2])
    return L, a, b


def look(jpeg: bytes) -> list[float]:
    """A picture's look as one flat list of numbers (see the module notes for what's in it)."""
    import numpy as np
    from PIL import Image
    img = Image.open(io.BytesIO(jpeg))
    img.draft("RGB", (160, 160))  # decode a JPEG at reduced size: we only need 64px
    img = img.convert("RGB")
    # centre-crop to square: the room views are square, uploads are usually 16:9
    w, h = img.size
    s = min(w, h)
    img = img.crop(((w - s) // 2, (h - s) // 2, (w - s) // 2 + s, (h - s) // 2 + s)).resize((64, 64), Image.BILINEAR)
    L, a, b = _lab(np.asarray(img, dtype=np.float32))
    chroma = np.hypot(a, b)
    # palette: hue/chroma of the coloured pixels, plus how much is near-neutral
    ab, _, _ = np.histogram2d(np.clip(a, -39.9, 39.9).ravel(), np.clip(b, -39.9, 39.9).ravel(), bins=6, range=[[-40, 40], [-40, 40]],
                              weights=(0.3 + np.minimum(chroma, 40) / 40).ravel())
    ab = ab.ravel() / max(ab.sum(), 1e-6)
    lh, _ = np.histogram(L.ravel(), bins=8, range=(0, 100))
    lh = lh / max(lh.sum(), 1e-6)
    grid = L.reshape(4, 16, 4, 16).mean(axis=(1, 3)).ravel() / 100
    gx = np.abs(np.diff(L, axis=1)).mean()
    gy = np.abs(np.diff(L, axis=0)).mean()
    stats = [L.mean() / 100, L.std() / 50, chroma.mean() / 40, b.mean() / 30, a.mean() / 30, (gx + gy) / 20, gx / max(gx + gy, 1e-6)]
    return [round(float(x), 5) for x in [*ab, *lh, *grid, *stats]]


def _split(v):
    import numpy as np
    v = np.asarray(v, dtype=np.float32)
    return v[:36], v[36:44], v[44:60], v[60:67]


def _distance(q, m) -> float:
    import numpy as np
    qa, ql, qg, qs = _split(q)
    ma, ml, mg, ms = _split(m)
    hell = lambda x, y: float(np.sqrt(0.5 * ((np.sqrt(x) - np.sqrt(y)) ** 2).sum()))
    # a mirrored frame is the same look: compare the light layout both ways round
    qg2 = qg.reshape(4, 4)[:, ::-1].ravel()
    layout = min(float(np.abs(qg - mg).mean()), float(np.abs(qg2 - mg).mean()))
    w = np.array([1.4, 0.9, 1.2, 1.4, 1.0, 0.7, 0.3])
    stats = float((w * np.abs(qs - ms)).sum() / w.sum())
    return 1.1 * hell(qa, ma) + 0.8 * hell(ql, ml) + 1.6 * layout + 1.8 * stats


# ------------------------------------------------------------------ the index of every room view on disk

def _load() -> dict[str, list[float]]:
    global _index
    if _index is None:
        try:
            _index = json.loads(INDEX.read_text())
        except Exception:
            _index = {}
    return _index


def refresh(limit: int | None = None) -> int:
    """Add any room views downloaded since last time. Returns how many were added."""
    with _lock:
        idx = _load()
        new = [p for p in CACHE_DIR.glob("pano_*_1024.jpg") if p.name not in idx and FACE.match(p.name)]
        for p in new[:limit] if limit else new:
            try:
                idx[p.name] = look(p.read_bytes())
            except Exception:
                idx[p.name] = []
        if new:
            INDEX.write_text(json.dumps(idx))
        return len(new)


def refresh_in_background() -> None:
    threading.Thread(target=refresh, daemon=True).start()


def _venues_by_model() -> dict[str, int]:
    from . import data
    out: dict[str, int] = {}
    for vid, v in data.venues().items():
        for m in v.get("matterport_models") or []:
            out.setdefault(m.get("id") if isinstance(m, dict) else m, vid)
    return out


def _words(v) -> list[str]:
    """The look in plain words, from the numbers."""
    _, _, _, s = _split(v)
    bright, contrast, colour, warm = float(s[0]), float(s[1]), float(s[2]), float(s[3])
    out = []
    out.append("dim and moody" if bright < 0.36 else "bright and airy" if bright > 0.62 else "evenly lit")
    out.append("warm, amber light" if warm > 0.32 else "cool, bluish light" if warm < 0.05 else "neutral light")
    out.append("rich colour" if colour > 0.42 else "muted, quiet colour" if colour < 0.2 else "")
    out.append("hard contrast" if contrast > 0.5 else "soft, flat contrast" if contrast < 0.28 else "")
    return [w for w in out if w]


def search(jpeg: bytes, n: int = 12) -> dict:
    """The rooms that look most like this picture, best first, one per venue."""
    from . import data
    refresh(limit=400)  # pick up rooms fetched since the index was built, a few hundred at a time
    q = look(jpeg)
    owner = _venues_by_model()
    venues = data.venues()
    scored = []
    for name, v in _load().items():
        m = FACE.match(name)
        if not v or not m or m["model"] not in owner:
            continue
        scored.append((_distance(q, v), name, m))
    scored.sort(key=lambda x: x[0])
    seen: set[int] = set()
    results = []
    qwords = _words(q)
    for dist, name, m in scored:
        vid = owner[m["model"]]
        if vid in seen:
            continue
        seen.add(vid)
        v = venues.get(vid) or {}
        mw = _words(_load()[name])
        results.append({
            "venue_id": vid,
            "name": v.get("name") or "A venue",
            "city": ", ".join(x for x in (v.get("city"), v.get("state")) if x),
            "picture": f"/api/pano/{m['model']}/{m['pano']}/{m['face']}.jpg",
            "match": max(1, min(99, round(100 * (1 - dist / 1.6)))),
            "shared": [w for w in mw if w in qwords][:3],
            "look": mw,
        })
        if len(results) >= n:
            break
    token = uuid.uuid4().hex
    _uploads[token] = jpeg
    while len(_uploads) > 20:
        _uploads.popitem(last=False)
    return {"token": token, "look": qwords, "rooms_compared": len(scored), "results": results, "can_rerank": bool(ANTHROPIC_API_KEY)}


# ------------------------------------------------------------------ optional: Claude looks at the shortlist

def _small(jpeg: bytes, size: int = 384) -> str:
    from PIL import Image
    img = Image.open(io.BytesIO(jpeg)).convert("RGB")
    img.thumbnail((size, size))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=80)
    return base64.b64encode(buf.getvalue()).decode()


def rerank(token: str, results: list[dict]) -> dict:
    """Ask Claude to reorder the shortlist by the feel of the space, with a reason for each."""
    if not ANTHROPIC_API_KEY:
        return {"results": results, "reranked": False}
    ref = _uploads.get(token)
    if not ref:
        return {"results": results, "reranked": False}
    from .panos import face_small
    content: list[dict] = [
        {"type": "text", "text": "Reference frame (a film/photo the user wants to match):"},
        {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": _small(ref)}},
    ]
    kept = []
    for r in results[:10]:
        m = re.match(r"/api/pano/([^/]+)/([^/]+)/(\d)\.jpg", r["picture"])
        img = m and face_small(m[1], m[2], int(m[3]), 384)
        if not img:
            continue
        kept.append(r)
        content += [{"type": "text", "text": f"Room {len(kept)}: {r['name']}"},
                    {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": base64.b64encode(img).decode()}}]
    if not kept:
        return {"results": results, "reranked": False}
    content.append({"type": "text", "text": (
        "You are helping a film location scout. Rank the rooms by how well each could stand in for the reference: "
        "architecture, era, materials, scale, light quality and mood count more than exact colour. "
        "Reply with JSON only: {\"order\": [room numbers, best first], \"why\": {\"<room number>\": \"one short plain sentence, under 16 words\"}}")})
    try:
        import anthropic
        client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY, base_url="https://api.anthropic.com")
        resp = client.messages.create(model=LOOK_MODEL, max_tokens=800, messages=[{"role": "user", "content": content}])
        text = "".join(b.text for b in resp.content if getattr(b, "type", "") == "text")
        data = json.loads(text[text.find("{"): text.rfind("}") + 1])
        order = [int(i) for i in data.get("order", []) if 1 <= int(i) <= len(kept)]
        order += [i for i in range(1, len(kept) + 1) if i not in order]
        out = []
        for i in order:
            r = dict(kept[i - 1])
            r["why"] = str((data.get("why") or {}).get(str(i), ""))[:160]
            out.append(r)
        return {"results": out + results[10:], "reranked": True}
    except Exception:
        return {"results": results, "reranked": False}
