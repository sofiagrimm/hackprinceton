"""Reset the Nessie sandbox to a fresh tour fund before a demo.

Clears everything under your Nessie key (customers, accounts, bills,
transactions) and the cached ids, so the next run creates a clean fund
(TOUR_FUND_START, default $2,500).

    python scripts/reset_tour_fund.py
"""

import os
import sys
from pathlib import Path

import httpx
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")
key = os.environ.get("NESSIE_API_KEY")
if not key:
    sys.exit("Set NESSIE_API_KEY in .env")
r = httpx.delete("https://v2-prod-api.nessieisreal.com/data",
                 headers={"Authorization": f"Bearer {key}"}, timeout=60)
print("Nessie sandbox cleared:", r.status_code)
state = ROOT / "data" / "cache" / "nessie_state.json"
if state.exists():
    state.unlink()
    print("Forgot cached fund ids")
