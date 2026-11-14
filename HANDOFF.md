# Handoff: whole-tour planner (`feat/tour-planner`)

## What it does
You type every show in one brief ("Our 14 singers want to do 3 shows: LA March 14, LA March 16, Houston March 20.
About 80 guests each, budget $6,000.") and get one plan. For each stop it picks a room and a backup with the
scout's own tools and never uses the same venue twice. It finds beds nearby, works out the drive or flight to the
next stop, and adds it all up. The plan gets a link the group can open to vote on each stop's room or its backup.
The treasurer can collect dues for the whole tour in one go.

## Files
- `backend/app/tour.py`: parsing, planning, travel, totals, storage, votes, dues, `router`, `TOOLS`, `TOOL_SCHEMAS`.
- `backend/app/main.py`: one line, `app.include_router(tour_router)`, above the static mount.
- `frontend/tourplan.js`, `frontend/tourplan.css`, and one `<section id="tour-plan">` in `index.html`, plus one
  `<link>` and one `<script type="module">`.
  The brief said `frontend/tour.js`, but that file already holds the Matterport walkthrough that `app.js` imports.
  So these are named `tourplan.*`.

## Endpoints
| Method | Path | What |
|---|---|---|
| POST | `/api/tour` `{brief}` | Streams NDJSON like `/api/scout`: `plan`, `tool`, `tool_result`, `stop`, `leg`, `message`, `tour` (the full plan), `done`. |
| GET | `/api/tour/{id}` | The saved plan with `tallies` (who voted for each stop's venue or backup). |
| POST | `/api/tour/{id}/vote` `{stop, name, choice}` | `choice` is `venue`, `backup` or `none`. One vote per name per stop; voting again changes it. |
| POST | `/api/tour/{id}/dues` | Holds every deposit (50%), the lodging and the travel as bills on the Nessie tour fund, and collects each member's share of the whole tour. Returns 503 without `NESSIE_API_KEY`. |

Plans are saved in `data/cache/tours/{id}.json`. The share link is `/?tour=<id>`.

## Agent tool
`plan_tour(brief)` is in `tour.TOOLS` and `tour.TOOL_SCHEMAS`. It returns the id, share link, totals, stops and legs.
Nothing in `agent.py` is wired to it yet. To let Claude call it, add `tour.TOOL_SCHEMAS` to the tool list and
`tour.TOOLS` to the dispatch.

## How the numbers work
- Each stop's nights run until the next show. If the next show is in another city, one day goes to travel.
  The last stop gets one night.
- Room fee comes from `treasury.venue_fee_estimate`. Lodging is the top `find_housing` option.
- Travel: straight-line miles x 1.25 is road miles, driven at 55 mph in 12-seat vans at $0.70 a mile per van.
  Past 600 road miles the leg becomes a flight, about $60 + $0.11 per air mile a person, plus a bag and a van at
  each end. LA to Houston works out to about 1,700 road miles and roughly $210 a seat.
- Break-even ticket is the total cost divided by all the seats across every show.

## Keys
- `DATA_KEY` to unlock the venue index (same as the rest of the site).
- `NESSIE_API_KEY` only for "Collect dues". Everything else runs without keys.

## Demo in 20 seconds
1. Open http://localhost:8000/#tour-plan.
2. Click "Try the spring tour", then "Plan the tour". The stops fill in, with a short drive between the LA shows
   and a flight to Houston. The total and the budget gap appear at the bottom.
3. Click "Vote for this room" and type a name. Then open the "Share with the group" link in another tab. It shows
   the same plan with the vote counted.
