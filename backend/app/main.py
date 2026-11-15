"""HTTP API and static front end for the scout.

    uvicorn app.main:app --reload --port 8000     (from backend/)
"""

from __future__ import annotations

import json

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import data, scout, vexcel
from .agent import make_scout
from .config import ANTHROPIC_API_KEY, FRONTEND_DIR, MATTERPORT_SDK_KEY

from .bootstrap import ensure_index

INDEX_SOURCE = ensure_index()
app = FastAPI(title="Encore Scout")


class ScoutRequest(BaseModel):
    brief: str
    mode: str | None = None  # "claude" | "planner"


@app.get("/api/config")
def config() -> dict:
    return {
        "agent": make_scout().name,
        "ai_agent": None if make_scout().name == "planner" else make_scout().name,
        "matterport_sdk_key": MATTERPORT_SDK_KEY,
        "venues": len(data.venues()),
        "housing": len(data.housing()),
    }


@app.get("/api/acoustics")
def room_acoustics(area_sqft: float, height_ft: float | None = None, width_ft: float | None = None,
                   depth_ft: float | None = None, space_type: str = "generic",
                   use: str = "a_cappella_performance", audience: int = 60) -> dict:
    """RT60 for an arbitrary room, e.g. the one the visitor just walked into in the 3D tour."""
    from .acoustics import RoomGeometry, estimate
    return estimate(RoomGeometry(area_sqft, height_ft, width_ft, depth_ft), space_type,
                    use=use, audience=audience).to_dict()


_browse: list[dict] | None = None


@app.get("/api/browse")
def browse() -> dict:
    """Every venue on the Browse pages, trimmed to what a card needs. Worked out once, then reused."""
    global _browse
    if _browse is None:
        from pathlib import Path
        ids = json.loads((Path(__file__).with_name("browse_venues.json")).read_text())["venue_ids"]
        out = []
        for vid in ids:
            v = scout.analyze_venue(vid, use="a_cappella_performance", audience=80)
            if "error" in v or not v.get("spaces") or not v.get("photo"):
                continue
            out.append({
                "venue_id": v["venue_id"], "name": v["name"], "metro": v["metro"], "photo": v["photo"],
                "best_space": {"model_id": (v.get("best_space") or {}).get("model_id")},
                "spaces": [{
                    "space_name": sp["space_name"], "height_ft": sp.get("height_ft"),
                    "glass": (sp["acoustics"].get("assumptions") or {}).get("walls") == "glass"
                    or any(w in " ".join(sp["acoustics"].get("materials_evidence") or []).lower() for w in ("window", "glass")),
                    "acoustics": {k: sp["acoustics"].get(k) for k in ("rt60_occupied_s", "capacity_seated")},
                } for sp in v["spaces"]],
            })
        _browse = out
    return {"venues": _browse}


@app.on_event("startup")
def _warm_browse() -> None:
    import threading
    threading.Thread(target=lambda: browse() if (data.INDEX_DIR / "venues.json").exists() else None, daemon=True).start()


@app.get("/api/venues/{venue_id}/rooms")
def venue_rooms(venue_id: int) -> dict:
    """Indoor rooms with a 360 photo, for the lighting preview."""
    from .panos import rooms_for_venue, warm
    rooms = rooms_for_venue(venue_id)
    warm(rooms)  # start fetching their 360 photos now, before anyone clicks
    return {"rooms": rooms}


@app.get("/api/pano/{model_id}/{pano_id}/{index}.jpg")
def pano_face(model_id: str, pano_id: str, index: int, full: bool = False) -> Response:
    from .panos import face, face_small
    if not 0 <= index <= 5:
        raise HTTPException(404, "Panorama not available")
    image = face(model_id, pano_id, index) if full else face_small(model_id, pano_id, index)
    if not image:
        raise HTTPException(404, "Panorama not available")
    return Response(image, media_type="image/jpeg", headers={"Cache-Control": "public, max-age=86400"})


@app.get("/api/validation")
def validation() -> dict:
    """The engine run on concert halls with published reverberation times."""
    from .validation import run
    return {"halls": run(), "source": "L. Beranek, Concert Halls and Opera Houses, 2nd ed. (2004)"}


