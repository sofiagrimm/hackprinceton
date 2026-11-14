# Film mode handoff (branch `feat/film-mode`)

## What it does

Film mode scouts the same 3,288 buildings for a film crew. You type a brief like "25 crew, quiet interior, LA,
3 weeks in April". It ranks scanned rooms for dialogue and shows a report for the pick:

- **Rooms.** It ranks rooms on reverb with the crew in, using `acoustics.estimate(use="film_dialogue")` against a
  0.3 to 0.6 s target. It also weighs floor area against what the crew needs, ceiling height (scan first, then
  CoStar, then assumed), how easy the building is to lock down, and outside noise. Vacant suites that are listed
  for lease get a small bonus.
- **Base camp from the air.** These numbers are measured from Vexcel: parcel polygon, every structure footprint,
  tree cover, cars counted on the parcel, and CoStar's parking count. These are estimated: paved ground, from
  classifying pixels in a clean Vexcel ortho (not roof, lawn, tree or water), kept only where a strip is wide
  enough for a trailer. That becomes trailers that fit (3.5 m x 15 m, 1 m gap, half of a 7 m aisle, 60% of the
  paving usable) and crew cars that fit. The UI labels every number as measured or estimated. If Vexcel saw no
  cars on the paving, the verdict warns that it may be a plaza. It also lists big parking lots within 0.6 miles.
- **Outside noise, scored 1 to 5.** Distance to the nearest freeway, airport (LAX, BUR, IAH, HOU) and rail line,
  from hand-drawn coordinates in `film.py`, plus whether the street address is a busy road.
- **Light.** `frontend/sun.js` ported to Python. For each shoot week it gives sunrise, both golden hours, sunset,
  and the hours the sun is on each wall of the Vexcel footprint.
- **Obliques.** Routes, caching to `data/cache/film_oblique_*`, and the UI's four frames are all wired.
  **What's missing:** `_fetch_oblique` in `film.py` still returns `None`, because the Vexcel oblique endpoint is
  documented only in `docs/vendor/vexcel_quickstart.py`, which is git-ignored and wasn't in this checkout. The
  obvious paths (`/v2/oblique/extract` and others) 500 for this key. Until it's filled in, the frames say
  "No photo from this side yet."
- **`elements/detect`** was not used. It wants `images` plus an `endpoint` this key doesn't seem to have
  (every value returns "Parameter 'endpoint' is mandatory"). Property attributes and the ortho cover the gap.

## Files

- `backend/app/film.py` (new): `router`, `TOOLS`, `TOOL_SCHEMAS`.
- `backend/app/main.py`: one `include_router` line, above the static mount.
- `frontend/film.js`, `frontend/film.css` (new). `index.html`: one `<section id="film">`, one `<link>`, one `<script>`.

## Endpoints

| Route | What |
|---|---|
| `GET /api/film/search?brief=...` | Parses the brief and ranks locations (also takes `metro`, `crew`, `max_results`). |
| `GET /api/film/{venue_id}/report?crew=&start_date=&shoot_days=` | Rooms, base camp, noise, light, oblique URLs. |
| `GET /api/film/{venue_id}/light?day=YYYY-MM-DD` | One day's light. |
| `GET /api/film/{venue_id}/basecamp.jpg` | The ortho with everything but usable paving dimmed. |
| `GET /api/film/{venue_id}/oblique/{n,e,s,w}.jpg` | 404 until `_fetch_oblique` is filled in. |

## Agent tools

`search_film_locations(metro, crew, min_area_sqft, max_results)` and
`film_site_report(venue_id, crew, start_date, shoot_days)`. These are in `film.TOOLS` and `film.TOOL_SCHEMAS`.
To give them to the Claude planner, whoever owns `agent.py` merges them into `scout.TOOLS` and `TOOL_SCHEMAS`.

## Keys

`VEXCEL_API_KEY` covers base camp, the footprint for the light table and, later, the obliques. `DATA_KEY`
unlocks the index. Rooms, noise and light work without Vexcel; base camp then falls back to CoStar.

## 20-second demo

Open `http://localhost:8000/?film=25%20crew,%20quiet%20interior,%20LA,%203%20weeks%20in%20April` and the page
jumps to Film mode. The top pick is One Park Plaza, Suite 301: 4,667 sq ft, 15 ft ceiling, 0.48 s of reverb.
Scroll for base camp (18 trailers on paper, with the plaza warning), the noise score and the April light table.
For a real working lot, try venue 755901 (1601 Perrino Pl): 50 trailers, and Vexcel counted 23 cars on it.
