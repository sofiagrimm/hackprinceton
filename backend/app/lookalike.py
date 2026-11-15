"""Find rooms that look like a picture: a film still, a mood-board frame, a phone photo of a set.

Every room we have a 360 photo for is already on disk as four wall views (the same files the
cards use). Each view is boiled down to a "look": its colour palette (a 2D histogram of hue in
Lab space), how light falls across the frame (a 4x4 grid of brightness, so a bright window on the
left matches a bright window on the left), and a few plain numbers: how bright, how contrasty,
how colourful, how warm, how much fine detail. The upload gets the same treatment and the
nearest rooms come back, one per venue, with the wall that matched best.

It is a colour-and-light match, not object recognition: a candle-lit dining room will find other
dim, amber rooms. `rerank` adds what's in the picture when OPENROUTER_API_KEY is set: a free
vision model names the kind of space, rooms with matching scan labels move up, and the model then
compares the shortlist with the picture by eye and says why each fits.
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

from .config import CACHE_DIR

INDEX = CACHE_DIR / "lookalike_index.json"
FACE = re.compile(r"^pano_(?P<model>[A-Za-z0-9]+)_(?P<pano>[a-z0-9]+)_(?P<face>[1-4])_1024\.jpg$")

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
    return {"token": token, "look": qwords, "rooms_compared": len(scored), "results": results, "can_rerank": bool(_key())}


# ------------------------------------------------------------------ what's in the picture (free vision models via OpenRouter)
#
# (These are reasoning models: they think before answering, so they get a generous token budget.)
# Colour and light alone can't tell a diner from a chapel. When OPENROUTER_API_KEY is set, a free vision
# model says what kind of space the picture shows; rooms whose scan labels match ("kitchen", "lobby",
# "ballroom") move up; then the model looks at the shortlist next to the picture and reorders it.

OPENROUTER = "https://openrouter.ai/api/v1/chat/completions"
VISION_MODELS = ["nvidia/nemotron-3.5-super-vl:free", "google/gemma-4-31b-it:free", "google/gemma-4-26b-a4b-it:free", "openrouter/free"]
LABELS = CACHE_DIR / "lookalike_labels.json"
_labels: dict[str, dict] | None = None


def _key() -> str:
    import os
    return os.environ.get("OPENROUTER_API_KEY", "")


def _data_url(jpeg: bytes, size: int = 384) -> str:
    from PIL import Image
    img = Image.open(io.BytesIO(jpeg)).convert("RGB")
    img.thumbnail((size, size))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=80)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


def _ask(content: list[dict], max_tokens: int = 4000) -> dict | None:
    """One question to the first free vision model that answers; the reply's JSON, or None."""
    import httpx
    for model in VISION_MODELS:
        try:
            r = httpx.post(OPENROUTER, headers={"Authorization": f"Bearer {_key()}"}, timeout=90,
                           json={"model": model, "max_tokens": max_tokens, "messages": [{"role": "user", "content": content}]})
            if r.status_code != 200:
                continue
            text = r.json()["choices"][0]["message"].get("content") or ""
            text = text[text.find("{"): text.rfind("}") + 1]
            if text:
                return json.loads(text)
        except Exception:
            continue
    return None


def _room_labels() -> dict[str, dict]:
    global _labels
    if _labels is None:
        try:
            _labels = json.loads(LABELS.read_text())
        except Exception:
            _labels = {}
    return _labels


def label_rooms(limit: int | None = None) -> int:
    """Learn the scan's room name for each photographed spot (Matterport labels: kitchen, lobby...)."""
    from .panos import _model
    labels = _room_labels()
    models = sorted({m["model"] for n in _load() if (m := FACE.match(n))} - set(labels))
    done = 0
    for model_id in models[:limit] if limit else models:
        model = _model(model_id)
        if model is None:
            continue
        rooms = {r["id"]: " / ".join(c["label"] for c in r.get("classifications") or [] if c.get("label")) for r in model.get("rooms") or []}
        panos = {p["id"]: rooms.get(((p.get("anchor") or {}).get("room") or {}).get("id"), "") for p in model.get("panoLocations") or []}
        labels[model_id] = {"scan": model.get("name") or "", "panos": {k: v for k, v in panos.items() if v}}
        done += 1
        if done % 25 == 0:
            LABELS.write_text(json.dumps(labels))
    if done:
        LABELS.write_text(json.dumps(labels))
    return done


def _place_words(model_id: str, pano_id: str, venue: dict) -> str:
    lab = _room_labels().get(model_id) or {}
    return " ".join([(lab.get("panos") or {}).get(pano_id, ""), lab.get("scan", ""), venue.get("subtype") or "", venue.get("property_type") or ""]).lower()


