"""The scout's tools: each is one step an agent (or the fallback planner) can take.

Every tool takes plain JSON-able arguments and returns a JSON-able dict, so the
same functions back the Claude tool definitions and the HTTP API.
"""

from __future__ import annotations

from . import data, matterport, vexcel
from .acoustics import USES, RoomGeometry, classify_space, estimate

import re

# Scans of individual apartment units or hotel rooms ("Studio E1A - 1109",
# "1BR, 1BA - 695SF", "2 Queen") are lodging, not stages.
UNIT_NAME = re.compile(r"\b(studio|\d\s*br|\d\s*bd|bedroom|\d\s*bed|king|queen|suite|unit|apt|plan|model|"
                       r"penthouse|townhome|floor ?plan|[a-z]\d[a-z]?\b|\d{3,4}\s*sf)", re.I)

PERFORMABLE = {"theater", "ballroom", "lobby", "chapel", "clubhouse", "rooftop",
               "fitness", "warehouse", "unfinished", "office", "generic", "residential_living"}
# Spaces that read as a venue a group would actually book, best first.
VENUE_PRIORITY = {"ballroom": 1.0, "chapel": 1.0, "theater": 0.95, "clubhouse": 0.95,
                  "lobby": 0.9, "rooftop": 0.85, "warehouse": 0.85, "fitness": 0.7,
                  "unfinished": 0.7, "office": 0.55, "generic": 0.6, "residential_living": 0.5}


# --------------------------------------------------------------------------- spaces

OUTDOOR_TAGS = {"outdoor_other", "patio", "balcony", "garden", "pool", "driveway", "garage"}
TOO_SMALL_TAGS = {"bathroom", "closet", "staircase", "utility", "pantry", "laundry"}
ROOM_WORDS = {"living": "living area", "dining": "dining area", "kitchen": "kitchen", "lobby": "lobby",
              "office": "office", "exercise": "gym", "entrance": "entry", "hallway": "hallway",
              "corridor": "corridor", "game": "game room", "bedroom": "bedroom", "other": "main room",
              "basement": "basement", "unfurnished": "open room"}


def _room_label(model_name: str, tags: list[str], several: bool) -> str:
    """A short human name for a room: the scan's own name when it describes the space
    ("Club Lounge"), otherwise what the room is ("Open room", "Living area")."""
    from .acoustics import NAME_HINTS

    name = (model_name or "").strip()
    word = next((ROOM_WORDS[t] for t in tags if t in ROOM_WORDS and t != "unfurnished"), None)
    word = word or ("open room" if "unfurnished" in tags else "main room")
    describes_space = any(w in name.lower() for words, _ in NAME_HINTS for w in words)
    if describes_space:
        # "3033 Wilshire - Lobby" -> "Lobby"
        return re.split(r"\s+[-–:]\s+", name)[-1].strip() or name
    looks_like_address = bool(re.match(r"^\d+[\w-]*\s", name)) or not name
    if looks_like_address:
        return word.capitalize()
    if not several:
        return name
    return f"{name}, {word}"


OUTDOOR_NAME = re.compile(r"\b(pool|patio|terrace|courtyard|garden|roof ?deck|sky ?deck|outdoor|bbq|grill|dog park|cabana)\b", re.I)


