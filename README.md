# Encore Scout

**Rooms that sound right. Somewhere to stay. Who to call.**

Touring a cappella groups, choirs and film crews spend hours hunting for spaces that *sound* right and somewhere
nearby to sleep. Encore Scout is an AI agent that reads a tour brief, searches thousands of real buildings in
Los Angeles and Houston, measures how each room will sound from its 3D scan, checks the site from the air,
finds lodging and drafts the email to the person who can say yes.

Built at HackPrinceton Fall 2026 on CoStar Group's data: CoStar property records, Matterport digital twins and
Vexcel aerial imagery for the same buildings.

## What it does

1. **Plans** from a free-text brief: group size, audience, nights, metro, and the sound they need
   (unamplified a cappella, choir, rehearsal, recording, film dialogue).
2. **Searches** 3,288 Matterport-scanned buildings (CoStar) for performable rooms: lobbies, club lounges,
   ballrooms, rooftops, warehouse bays.
3. **Measures** each room's reverberation time (RT60) with the Eyring equation from the scan's floor area,
   width, depth and ceiling height, with finishes inferred from the space type - empty and with the audience in it.
4. **Lets you hear it**: a synthesized four-part chord, a clap, or your own voice through your microphone,
   convolved with an impulse response built from the room's RT60 (Web Audio API).
5. **Shows the light**: the sun's position for the venue and show date, golden hour, and the building's shadow
   drawn on the Vexcel aerial (building height and footprint from Vexcel / CoStar).
6. **Checks the site**: CoStar parking count, vehicles Vexcel counted on the parcel, roof type.
7. **Finds lodging**: hotels (CoStar average daily rates, so a hotel can be stage *and* bed) for short stops,
   apartment communities with short-term leases (Apartments.com listings) for longer stays.
8. **Drafts outreach** to the listing broker or hotel sales team.
9. **Keeps the tour solvent** (Capital One Nessie): the agent checks the group's tour fund before it
   recommends a stop and reports the break-even ticket price and each member's share. The treasurer approves
   with one click, which posts the venue deposit and lodging hold as bills and collects each member's dues by
   transfer into the fund. The agent plans; a person moves the money.

## The agent

Three interchangeable brains drive the same tools (`backend/app/scout.py`):

| Brain | When it runs | Notes |
|---|---|---|
| **Deep Agents** (`deep_scout.py`) | `SCOUT_LLM` is set | LangChain Deep Agents: plans with todos, delegates to an `acoustics-analyst` and a `stay-planner` subagent, writes `/report.md`. Any model: Claude, or a free OpenRouter model. |
| **Claude** (`agent.py`) | `ANTHROPIC_API_KEY` is set | Claude tool-use loop. |
| **Built-in planner** (`agent.py`) | otherwise | Our own rule-based planner; no outside AI. |

The acoustics, scoring, lodging maths and simulations are our own code in every mode.

## Run it

```bash
cd backend
pip install -r requirements.txt
```

1. Put your keys in a repo-root `.env` (copy `.env.example`). Keys come from `/costar-keys` in the CoStar
   track Discord.
2. Unzip the CoStar kit into `data/kit/` (password from `/costar-keys`).
3. Build the indexes:

```bash
python scripts/build_index.py
```

```bash
python scripts/fetch_matterport.py
```

4. Start the app and open http://localhost:8000:

```bash
cd backend && uvicorn app.main:app --port 8000
```

`data/` and `.env` are git-ignored: the CoStar data is licensed for hackathon use only.

## Honest limits

- RT60 values are physics estimates from scan geometry and assumed finishes, not measurements.
- Lodging costs use CoStar average daily rates and asking rents, not live quotes.
- Contact emails in the CoStar kit are anonymised placeholders.
- The data covers Los Angeles and Houston only.
