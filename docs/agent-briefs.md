# Briefs for parallel agents

Paste one brief into each new Claude Code session (environment: `hackprinceton`, repo: `sofiagrimm/hackprinceton`).
In the same first message, paste the contents of your `.env` and ask the agent to save them as `.env` at the repo root.

---

## Shared rules (included in every brief below)

```text
SETUP
- Save the .env I pasted to the repo root (it is git-ignored; never commit it).
- pip install -r backend/requirements.txt
- The data index is not in git. Start the server once and it decrypts deploy/index.bin with DATA_KEY:
    cd backend && uvicorn app.main:app --port 8000
  then check http://localhost:8000/api/config shows 3288 venues.
- Read README.md, backend/app/scout.py (agent tools), backend/app/agent.py (planners) and frontend/app.js first.

HOW TO FIT IN (so your work merges cleanly with three other agents)
- Work on your own branch (named below). Commit often, push your branch, never push to main.
- Put backend code in NEW files only. Expose an APIRouter named `router` and, for agent tools,
  a dict `TOOLS = {name: function}` plus a list `TOOL_SCHEMAS` in the same JSON-schema style as agent.py.
  The only shared-file edits allowed: one `app.include_router(...)` line in backend/app/main.py
  (above the static mount), and nothing in agent.py, scout.py or acoustics.py.
- Put frontend code in NEW files: frontend/<feature>.js and frontend/<feature>.css. In index.html add only
  one <section> before <footer>, one <link> and one <script type="module">.
- Design: Apple product-page style already used on the site. System font, black/white/#f5f5f7,
  blue #0071e3 only for clickable things. No cards with shadows, no emoji, no gradients, no pill chips,
  no coloured eyebrow labels. Big type, hairline-separated lists, plain sentences.
- Copy: write like a person, short sentences, no em dashes, no "Sound:"-style label bullets.
- Test in a browser with Playwright (installed; chromium.launch() works) and look at your screenshots.
- When done, write a short HANDOFF.md on your branch: what you built, new endpoints, new tools,
  anything that needs a key or account, and how to demo it in 20 seconds.
```

---

## Agent 2: Whole-tour planner (branch `feat/tour-planner`)

```text
[paste the shared rules above]

BUILD: a multi-stop tour planner for touring a cappella groups.

Input: a brief like "Our 14 singers want to do 3 shows: LA March 14, LA March 16, Houston March 20.
About 80 guests each, budget $6,000." Output: one plan for the whole tour.

1. backend/app/tour.py
   - parse a multi-stop brief into stops [{city, date, audience, nights}] (reuse parse_brief ideas).
   - for each stop, call the existing tools in scout.py (search_venues, analyze_venue, find_housing,
     tour_budget-style costs) to choose a venue + lodging, avoiding the same venue twice.
   - travel between stops: driving distance/time between venues (haversine x 1.25 road factor, 55 mph),
     and a flag when LA <-> Houston needs a flight (~1,550 mi) with a rough per-person fare.
   - totals: venue fees, lodging, travel, per-member share, break-even ticket per show.
   - a plan_tour(brief) agent tool + TOOL_SCHEMAS entry, and /api/tour (POST, streams NDJSON events
     like /api/scout) + /api/tour/{id} (GET).
   - shareable plan: store plans in data/cache/tours/{id}.json; /api/tour/{id}/vote lets group members
     upvote a stop's venue or its backup (name + choice); tallies returned with the plan.
   - "collect dues" for the whole tour via backend/app/treasury.py (import it; do not edit it).
2. frontend/tour.js + tour.css + one <section id="tour-plan">: a timeline of stops (date, city, venue,
   reverb, lodging, cost), the travel legs between them, totals, a "share with the group" link that
   opens /?tour=<id>, and the vote buttons.
3. Demo: one brief that plans LA, LA, Houston and shows the total and the share link.
```

---

## Agent 3: Film mode (branch `feat/film-mode`)

```text
[paste the shared rules above]

BUILD: "Film mode": location scouting for film crews, using the same data.

1. backend/app/film.py
   - search for quiet, large, controllable spaces: rank scanned rooms by low RT60 for dialogue
     (acoustics.estimate with use="film_dialogue"), floor area, ceiling height, and building type.
   - base camp from the air: use Vexcel (see docs/vendor/vexcel_quickstart.py and the tutorial PDF,
     and backend/app/vexcel.py) to estimate open paved area and parking on and around the parcel;
     convert to how many trucks/trailers fit (assume 3.5 m x 15 m per trailer + aisles). Use
     elements/detect or property attributes (hardscapes, vehicles) where available, and say
     which numbers are measured vs estimated.
   - oblique imagery: fetch the 4 directional oblique photos (N/E/S/W) for a venue via Vexcel and
     serve them at /api/film/{venue_id}/oblique/{dir}.jpg (cache under data/cache/).
   - noise exposure: distance to the nearest freeway/major road, airport (LAX, BUR, IAH, HOU) and
     rail from a small hard-coded list of coordinates; give a simple 1-5 "outside noise" score.
   - shoot-day light: for a date, list sunrise, golden hours, sunset and which facades get sun when
     (reuse the maths in frontend/sun.js, port to Python).
   - agent tools: search_film_locations, film_site_report (+ TOOL_SCHEMAS) and /api/film routes.
2. frontend/film.js + film.css + one <section id="film">: a crew brief box ("25 crew, 3 week shoot,
   dialogue-heavy"), ranked locations, and per location: the 4 obliques, base-camp capacity,
   noise score, a light table for the shoot dates.
3. Demo: "25 crew, quiet interior, LA, 3 weeks in April" -> top location with obliques and base camp.
```

