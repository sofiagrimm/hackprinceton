"""Paths and secrets. Secrets come from the repo-root .env (never committed)."""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ROOT / ".env")

INDEX_DIR = ROOT / "data" / "index"
CACHE_DIR = ROOT / "data" / "cache"
FRONTEND_DIR = ROOT / "frontend"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

MATTERPORT_API_KEY = os.environ.get("MATTERPORT_API_KEY", "")
MATTERPORT_API_TOKEN = os.environ.get("MATTERPORT_API_TOKEN", "")
MATTERPORT_SDK_KEY = os.environ.get("MATTERPORT_SDK_KEY", "")
VEXCEL_API_KEY = os.environ.get("VEXCEL_API_KEY", "")
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")

# The scout agent's model. Override with SCOUT_MODEL in .env.
SCOUT_MODEL = os.environ.get("SCOUT_MODEL", "claude-opus-5-5")
