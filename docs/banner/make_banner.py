#!/usr/bin/env python3
"""Draw docs/banner/stagehand.svg: a neofetch-style card for the README.

Music notes on a staff in ASCII on the left (docs/banner/notes.txt, from make_art.py), the project's
numbers on the right, in the site's wine-and-cream palette. Run from the repo root:

    python docs/banner/make_banner.py
"""

from __future__ import annotations

import html
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "docs" / "banner" / "stagehand.svg"

# the site's palette
BG = "#2a1012"      # wine
FG = "#f3e7d8"      # cream
ART = "#e9dccd"     # paper
KEY = "#d9a3a8"     # dusty rose, for labels
HEAD = "#f3d27a"    # stage-light gold, for section titles
DIM = "#9c7b77"
GOOD = "#bcd3a2"


def sh(cmd: str) -> str:
    try:
        return subprocess.run(cmd, shell=True, cwd=ROOT, capture_output=True, text=True, timeout=30).stdout.strip()
    except Exception:
        return ""


def stats() -> dict:
    files = [p for pat in ("backend/app/*.py", "frontend/*.js", "frontend/*.css", "frontend/index.html", "scripts/*.py")
             for p in ROOT.glob(pat)]
    lines = sum(len(p.read_text(errors="ignore").splitlines()) for p in files)
    try:
        views = len(json.loads((ROOT / "data/cache/lookalike_index.json").read_text()))
    except Exception:
        views = 2900
    try:
        halls = __import__("sys").path.insert(0, str(ROOT / "backend")) or __import__("app.validation", fromlist=["run"]).run()
    except Exception:
        halls = [{"hall": "Concertgebouw", "published_rt60_s": 2.0, "estimated_rt60_s": 1.96, "error_pct": -2.1},
                 {"hall": "Musikverein, Grosser Saal", "published_rt60_s": 2.0, "estimated_rt60_s": 1.8, "error_pct": -9.9},
                 {"hall": "Symphony Hall", "published_rt60_s": 1.9, "estimated_rt60_s": 1.62, "error_pct": -14.9}]
    return {"commits": sh("git rev-list --count HEAD") or "-", "lines": lines, "views": views, "halls": halls}


def info(s: dict) -> list[list[tuple[str, str]]]:
    def f(label: str, value: str, color: str = FG):
        return [(f"{label:<14}", KEY), (value, color)]
    halls = []
    for h in sorted(s["halls"], key=lambda h: abs(h["error_pct"])):
        name = h["hall"].split(",")[0]
        name = {"Symphony Hall": "Boston Symphony"}.get(name, name)
        halls.append([(f"{name:<16}", KEY), (f"{h['estimated_rt60_s']:.2f}s", FG), (" vs ", DIM),
                      (f"{h['published_rt60_s']:.1f}s", FG), ("  ", FG), (f"{h['error_pct']:+.1f}%", GOOD)])
    return [
        [("stagehand", HEAD), ("@", DIM), ("hackprinceton", FG)],
        [("-" * 34, DIM)],
        f("Tagline", "hear and see a room before you book it"),
        f("For", "singers, actors and film crews"),
        f("Host", "HackPrinceton, Fall 2026"),
        f("Uptime", "36 hours"),
        [],
        f("Data.Inside", f"Matterport, {s['views']:,} room views"),
        f("Data.Record", "CoStar, 3,288 properties"),
        f("Data.Above", "Vexcel aerials and footprints"),
        f("Data.Around", "OpenStreetMap building heights"),
        [],
        f("Kernel", "Eyring T60, 6 octave bands"),
        f("Wave", "2D FDTD over the floor plan"),
        f("Seat", "image sources + HRTF, 3rd order"),
        f("Clap", "ISO 3382, Schroeder + Lundeby"),
        f("Agent", "LangChain Deep Agents, 2 subagents"),
        f("Money", "Capital One Nessie"),
        f("Voice", "Photon 2.0, iMessage and phone"),
        [],
        [("Checked blind against", HEAD)],
        *halls,
        [],
        [(f"{'Commits':<14}", KEY), (f"{s['commits']}", FG), ("    ", FG), ("Lines ", KEY), (f"{s['lines']:,}", FG)],
        [(f"{'Team':<14}", KEY), ("Sofia Grimm, Corinne Laurey", FG)],
    ]


CHW, LH, FS, PAD = 8.6, 17.0, 14.5, 26


def esc(t: str) -> str:
    return html.escape(t, quote=False)


def build(s: dict) -> str:
    art = (ROOT / "docs/banner/notes.txt").read_text().rstrip("\n").split("\n")
    rows = info(s)
    info_h = len(rows) * LH
    art_h = len(art) * LH
    h = max(info_h, art_h) + 2 * PAD + 18
    art_w = max(len(l) for l in art) * CHW
    info_x = PAD + art_w + 64
    info_w = max(sum(len(t) for t, _ in r) for r in rows if r) * CHW * 1.04
    w = info_x + info_w + PAD
    art_y0 = PAD + (h - 2 * PAD - art_h) / 2
    out = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w:.0f}" height="{h:.0f}" viewBox="0 0 {w:.0f} {h:.0f}" '
        f'font-family="ui-monospace,SFMono-Regular,Consolas,Menlo,monospace" font-size="{FS}">',
        "<style>"
        ".notes{animation:bob 6s ease-in-out infinite}"
        "@keyframes bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}"
        ".cursor{animation:blink 1.1s steps(1) infinite}"
        "@keyframes blink{50%{opacity:0}}"
        "@media (prefers-reduced-motion:reduce){.notes,.cursor{animation:none}}"
        "</style>",
        f'<rect width="100%" height="100%" rx="10" fill="{BG}"/>',
        f'<g class="notes">',
    ]
    for i, line in enumerate(art):
        if line.strip():
            out.append(f'<text x="{PAD}" y="{art_y0 + (i + 1) * LH:.1f}" xml:space="preserve" fill="{ART}">{esc(line)}</text>')
    out.append("</g>")
    for j, row in enumerate(rows):
        if not row:
            continue
        y = PAD + (j + 1) * LH
        spans = "".join(f'<tspan fill="{c}" xml:space="preserve">{esc(t)}</tspan>' for t, c in row)
        out.append(f'<text x="{info_x:.0f}" y="{y:.1f}">{spans}</text>')
    # a row of swatches in the site's colours, then a blinking cursor
    y = PAD + (len(rows) + 1) * LH
    for k, c in enumerate(["#3b1519", "#8e1424", "#b4646b", KEY, HEAD, "#e9dccd", "#fbf8f4"]):
        out.append(f'<rect x="{info_x + k * 26:.0f}" y="{y - 12:.1f}" width="22" height="14" fill="{c}"/>')
    out.append(f'<rect class="cursor" x="{info_x + 7 * 26 + 8:.0f}" y="{y - 12:.1f}" width="9" height="14" fill="{FG}"/>')
    out.append("</svg>")
    return "\n".join(out)


if __name__ == "__main__":
    OUT.write_text(build(stats()), encoding="utf-8")
    print("wrote", OUT.relative_to(ROOT))