---

## Agent 4: Booking pipeline + voice (branch `feat/booking-voice`)

```text
[paste the shared rules above]

BUILD: track outreach to venues, compare rooms, and a phone line for the scout.

1. backend/app/pipeline.py
   - a simple outreach tracker stored in data/cache/pipeline.json: venues the group has contacted,
     status (drafted, sent, replied, holding, booked, declined), dates, notes, the email draft
     (from scout.draft_outreach), and next follow-up date.
   - agent tools: add_to_pipeline, update_status, draft_follow_up (a polite follow-up after N days,
     written plainly), list_pipeline (+ TOOL_SCHEMAS) and /api/pipeline routes.
   - compare: /api/compare?a=<venue_id>&b=<venue_id> returns both venues' best rooms, RT60s,
     capacity, lodging and cost side by side.
2. Voice (Photon 2.0, see backend/app/photon.py for how we already call Photon's REST API at
   https://api.photon.codes/v1 and docs at photon.codes/docs). Photon voice runs on an SMS number
   connected over SIP to Retell, ElevenLabs, LiveKit or Twilio. Build the server side for ONE of
   these (pick the one with the simplest webhook/function-calling setup after reading Photon's
   cookbooks at photon.codes/docs/beta/cookbooks/voice/...): a voice agent whose functions call our
   scout (search + pick + lodging) and speaks a short answer, then texts the hear-the-room link.
   Write VOICE_SETUP.md with the exact dashboard steps the user must do (Photon SMS number, the
   provider account and keys). If a provider key is missing, still finish the code path and a
   local test harness that simulates a call transcript.
3. frontend/pipeline.js + pipeline.css + one <section id="pipeline">: the outreach board as a quiet
   list grouped by status, a "follow up" action that shows the drafted email, and an A/B compare
   view with two play buttons that switch the hear-the-room sound between the two rooms
   (import RoomSound from frontend/audio.js).
4. Demo: add two venues to the pipeline, compare them, A/B listen, draft a follow-up.
```

---

## Agent 5: New regions, NorCal and the Florida Panhandle (branch `feat/regions`)

```text
[paste the shared rules above]

CONTEXT: CoStar records and Matterport scans only cover Los Angeles and Houston. Vexcel imagery also
covers Northern California and the Florida Panhandle. Vexcel returns 403 outside these four boxes:
MULTIPOLYGON (((-119.0134 33.0945, -116.8949 33.0945, -116.8949 34.3154, -119.0134 34.3154, -119.0134 33.0945)),
((-96.2185 29.0173, -94.5758 29.0173, -94.5758 30.3804, -96.2185 30.3804, -96.2185 29.0173)),
((-124.7437 38.0655, -118.9869 38.0655, -118.9869 41.9596, -124.7437 41.9596, -124.7437 38.0655)),
((-88.2145 30.8016, -88.3285 30.132, -86.2124 30.2269, -85.5125 29.6277, -84.8004 29.5039, -84.9062 30.7876, -88.2145 30.8016)))

BUILD: "estimated" venues for Northern California (Bay Area, Sacramento, Davis, Berkeley, Stanford)
and the Florida Panhandle (Pensacola, Tallahassee).
1. scripts/build_regions.py: pull candidate venues from OpenStreetMap via the Overpass API
   (amenity=place_of_worship, theatre, arts_centre, community_centre, events_venue, concert_hall;
   tourism=hotel for lodging). Save data/index/regions.json (git-ignored like the rest of data/).
   You will need overpass-api.de allowed; if blocked, tell the user the exact host to allow.
2. backend/app/regions.py: for a region venue, get the building footprint and height from Vexcel
   property/extract (backend/app/vexcel.py; add a geofence check so no call leaves the polygons),
   estimate interior volume and use backend/app/acoustics.estimate with a preset picked from the
   building type (chapel for churches, theater for theatres, ballroom for halls). Mark every result
   "estimated, no interior scan". Agent tool search_region_venues + TOOL_SCHEMAS + /api/regions routes.
3. frontend: let the city picker and the brief accept these cities; show an "Estimated" note on
   these venues and hide the Matterport tour for them. Keep frontend changes in frontend/regions.js.
4. Demo: "Our Berkeley group wants to sing in San Francisco for 120 people" -> a ranked list of SF
   churches and halls with estimated reverb, the 3D building from Vexcel, and nearby hotels.
```
