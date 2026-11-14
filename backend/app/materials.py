"""Read a room's finishes out of Matterport's description of the scan.

Matterport writes a description for every scan, e.g. "light-toned large-format
tile flooring and textured wall paneling ... floor-to-ceiling windows ... tan and
black leather armchairs". Finishes decide how much sound a room soaks up, so we
pull them out with a small vocabulary instead of guessing from the room type.
The phrases we matched are returned as evidence so the UI can show its work.
"""

from __future__ import annotations

import json
import re
from functools import lru_cache

from .config import INDEX_DIR

# (pattern, surface, material) - first match per surface wins, so list specific phrases first.
RULES: list[tuple[str, str, str]] = [
    # floors
    (r"carpet(ed|ing)?", "floor", "carpet"),
    (r"(marble|terrazzo|stone|travertine|granite) (floor|flooring|tile)", "floor", "polished_stone"),
    (r"polished concrete|concrete floor|sealed concrete", "floor", "concrete"),
    (r"(large-format |porcelain |ceramic )?tile(d)? (floor|flooring)|tile flooring", "floor", "tile"),
    (r"(hardwood|wood|wood-look|plank|parquet|engineered wood|laminate)[\w\s-]{0,20}(floor|flooring)", "floor", "wood_floor"),
    (r"(vinyl|lvp|luxury vinyl)", "floor", "vinyl"),
    (r"rubber(ized)? floor", "floor", "rubber_floor"),
    # ceilings
    (r"acoustic (ceiling|tile|panel)|drop ceiling|ceiling tiles|suspended ceiling", "ceiling", "acoustic_tile"),
    (r"exposed (ductwork|beams?|concrete|ceiling)|open ceiling|industrial ceiling", "ceiling", "metal_deck"),
    (r"(wood|wooden|timber|slatted)[\w\s-]{0,12}ceiling|beamed ceiling|coffered", "ceiling", "wood_panel"),
    # walls
    (r"floor-to-ceiling (windows|glass)|glass walls?|walls? of (windows|glass)|window walls?|curtain wall", "walls", "glass"),
    (r"exposed brick|brick walls?", "walls", "brick"),
    (r"(wood|slat|wooden)[\w\s-]{0,12}(paneling|panelling|wall)|wall paneling", "walls", "wood_panel"),
    (r"concrete walls?", "walls", "concrete"),
    (r"(drapes|curtains|draperies)", "walls", "curtain"),
]

SOFT_WORDS = r"(sofas?|couch(es)?|sectional|upholstered|armchairs?|lounge chairs|cushion(ed|s)|rugs?|area rug|drapes|curtains|bookshel(f|ves)|ottomans?|bean ?bags)"
HIGH_WORDS = r"(double-height|vaulted|soaring|cathedral|high ceilings?|tall ceilings?|two-story)"


@lru_cache(maxsize=1)
def _descriptions() -> dict:
    path = INDEX_DIR / "descriptions.json"
    return json.loads(path.read_text()) if path.exists() else {}


def parse(text: str) -> dict:
    """Finishes, softness and ceiling hints found in a description."""
    t = (text or "").lower()
    surfaces: dict[str, str] = {}
    evidence: list[str] = []
    for pattern, surface, material in RULES:
        if surface in surfaces:
            continue
        m = re.search(pattern, t)
        if m:
            surfaces[surface] = material
            evidence.append(m.group(0))
    soft = len(re.findall(SOFT_WORDS, t))
    if soft:
        # More soft furnishings mentioned, more of the floor is covered with absorbing stuff.
        surfaces["furnishing"] = min(0.45, 0.08 + 0.06 * soft)
        evidence.extend(sorted(set(m.group(0) for m in re.finditer(SOFT_WORDS, t)))[:4])
    high = re.search(HIGH_WORDS, t)
    if high:
        surfaces["tall"] = True
        evidence.append(high.group(0))
    return {"surfaces": surfaces, "evidence": evidence}


def materials_for_model(model_id: str) -> dict:
    d = _descriptions().get(model_id) or {}
    text = " ".join(filter(None, [d.get("summary"), d.get("description")]))
    if not text:
        return {}
    return parse(text)
