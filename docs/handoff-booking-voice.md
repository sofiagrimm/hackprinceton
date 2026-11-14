# Handoff: booking pipeline and voice (`feat/booking-voice`)

## What I built

- **Outreach tracker** (`backend/app/pipeline.py`). It lists every venue the group has written to, with a
  status (drafted, sent, replied, holding, booked, declined) and a dated history. Each venue keeps its notes,
  the first email (from `scout.draft_outreach`) and a next follow-up date that's set automatically by status:
  sent 4 days, replied 2, holding 3. It's stored in `data/cache/pipeline.json`.
- **Follow-up emails**. They're short and plain, and worded for where things stand: no reply yet, replied,
  on hold or booked.
- **Compare** (`/api/compare`). Two venues side by side: the best room, reverb empty and full, the target
  range, seats, size, lodging, venue fee, total, each singer's share, and a one-line summary of which room
  sounds better and which is cheaper.
- **Phone line** (`backend/app/voice.py`). A Photon number connects over SIP to a Retell voice agent. Its four
  functions call our scout to search, pick and find lodging. The agent speaks a short answer, then texts the
  hear-the-room link from the same Photon number.
- **Call simulator** (`scripts/voice_sim.py`). It plays a whole call against the real endpoints with no
  accounts.
- **Frontend** (`frontend/pipeline.js`, `pipeline.css`, `<section id="pipeline">`):
  - an "Add <venue>" button for whatever venue is open on the page
  - the board grouped by status, with a status menu on each row
  - "Email" to show the first email and "Follow up" to draft the next one, each with Copy
  - an A/B section with two play buttons, where the second switches the room around the chord while it's
    still ringing, plus an Empty/Full house toggle

Shared-file edits: two lines in `main.py` (the import and `app.include_router`, above the static mount),
and one `<section>`, one `<link>` and one `<script>` in `index.html`. `voice.py`'s router is mounted inside
`pipeline.router`, so `main.py` only needs that one include.

## Endpoints

| Method | Path | |
|---|---|---|
| GET | `/api/pipeline?status=` | Board, grouped by status, plus which entries are due |
| POST | `/api/pipeline` | `{venue_id, event_date, audience, group_size, nights, space_name?, status?}` |
| PATCH | `/api/pipeline/{venue_id}` | `{status, note?, follow_up_in_days?}` |
| POST | `/api/pipeline/{venue_id}/follow-up` | `{days_since?, sender_name?}` |
| DELETE | `/api/pipeline/{venue_id}` | Stop tracking |
| GET | `/api/compare?a=&b=&audience=&group_size=&nights=&use=` | Side by side |
| POST | `/api/voice/retell/{function}?token=` | Retell custom function webhook |
| POST | `/api/voice/retell-events?token=` | Retell agent webhook (texts the link on hang-up if not sent) |
| GET | `/api/voice/retell-config?token=` | Prompt and function definitions to paste into Retell |
| GET | `/api/voice/status` | Is voice configured |

## Agent tools

- `pipeline.TOOLS` / `pipeline.TOOL_SCHEMAS`: `add_to_pipeline`, `update_status`, `draft_follow_up`,
  `list_pipeline`.
- `voice.TOOLS` / `voice.TOOL_SCHEMAS`: `find_rooms`, `next_option`, `find_lodging`, `text_me_the_link`.
  These are used by the phone agent.

## Keys and accounts

The pipeline and compare need nothing new. The phone line needs:

- `VOICE_WEBHOOK_TOKEN`
- `PHOTON_SMS_NUMBER`
- the existing `PHOTON_API_KEY`, `PHOTON_PROJECT_ID` and `PUBLIC_URL`
- a Retell account
- a Photon SMS number with a Voice profile
- a 10DLC campaign, for texts to reach US phones

The dashboard steps are in `VOICE_SETUP.md`. None of these were available to me, so no real call has been
made.

## Demo in 20 seconds

1. Open `/?venue=<id>`, scroll to "Keep every ask moving." and press **Add**. Do the same for a second venue.
2. On the second one, set the status to **Sent**, then press **Follow up**. The drafted email appears under
   the row.
3. Scroll to "Two rooms. One chord." Press play on A, then press B while it's still singing to hear the
   room change.
4. For voice, run `python scripts/voice_sim.py`. It prints the whole call and the text it would send.

## How it was tested

I tested on the real index (3,288 venues). The planner's top two LA picks for the default brief were 3033
Wilshire and The Preserve. In the browser I added both, marked one sent, drafted a follow-up, compared them
and played A then B. I ran this with Playwright at 1280px and 390px, and the console showed no errors.
`scripts/voice_sim.py` also runs the whole call against the real data. No real phone call was placed.

Something I noticed and didn't change, because it's outside my files: on a 390px phone the page scrolls
sideways because `#sun-clock` in the Light section is too wide.