def _spaces_for_venue(venue: dict, use: str, audience: int | None, allow_fetch: bool = False) -> list[dict]:
    """Every indoor scanned room in a venue that a group could perform or rehearse in.

    Each Matterport scan can hold several rooms. We evaluate every indoor room big
    enough to hold a group (outdoor patios, pools and balconies are left out: they
    have no reverberation to speak of) and keep the best-sounding room per scan.
    """
    from .materials import materials_for_model

    spaces = []
    for model_id in venue["matterport_models"]:
        model = matterport.get_model(model_id, allow_fetch=allow_fetch)
        if not model:
            continue
        rooms = [matterport.to_feet(r) for r in model.get("rooms") or []]
        indoor = [r for r in rooms if r.get("area") and r["area"] >= 250
                  and not (set(r.get("tags") or []) & OUTDOOR_TAGS)
                  and not (set(r.get("tags") or []) <= TOO_SMALL_TAGS and r.get("tags"))]
        if not indoor:
            continue
        name = model.get("name") or ""
        if OUTDOOR_NAME.search(name) and not re.search(r"\b(interior|indoor|inside)\b", name, re.I):
            continue
        found = materials_for_model(model_id)
        best = None
        for room in indoor:
            kind = classify_space(name, room.get("tags"), venue["property_type"])
            if kind == "rooftop" and "interior" in name.lower():
                kind = "clubhouse"
            if kind not in PERFORMABLE:
                continue
            if kind not in ("ballroom", "theater", "chapel", "lobby", "clubhouse", "rooftop") \
                    and UNIT_NAME.search(name):
                continue
            est = estimate(RoomGeometry(room["area"], room.get("height"), room.get("width"), room.get("depth")),
                           kind, use=use, audience=audience, materials=found.get("surfaces") or None)
            fit = est.score * VENUE_PRIORITY.get(kind, 0.5)
            if best is None or fit > best["fit"]:
                d = est.to_dict()
                if found.get("evidence"):
                    d["materials_source"] = "Matterport's description of this scan"
                    d["materials_evidence"] = found["evidence"]
                best = {
                    "model_id": model_id,
                    "space_name": _room_label(name, room.get("tags") or [], len(indoor) > 1),
                    "area_sqft": round(room["area"]),
                    "height_ft": round(room["height"], 1) if room.get("height") else None,
                    "width_ft": round(room["width"], 1) if room.get("width") else None,
                    "depth_ft": round(room["depth"], 1) if room.get("depth") else None,
                    "acoustics": d,
                    "fit": fit,
                }
        if best:
            spaces.append(best)
    # Hotels report their largest ballroom even when it was not scanned.
    hotel = venue.get("hotel") or {}
    if hotel.get("largest_meeting_sf") and not any(s["acoustics"]["space_type"] == "ballroom" for s in spaces):
        est = estimate(RoomGeometry(hotel["largest_meeting_sf"], 12), "ballroom", use=use, audience=audience)
        spaces.append({
            "model_id": None,
            "space_name": "Largest meeting room / ballroom (from CoStar hotel record)",
            "area_sqft": round(hotel["largest_meeting_sf"]),
            "height_ft": None,
            "acoustics": est.to_dict(),
            "fit": est.score * 0.9,
        })
    spaces.sort(key=lambda s: s["fit"], reverse=True)
    return spaces


def _venue_card(venue: dict, best: dict | None) -> dict:
    listing = venue["listings"][0] if venue["listings"] else None
    return {
        "venue_id": venue["id"],
        "name": venue["name"],
        "address": venue["address"],
        "metro": data.metro_of(venue),
        "lat": venue["lat"],
        "lon": venue["lon"],
        "property_type": venue["property_type"],
        "photo": venue.get("photo"),
        "parking_spaces": venue.get("parking_spaces"),
        "is_hotel": bool(venue.get("hotel")),
        "hotel": venue.get("hotel"),
        "listing": listing and {k: listing[k] for k in ("type", "available_sf", "brokerage")},
        "best_space": best,
    }


# --------------------------------------------------------------------------- tools

def search_venues(metro: str, audience: int = 60, use: str = "a_cappella_performance",
                  stay_and_perform: bool = False, near: str | None = None,
                  max_results: int = 8) -> dict:
    """Rank scanned spaces in a metro for the intended use and audience size."""
    metro = data.CITY_ALIASES.get(metro.lower().strip(), metro) if metro else "Los Angeles"
    if use not in USES:
        use = "a_cappella_performance"
    candidates = [v for v in data.venues().values() if data.metro_of(v) == metro]
    if stay_and_perform:
        candidates = [v for v in candidates if v.get("hotel") or v["property_type"] == "Multifamily"]

    ranked = []
    for venue in candidates:
        spaces = _spaces_for_venue(venue, use, audience)
        spaces = [s for s in spaces if s["acoustics"]["capacity_standing"] >= audience * 0.8]
        if not spaces:
            continue
        best = spaces[0]
        bonus = 0
        if venue.get("hotel"):
            bonus += 8  # stay and perform in the same building
        if venue["listings"]:
            bonus += 3  # someone is actively marketing the space
        if venue.get("parking_spaces"):
            bonus += 2
        ranked.append((best["fit"] + bonus, venue, best, len(spaces)))

    ranked.sort(key=lambda t: t[0], reverse=True)
    # The same scan is sometimes attached to neighbouring CoStar properties; show it once.
    seen_models, unique = set(), []
    for item in ranked:
        model_id = item[2].get("model_id")
        if model_id and model_id in seen_models:
            continue
        seen_models.add(model_id)
        unique.append(item)
    results = []
    for score, venue, best, n in unique[:max_results]:
        card = _venue_card(venue, best)
        card["match_score"] = round(min(score, 100))
        card["scanned_spaces_considered"] = n
        results.append(card)
    return {
        "metro": metro,
        "use": use,
        "use_label": USES[use][2],
        "target_rt60_s": list(USES[use][:2]),
        "audience": audience,
        "venues_scanned": len(candidates),
        "results": results,
    }


