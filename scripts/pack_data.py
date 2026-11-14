"""Encrypt the derived data index so a hosted deploy can use it without publishing it.

The CoStar extract is licensed for hackathon use only, so data/ stays out of
git. For a Railway deploy from GitHub we commit deploy/index.bin instead: a
gzipped tar of data/index/*.json encrypted with Fernet (AES-128 + HMAC). The
server decrypts it at startup with the DATA_KEY environment variable.

    python scripts/pack_data.py          # uses DATA_KEY from .env, or creates one
"""

from __future__ import annotations

import io
import os
import tarfile
from pathlib import Path

from cryptography.fernet import Fernet
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
FILES = ["venues.json", "housing.json", "models.json", "descriptions.json"]


def main() -> None:
    env = ROOT / ".env"
    load_dotenv(env)
    key = os.environ.get("DATA_KEY")
    if not key:
        key = Fernet.generate_key().decode()
        with open(env, "a") as fh:
            fh.write(f"\nDATA_KEY={key}\n")
        print("Created DATA_KEY and saved it to .env")
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for name in FILES:
            tar.add(ROOT / "data" / "index" / name, arcname=name)
    out = ROOT / "deploy" / "index.bin"
    out.parent.mkdir(exist_ok=True)
    out.write_bytes(Fernet(key.encode()).encrypt(buf.getvalue()))
    print(f"Wrote {out.relative_to(ROOT)} ({out.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
