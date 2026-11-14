# Handoff: estimated regions (branch `feat/regions`)

## What it does

Encore Scout now covers nine more cities: San Francisco, Oakland, Berkeley, Stanford, San Jose, Sacramento and Davis
in Northern California, and Pensacola and Tallahassee in the Florida Panhandle. Nobody has scanned these rooms, so
we work from the outside of each building. OpenStreetMap supplies the churches, theaters, halls and hotels. Vexcel
supplies the footprint and roof height where our key works. Then the code guesses the main room's size from the
building type and runs the same Eyring model as the scanned rooms. Every result is marked "Estimated, no interior
scan".

Vexcel only answers inside four boxes. **San Francisco, Oakland, Berkeley, Stanford, San Jose and Tallahassee are
all outside them.** Sacramento, Davis and Pensacola are inside. `backend/app/geofence.py` checks every Vexcel call
for a region venue, so none of them leave the boxes. Outside the boxes, the 3D building is the OpenStreetMap outline
and there's no aerial photo. If OSM has no outline either, we use a typical size for that kind of building.

## Files

- `scripts/build_regions.py` pulls venues and hotels from Overpass and writes `data/index/regions.json`
  (git-ignored). It caches raw replies in `data/cache/overpass/`.
- `backend/app/regions.py` holds the estimates, the agent tools, a small planner and the router.
- `backend/app/region_cities.py` lists the cities and aliases and finds the city in a brief. "Our Berkeley group
  wants to sing in San Francisco" resolves to San Francisco.
- `backend/app/geofence.py` has the Vexcel coverage polygons.
- `frontend/regions.js`, `frontend/regions.css` and one `<section id="regions">` in `index.html`.
- `backend/app/main.py` gets one import and one `app.include_router(regions_router)`, above the static mount.

## Endpoints

| Route | What |
|---|---|
| `GET /api/regions` | Cities, venue and hotel counts, Vexcel coverage, aliases |
| `GET /api/regions/detect?brief=` | Which region city a brief is about, if any |
| `GET /api/regions/search?city=&audience=&use=` | Ranked venues plus hotels near the top pick |
| `POST /api/regions/scout` | `{brief}`. Streams NDJSON in the same event format as `/api/scout` |
| `GET /api/regions/venues/{id}` | One venue's estimate (ids look like `osm-w12345`) |
| `GET /api/regions/venues/{id}/site` | Footprint, height and image bounds for `hero3d.js` |
| `GET /api/regions/venues/{id}/housing` | OSM hotels nearby. OSM has no prices |
| `GET /api/regions/venues/{id}/aerial.jpg` | Vexcel ortho photo, only inside the coverage boxes |

## Agent tools

`regions.TOOLS` and `regions.TOOL_SCHEMAS` add `search_region_venues`, `analyze_region_venue`,
`region_site_check` and `find_region_lodging`. They aren't wired into `agent.py`, because that file is off limits
on this branch. To give Claude or Deep Agents access, merge them into its `TOOLS` and `TOOL_SCHEMAS`. Then add one
line to the system prompt: use `search_region_venues` for any city outside LA and Houston.

## How the front end routes a brief

`regions.js` listens for the brief's submit and Enter in the capture phase. When the brief names a region city, it
handles the brief itself and `app.js` never sees it. Otherwise the brief goes through to the normal scout.
`regions.js` also hides the main result sections, including the Matterport tour, and shows its own section. It adds
a "Bay Area" example under the brief box and a city picker in the section.

## Status

- Done and pushed: backend, agent tools, routes, front end and geofence.
- Checked with the real `.env`: the index decrypts (`/api/config` shows 3,288 venues). Real Vexcel calls through the
  geofence return footprints in Sacramento and Pensacola. SF points make no Vexcel call at all. An LA brief still goes
  to the main scout.
- Checked in Chromium with a small hand-made SF fixture (since deleted): the demo brief routes to the regions
  section, the Matterport tour stays hidden, and the console is clean.
- **Not done: the real OpenStreetMap data.** `data/index/regions.json` doesn't exist yet, so region search returns
  "No region data yet" until someone runs the build script. From the cloud container, `overpass-api.de` reset every
  connection. Mirrors are allowlisted on the `hackprinceton` environment, but the script only tries the main server.
  Running it on a laptop is the quickest fix.
- Vexcel returned no roof height for the buildings we tried. In that case the code uses the OSM height tag, or a
  typical height for the building type.

## Keys and network

- Overpass: free, no key. The script needs `overpass-api.de` to be reachable. Public mirrors you can try if it's
  down: `overpass.private.coffee`, `overpass.kumi.systems`, `maps.mail.ru/osm/tools/overpass`. To use one, change
  `OVERPASS` at the top of `scripts/build_regions.py`.
- Vexcel: `VEXCEL_API_KEY` in `.env`, the same as before. Without it, everything falls back to OSM.

## To finish (about 5 minutes)

```bash
python scripts/build_regions.py
```

It takes a minute or two per city. Then copy `data/index/regions.json` to the machine that runs the server. It's
git-ignored, like the rest of `data/`.

## Demo in 20 seconds

```bash
python scripts/build_regions.py
```

```bash
cd backend && uvicorn app.main:app --port 8000
```

Open http://localhost:8000. Click "Bay Area" under the brief box, or paste "Our Berkeley group wants to sing in San
Francisco for 120 people", then press Scout. The page scrolls to a pick marked Estimated, with reverb, seats,
footprint and roof height. Below that are the 3D building, a shortlist of churches and halls you can click through,
and hotels nearby. Press "Play a chord in this room" to hear the estimate. For the Vexcel version (aerial photo
and Vexcel footprint), try Sacramento or Pensacola from the city picker.

## Caveats

- Large churches and cathedrals come out very live (4 to 8 seconds), which is about right for the real buildings.
  They rank below drier halls for a cappella. Ordinary parish churches should land closer to the target.
- The main room's share of the footprint and roof height comes from fixed guesses per building type (see `KINDS`
  in `regions.py`). These are the numbers to tune.