def rerank(token: str, results: list[dict]) -> dict:
    """Bring in what's in the picture: describe it, favour rooms of the same kind, then compare by eye."""
    ref = _uploads.get(token)
    if not (_key() and ref):
        return {"results": results, "reranked": False}
    from . import data
    from .panos import face_small
    ref_url = _data_url(ref)
    seen_as = _ask([
        {"type": "text", "text": "A film crew is looking for a location like this picture. What kind of space is it? Reply with JSON only: "
                                 '{"space": "the room type in 1-3 plain words, e.g. kitchen, church, diner, office, warehouse, ballroom, lobby", '
                                 '"keywords": ["3 to 6 single words for what is in it: materials, furniture, architecture, era"], '
                                 '"summary": "the place in under 10 words, lowercase, no full stop"}'},
        {"type": "image_url", "image_url": {"url": ref_url}}]) or {}
    words = {w.lower() for w in re.findall(r"[a-zA-Z]{4,}", " ".join([str(seen_as.get("space", ""))] + [str(k) for k in seen_as.get("keywords") or []]))}
    words -= {"room", "with", "space", "area", "interior", "indoor", "light", "lighting", "modern"}
    # rescore every room view: the look, minus a bonus for being the same kind of place
    q = look(ref)
    owner = _venues_by_model()
    venues = data.venues()
    best: dict[int, tuple[float, str, re.Match, int]] = {}
    for name, v in _load().items():
        m = FACE.match(name)
        if not v or not m or m["model"] not in owner:
            continue
        vid = owner[m["model"]]
        place = _place_words(m["model"], m["pano"], venues.get(vid) or {})
        hits = sum(1 for w in words if w in place or w.rstrip("s") in place)
        d = _distance(q, v) - 0.45 * min(hits, 2)
        if vid not in best or d < best[vid][0]:
            best[vid] = (d, name, m, hits)
    shortlist = sorted(best.items(), key=lambda kv: kv[1][0])[:10]
    cands = []
    for vid, (d, name, m, hits) in shortlist:
        v = venues.get(vid) or {}
        room = ((_room_labels().get(m["model"]) or {}).get("panos") or {}).get(m["pano"], "")
        cands.append({
            "venue_id": vid, "name": v.get("name") or "A venue",
            "city": ", ".join(x for x in (v.get("city"), v.get("state")) if x),
            "picture": f"/api/pano/{m['model']}/{m['pano']}/{m['face']}.jpg",
            "match": max(1, min(99, round(100 * (1 - (d + 0.45 * min(hits, 2)) / 1.6)) + 8 * min(hits, 2))),
            "shared": [], "look": _words(_load()[name]),
            "why": f"Also a {room.lower()}." if hits and room else "",
        })
    # the model looks at the shortlist next to the picture and reorders it
    content: list[dict] = [{"type": "text", "text": "Reference picture a film crew wants to match:"}, {"type": "image_url", "image_url": {"url": ref_url}}]
    shown = []
    for c in cands:
        mm = re.match(r"/api/pano/([^/]+)/([^/]+)/(\d)\.jpg", c["picture"])
        img = mm and face_small(mm[1], mm[2], int(mm[3]), 256)
        if img:
            shown.append(c)
            content += [{"type": "text", "text": f"Room {len(shown)}:"}, {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(img).decode()}}]
    content.append({"type": "text", "text": "Rank the rooms by how well each could stand in for the reference: kind of space, architecture, materials, "
                                            "era and mood matter more than exact colour. Reply with JSON only: "
                                            '{"order": [room numbers, best first], "why": {"1": "one short plain sentence about what it shares with the reference"}}'})
    verdict = _ask(content, 6000) if shown else None
    if verdict:
        try:
            order = [int(i) for i in verdict.get("order", []) if 1 <= int(i) <= len(shown)]
            order = list(dict.fromkeys(order)) + [i for i in range(1, len(shown) + 1) if i not in order]
            why = verdict.get("why") or {}
            ranked = []
            for rank, i in enumerate(order):
                c = dict(shown[i - 1])
                c["why"] = str(why.get(str(i)) or c["why"])[:180]
                c["match"] = max(c["match"], 96 - 4 * rank) if rank < 3 else c["match"]
                ranked.append(c)
            shown = ranked
        except Exception:
            pass
    return {"results": shown or results, "reranked": True, "seen_as": str(seen_as.get("space") or seen_as.get("summary") or "").lower().strip(" .")[:60]}


def label_in_background() -> None:
    threading.Thread(target=lambda: (refresh(), label_rooms()), daemon=True).start()
