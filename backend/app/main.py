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

app = FastAPI(title="Encore Scout")


class ScoutRequest(BaseModel):
    brief: str
    mode: str | None = None  # "claude" | "planner"


@app.get("/api/config")
def config() -> dict:
    return {
        "agent": "claude" if ANTHROPIC_API_KEY else "planner",
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
