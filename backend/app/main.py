"""HTTP API and static front end for the scout.

    uvicorn app.main:app --reload --port 8000     (from backend/)
"""

from __future__ import annotations

import json

from fastapi import FastAPI, HTTPException
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
        "matterport_sdk_key": MATTERPORT_SDK_KEY,
        "venues": len(data.venues()),
        "housing": len(data.housing()),
    }


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


@app.get("/")
def index() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "index.html")


app.mount("/", StaticFiles(directory=FRONTEND_DIR), name="frontend")