@app.post("/api/scout")
def run_scout(req: ScoutRequest) -> StreamingResponse:
    agent = make_scout(req.mode)

    def stream():
        yield json.dumps({"type": "agent", "name": agent.name}) + "\n"
        try:
            for event in agent.run(req.brief):
                yield json.dumps(event, default=str) + "\n"
        except Exception as exc:  # keep the stream well-formed for the browser
            yield json.dumps({"type": "error", "text": f"{type(exc).__name__}: {exc}"}) + "\n"

    return StreamingResponse(stream(), media_type="application/x-ndjson")


@app.get("/api/venues/{venue_id}")
def venue(venue_id: int, use: str = "a_cappella_performance", audience: int = 60) -> dict:
    result = scout.analyze_venue(venue_id, use=use, audience=audience)
    if "error" in result:
        raise HTTPException(404, result["error"])
    return result


@app.get("/api/venues/{venue_id}/site")
def site(venue_id: int) -> dict:
    return scout.site_check(venue_id)


@app.get("/api/venues/{venue_id}/housing")
def venue_housing(venue_id: int, group_size: int = 14, nights: int = 2) -> dict:
    return scout.find_housing(venue_id, group_size=group_size, nights=nights)


class CommitRequest(BaseModel):
    group_size: int = 14
    nights: int = 2
    audience: int = 60
    space_area_sqft: float | None = None


@app.get("/api/treasury")
def treasury_snapshot() -> dict:
    from .treasury import NessieError, fund_snapshot
    try:
        return fund_snapshot()
    except NessieError as exc:
        raise HTTPException(503, str(exc))


@app.get("/api/venues/{venue_id}/budget")
def venue_budget(venue_id: int, group_size: int = 14, nights: int = 2, audience: int = 60,
                 space_area_sqft: float | None = None) -> dict:
    return scout.tour_budget(venue_id, group_size=group_size, nights=nights, audience=audience,
                             space_area_sqft=space_area_sqft)


@app.post("/api/venues/{venue_id}/budget/commit")
def venue_budget_commit(venue_id: int, req: CommitRequest) -> dict:
    """The treasurer approves: hold the deposit and lodging as bills and collect member shares."""
    from .treasury import NessieError, commit_stop
    try:
        return commit_stop(venue_id, group_size=req.group_size, nights=req.nights, audience=req.audience,
                           space_area_sqft=req.space_area_sqft)
    except NessieError as exc:
        raise HTTPException(503, str(exc))


@app.post("/api/photon/webhook")
async def photon_webhook(request: Request, token: str = "") -> dict:
    """Photon 2.0 delivers iMessage `message.received` events here (see app/photon.py)."""
    import os
    expected = os.environ.get("PHOTON_WEBHOOK_TOKEN", "")
    if not expected or token != expected:
        raise HTTPException(401, "bad token")
    from .photon import on_webhook
    on_webhook(await request.json())
    return {"ok": True}


@app.get("/api/venues/{venue_id}/aerial.jpg")
def aerial(venue_id: int) -> Response:
    venue = data.venues().get(venue_id)
    if not venue:
        raise HTTPException(404, "Unknown venue")
    attrs = vexcel.property_attributes(venue_id, venue["lat"], venue["lon"]) or {}
    image = vexcel.ortho_image(venue_id, venue["lat"], venue["lon"], attrs.get("parcel_wkt"))
    if not image:
        raise HTTPException(404, "No aerial imagery for this venue")
    return Response(image, media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})


from .pipeline import router as pipeline_router  # noqa: E402
app.include_router(pipeline_router)
from .regions import router as regions_router  # noqa: E402
app.include_router(regions_router)
from .film import router as film_router  # noqa: E402
app.include_router(film_router)
from .daylight import router as daylight_router  # noqa: E402
app.include_router(daylight_router)


@app.get("/")
def index() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "index.html")


from .tour import router as tour_router; app.include_router(tour_router)  # noqa: E402

app.mount("/", StaticFiles(directory=FRONTEND_DIR), name="frontend")
