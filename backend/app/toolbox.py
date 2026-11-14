"""Every tool the scout's agents can call, gathered in one place.

The core tools live in scout.py; the tour planner, the booking pipeline and the
estimated regions each add their own. Agents look tools up here, so a feature
only has to export TOOLS and TOOL_SCHEMAS to become something Claude or Deep
Agents can use.
"""

from __future__ import annotations

from . import scout


def all_tools() -> dict:
    tools = dict(scout.TOOLS)
    for mod in _feature_modules():
        tools.update(getattr(mod, "TOOLS", {}))
    return tools


def feature_schemas() -> list[dict]:
    schemas = []
    for mod in _feature_modules():
        schemas.extend(getattr(mod, "TOOL_SCHEMAS", []))
    return schemas


def _feature_modules():
    mods = []
    for name in ("tour", "pipeline", "regions", "film"):
        try:
            mods.append(__import__(f"app.{name}", fromlist=["TOOLS"]))
        except Exception:  # a feature that isn't merged (or fails to import) just isn't offered
            continue
    return mods
