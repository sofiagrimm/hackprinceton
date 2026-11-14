# Design handoff

Frontend only. No backend files, API calls or app logic changed.

## Structure

One HTML file, several views, switched by browser-style tabs at the top (`frontend/layout.js`).

| Address | View |
|---|---|
| `#/` | Opening page: the name in Playfair, a breathing "Find your space" blob, a collage of paint chips, real building photos, marker-drawn notes and movie cameras, and the two records. |
| `#/search` | The search engine. The blob zooms into it (FLIP scale, transform and opacity only, 600 ms; a cross-fade under reduced motion). Esc or Back zooms out. Scrolling, swiping or paging down on the opening page also opens it. The cassette brief (`#ask`, `#brief`, `#go`), coloured example briefs, and a shelf of real scanned rooms that slides sideways. |
| `#/results` | Results slider: the current room big, the next ones smaller to its right. Info, price and "why it fits your show" (bottom right) update as you slide. The agent's steps sit below as a tracklist. |
| `#/venue/ID` | The property: the pick and its liner notes, the sound (dark band), the room viewer in the "Scout the room" location template, the Matterport tour, stay and budget (ticket stub), the email (cassette J-card), other rooms. Secondary detail is folded. |
| `#/tour` `#/film` `#/bookings` `#/cities` | The feature modes. Old links (`?tour=`, `?film=`, `?venue=`, `#tour-plan`) still land on the right view. |

## Hooks into existing code

- `app.js`: one line in `renderCards` dispatches `scout:results` so `layout.js` can render the results page.
- `vinyl.js`: black records with cream labels, new positions, still under `prefers-reduced-motion`. It loads the licensed record photo from `frontend/img/record.jpg` when that file exists and falls back to the drawn disc.
- The "Add to bookings" bar (`#pl-add`) moved onto the property page.

## Styles

Shared tokens, type scale, spacing scale, buttons, fields, lists, figures, polaroids and folds live in `styles.css`. The four feature stylesheets keep only what is theirs. All element ids, data attributes and JS-used classes are unchanged.

## Not finished

- `frontend/img/record.jpg` (the licensed record photo) needs adding to the repo. The image only came through chat.
- New cities shows "No region data yet" until `scripts/build_regions.py` has been run on the server.
- CoStar photos are blocked in the build sandbox, so screenshots show aerials. Real browsers load the photos.
- The waveform scope line while playing is still drawn blue by app.js.

Screenshots: `docs/design/before/` and `docs/design/after/` at 1440×900 and 390×844.