def analyze_venue(venue_id: int, use: str = "a_cappella_performance", audience: int = 60) -> dict:
    """Full acoustic breakdown of every scanned space at one venue."""
    venue = data.venues().get(int(venue_id))
    if not venue:
        return {"error": f"Unknown venue {venue_id}"}
    spaces = _spaces_for_venue(venue, use, audience, allow_fetch=True)
    return {**_venue_card(venue, spaces[0] if spaces else None),
            "spaces": spaces[:6],
            "matterport_models": venue["matterport_models"][:12]}


def site_check(venue_id: int) -> dict:
    """Aerial context from Vexcel plus CoStar's parking count."""
    venue = data.venues().get(int(venue_id))
    if not venue:
        return {"error": f"Unknown venue {venue_id}"}
    attrs = vexcel.property_attributes(venue["id"], venue["lat"], venue["lon"]) or {"available": False}
    notes = []
    spaces = venue.get("parking_spaces")
    if spaces:
        notes.append(f"CoStar records {spaces} parking spaces on site.")
    if attrs.get("vehicles_on_parcel") is not None:
        notes.append(f"Vexcel aerial counted {attrs['vehicles_on_parcel']} vehicles on the parcel at capture.")
    if attrs.get("footprint_sqft"):
        notes.append(f"Main building footprint about {attrs['footprint_sqft']:,.0f} sq ft.")
    if attrs.get("roof_shape") == "flat":
        notes.append("Flat roof: rooftop staging or a photo session may be possible (confirm access).")
    height_ft = attrs.get("max_roof_height_ft") or ((venue.get("stories") or 1) * 12)
    return {
        "venue_id": venue["id"],
        "name": venue["name"],
        "lat": venue["lat"],
        "lon": venue["lon"],
        "parking_spaces": spaces,
        "aerial": {k: v for k, v in attrs.items() if k not in ("parcel_wkt", "footprint_wkt")},
        "aerial_image_url": f"/api/venues/{venue['id']}/aerial.jpg",
        # For the browser's sun and shadow simulation:
        "image_bounds": vexcel.image_bounds(venue["lat"], venue["lon"], attrs.get("parcel_wkt")),
        "footprint": vexcel.wkt_points(attrs.get("footprint_wkt")),
        "building_height_ft": height_ft,
        "notes": notes,
    }


