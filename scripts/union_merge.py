"""Resolve git conflict blocks by keeping both sides (ours first, then theirs).

Used when parallel feature branches each add their own section, stylesheet or
script tag at the same spot in a shared file.

    python scripts/union_merge.py frontend/index.html
"""

import re
import sys
from pathlib import Path

for name in sys.argv[1:]:
    p = Path(name)
    text = p.read_text()
    merged, n = re.subn(r"<<<<<<< [^\n]*\n(.*?)=======\n(.*?)>>>>>>> [^\n]*\n", r"\1\2", text, flags=re.S)
    p.write_text(merged)
    print(f"{name}: kept both sides of {n} conflict(s)")
