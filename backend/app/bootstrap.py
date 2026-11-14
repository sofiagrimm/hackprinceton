"""Unpack the encrypted data index on a hosted deploy (see scripts/pack_data.py)."""

from __future__ import annotations

import io
import os
import tarfile

from .config import INDEX_DIR, ROOT

BUNDLE = ROOT / "deploy" / "index.bin"


def ensure_index() -> str:
    if (INDEX_DIR / "venues.json").exists():
        return "local index"
    key = os.environ.get("DATA_KEY")
    if not (BUNDLE.exists() and key):
        return "no index (run scripts/build_index.py, or set DATA_KEY for the encrypted bundle)"
    from cryptography.fernet import Fernet
    raw = Fernet(key.encode()).decrypt(BUNDLE.read_bytes())
    INDEX_DIR.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as tar:
        tar.extractall(INDEX_DIR, filter="data")
    return "decrypted bundle"