def find_housing(venue_id: int, group_size: int = 14, nights: int = 2,
                 radius_miles: float = 8, max_results: int = 5) -> dict:
    """Lodging for the group near a venue: hotels for short stops, apartments for long stays."""
    venue = data.venues().get(int(venue_id))
    if not venue:
        return {"error": f"Unknown venue {venue_id}"}
    rooms_needed = -(-group_size // 2)  # two per room, rounded up
    options = []

    if nights <= 28:
        for other in data.venues().values():
            hotel = other.get("hotel")
            if not hotel or not hotel.get("adr"):
                continue
            dist = data.miles_between(venue["lat"], venue["lon"], other["lat"], other["lon"])
            if dist > radius_miles:
                continue
            nightly = hotel["adr"] * rooms_needed
            options.append({
                "kind": "hotel",
                "name": other["name"],
                "address": other["address"],
                "distance_miles": round(dist, 1),
                "same_building": other["id"] == venue["id"],
                "rooms_needed": rooms_needed,
                "nightly_rate_per_room": round(hotel["adr"]),
                "estimated_total": round(nightly * nights),
                "keys": hotel.get("keys"),
                "contact": {"email": hotel.get("email"), "phone": hotel.get("phone")},
                "why": f"{rooms_needed} rooms x ${hotel['adr']:.0f}/night (CoStar average daily rate) x {nights} nights",
            })

    if nights >= 21 or not options:
        for apt in data.housing():
            dist = data.miles_between(venue["lat"], venue["lon"], apt["lat"], apt["lon"])
            if dist > radius_miles:
                continue
            beds = sum(p["available"] * max(p["beds"], 1) for p in apt["plans"])
            if beds * 2 < group_size and not apt["short_term"]:
                continue
            rents = [p["rent_low"] for p in apt["plans"] if p.get("rent_low")]
            monthly = min(rents) if rents else None
            units_needed = -(-group_size // 3)
            options.append({
                "kind": "apartment",
                "name": apt["name"],
                "address": apt["address"],
                "distance_miles": round(dist, 1),
                "same_building": apt.get("property_id") == venue["id"],
                "short_term_lease": apt["short_term"],
                "min_lease_months": apt.get("min_lease_months"),
                "units_available": sum(p["available"] for p in apt["plans"]),
                "monthly_rent_from": monthly,
                "estimated_total": round(monthly * units_needed * max(1, nights / 30)) if monthly else None,
                "manager": apt.get("manager"),
                "why": (f"{units_needed} units for {group_size} people; "
                        + ("offers short-term leases" if apt["short_term"]
                           else "standard lease - ask about corporate / short-term terms")),
            })

    options.sort(key=lambda o: (not o["same_building"],
                                o["kind"] != ("hotel" if nights <= 28 else "apartment"),
                                o["distance_miles"]))
    return {
        "venue": venue["name"],
        "group_size": group_size,
        "nights": nights,
        "options": options[:max_results],
        "note": ("Rates are CoStar averages, not live quotes; the outreach email asks for a group rate."),
    }


def draft_outreach(venue_id: int, group_name: str = "", event_date: str = "",
                   audience: int = 60, group_size: int = 14, nights: int = 2,
                   space_name: str | None = None) -> dict:
    """A ready-to-send inquiry to the listing broker or hotel for this venue."""
    venue = data.venues().get(int(venue_id))
    if not venue:
        return {"error": f"Unknown venue {venue_id}"}
    contact = None
    if venue.get("hotel") and (venue["hotel"].get("email") or venue["hotel"].get("phone")):
        contact = {"name": "Sales & Events Team", "firm": venue["name"],
                   "email": venue["hotel"].get("email"), "phone": venue["hotel"].get("phone")}
    elif venue["listings"] and venue["listings"][0]["contacts"]:
        contact = venue["listings"][0]["contacts"][0]
    space = space_name or "your event space"
    if space.lower().startswith(venue["name"].lower()):
        space = space[len(venue["name"]):].lstrip(" -:") or space
    space = f"the {space.lower()}" if space_name else space
    who = group_name or f"a {group_size}-person a cappella group"
    when = f" on {event_date}" if event_date else ""
    lodging = (f" We would also like to book about {-(-group_size // 2)} rooms for {nights} night(s)."
               if venue.get("hotel") else "")
    greeting = f"Hi {contact['name'].split()[0]}," if contact and contact.get("name") and contact["name"] != "Sales & Events Team" else "Hello,"
    body = (
        f"{greeting}\n\n"
        f"I run logistics for {who}. We're coming through "
        f"{data.metro_of(venue)}{when} and would love to sing in {space} at {venue['name']} "
        f"({venue['address']}), for an audience of about {audience}."
        f"{lodging}\n\n"
        "Is it free that evening, and what would it cost? We'd need it for about four hours: load-in, an hour "
        "to rehearse, then a 90-minute show. We don't need a stage, just chairs, and we bring a small speaker "
        "in case we need it. If you have a rate for student or nonprofit groups, we'd be grateful.\n\n"
        "Thanks,\n[Your name]\n"
    )
    return {
        "venue": venue["name"],
        "to": contact,
        "subject": f"Booking a concert at {venue['name']}{when}",
        "body": body,
        "note": "CoStar's kit anonymises contact emails, so the address here is a placeholder.",
    }


def tour_budget(venue_id: int, group_size: int = 14, nights: int = 2, audience: int = 60,
                space_area_sqft: float | None = None) -> dict:
    """Check the group's tour fund (Capital One Nessie) against this stop's costs: venue fee estimate,
    lodging, break-even ticket price and each member's share. Plans only; moves no money."""
    from .treasury import plan_tour_budget
    return plan_tour_budget(venue_id, group_size=group_size, nights=nights, audience=audience,
                            space_area_sqft=space_area_sqft)


TOOLS = {
    "search_venues": search_venues,
    "analyze_venue": analyze_venue,
    "site_check": site_check,
    "find_housing": find_housing,
    "draft_outreach": draft_outreach,
    "tour_budget": tour_budget,
}
