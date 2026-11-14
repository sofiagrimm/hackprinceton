"""Build compact search indexes from the CoStar hackathon kit.

Reads the raw JSONL dump in data/kit/ (hackathon-only, not committed) and writes
small JSON indexes to data/index/ that the API loads at startup:

  venues.json   one row per commercial property that has a Matterport scan,
                joined with its active for-lease / for-sale listings
  housing.json  one row per apartment community with live availability

Run once after unzipping the kit:
    python scripts/build_index.py
"""

from __future__ import annotations

import csv
import json
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
KIT = ROOT / "data" / "kit"
OUT = ROOT / "data" / "index"

ENUMS = json.loads((KIT / "schemas" / "enums.json").read_text())
PROPERTY_TYPE = ENUMS["PropertyType"]
PROPERTY_SUBTYPE = ENUMS.get("PropertySubtype", {})
LISTING_TYPE = ENUMS["ListingType"]

BROKER_ROLES = {6, 11, 20, 46, 47, 62, 17}


def iter_jsonl(name: str):
    with open(KIT / "data" / f"{name}.jsonl") as fh:
        for line in fh:
            if line.strip():
                yield json.loads(line)


def address_line(addr: dict | None) -> str:
    if not addr:
        return ""
    street = " ".join(
        str(p) for p in (addr.get("streetNumber"), addr.get("streetName"), addr.get("streetType")) if p
    )
    return ", ".join(p for p in (street, addr.get("city"), addr.get("state")) if p)


def ceiling_height_ft(prop: dict) -> float | None:
    for key in ("propertyRetail", "propertyIndustrial", "propertyFlex", "propertyOffice"):
        s = (prop.get(key) or {}).get("structural") or {}
        ft = s.get("ceilingHeightFeet")
        if ft:
            return round(ft + (s.get("ceilingHeightInches") or 0) / 12, 1)
        slab = s.get("slabToSlabHeightFeet")
        if slab:
            return float(slab)
    return None


def year_built(prop: dict) -> int | None:
    for ev in prop.get("constructionEvents") or []:
        if ev.get("eventType") == 2 and ev.get("year"):
            return ev["year"]
    return None


def parking_spaces(prop: dict) -> int | None:
    total = sum((p.get("totalSpaces") or 0) for p in prop.get("parking") or [])
    return total or None


def listing_contacts(listing: dict) -> list[dict]:
    out = []
    for c in listing.get("listingContacts") or []:
        if c.get("contactRole") not in BROKER_ROLES and out:
            continue
        name = " ".join(p for p in (c.get("firstName"), c.get("lastName")) if p)
        out.append({
            "name": name or None,
            "firm": c.get("locationName"),
            "email": c.get("emailAddress"),
            "phone": c.get("phoneNumber"),
        })
        if len(out) >= 2:
            break
    return out


def summarize_listing(listing: dict) -> dict:
    lease = listing.get("forLeaseSummary") or {}
    sale = listing.get("forSaleSummary") or {}
    basis = lease.get("askingRateBasis")
    rate_low, rate_high = lease.get("askingRateLow"), lease.get("askingRateHigh")
    if basis == 1:  # monthly -> yearly
        rate_low = rate_low * 12 if rate_low else rate_low
        rate_high = rate_high * 12 if rate_high else rate_high
    return {
        "id": listing["id"],
        "type": LISTING_TYPE.get(str(listing.get("listingType")), "Unknown"),
        "available_sf": lease.get("totalAvailableSquareFeet") or sale.get("totalAvailableSquareFeet"),
        "max_contiguous_sf": lease.get("maxContiguousSquareFeet"),
        "asking_rate_sf_yr": [rate_low or None, rate_high or None],
        "brokerage": listing.get("brokerageCompanyName"),
        "contacts": listing_contacts(listing),
    }


def build_venues() -> list[dict]:
    models: dict[int, list[str]] = defaultdict(list)
    with open(KIT / "commercial-properties.csv") as fh:
        for row in csv.DictReader(fh):
            if row["MatterportModelId"]:
                models[int(row["PropertyId"])].append(row["MatterportModelId"])

    listings: dict[int, list[dict]] = defaultdict(list)
    for listing in iter_jsonl("commercial-listing-summary"):
        if listing.get("listingStatus") != 1:  # active only
            continue
        pid = listing.get("propertyId")
        if pid:
            listings[pid].append(summarize_listing(listing))

    venues = []
    for prop in iter_jsonl("commercial-property"):
        pid = prop["id"]
        if pid not in models:
            continue
        addr = prop.get("primaryAddress") or {}
        if addr.get("latitude") is None:
            continue
        photo = (prop.get("primaryPhoto") or {}).get("attachmentUri")
        venues.append({
            "id": pid,
            "name": prop.get("buildingName") or address_line(addr),
            "address": address_line(addr),
            "city": addr.get("city"),
            "state": addr.get("state"),
            "lat": addr["latitude"],
            "lon": addr["longitude"],
            "property_type": PROPERTY_TYPE.get(str(prop.get("propertyType")), "Unknown"),
            "subtype": PROPERTY_SUBTYPE.get(str(prop.get("propertySubtype")), None),
            "building_sf": prop.get("rentableBuildingAreaSquareFeet") or prop.get("grossBuildingAreaSquareFeet"),
            "stories": prop.get("numStoriesAboveGrade"),
            "ceiling_ft": ceiling_height_ft(prop),
            "year_built": year_built(prop),
            "parking_spaces": parking_spaces(prop),
            "photo": photo,
            "matterport_models": models[pid],
            "listings": listings.get(pid, []),
        })
    return venues


def build_housing() -> list[dict]:
    homes = []
    for apt in iter_jsonl("apartment-listing"):
        addr = apt.get("address") or {}
        if addr.get("latitude") is None:
            continue
        plans = []
        for m in apt.get("apartmentModels") or []:
            avail = m.get("numUnitsAvailable") or 0
            if avail <= 0:
                continue
            beds = m.get("numBeds") or 0
            plans.append({
                "name": m.get("name"),
                "beds": beds,
                "baths": m.get("numBaths"),
                "available": avail,
                "sleeps": m.get("maxOccupants") or max(2, beds * 2),
                "rent_low": m.get("minRent") or None,
                "rent_high": m.get("maxRent") or m.get("minRent") or None,
            })
        if not plans:
            continue
        homes.append({
            "id": apt["id"],
            "property_id": apt.get("propertyId"),
            "name": apt.get("buildingName") or address_line(addr),
            "address": address_line(addr),
            "city": addr.get("city"),
            "lat": addr["latitude"],
            "lon": addr["longitude"],
            "manager": apt.get("propertyManagementCompanyName"),
            "photo": (apt.get("primaryPhoto") or {}).get("attachmentUri"),
            "plans": plans,
        })
    return homes


def main() -> int:
    if not KIT.exists():
        print(f"Kit not found at {KIT}. Unzip costar-hackathon-kit.zip into data/kit first.")
        return 1
    OUT.mkdir(parents=True, exist_ok=True)
    venues = build_venues()
    (OUT / "venues.json").write_text(json.dumps(venues))
    housing = build_housing()
    (OUT / "housing.json").write_text(json.dumps(housing))
    with_listing = sum(1 for v in venues if v["listings"])
    print(f"venues: {len(venues)} ({with_listing} with active listings)")
    print(f"housing: {len(housing)} communities with availability")
    return 0


if __name__ == "__main__":
    sys.exit(main())
