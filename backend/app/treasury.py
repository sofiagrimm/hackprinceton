"""Tour treasurer on Capital One's Nessie API.

A touring group's money lives in a Nessie checking account (the "tour fund"),
and each member has an account they pay dues from. For a planned stop we:

* plan  - total the venue fee estimate and lodging, compare with the fund
          balance, and work out the break-even ticket price and each member's
          share (no money moves);
* commit - on the treasurer's say-so, create pending bills for the venue
          deposit and the lodging hold, and collect each member's share by
          transfer into the fund.

The agent may plan on its own; moving money is a button a person presses.
"""

from __future__ import annotations

import json
import os

import httpx

from . import data
from .config import CACHE_DIR

API = "https://v2-prod-api.nessieisreal.com"
STATE = CACHE_DIR / "nessie_state.json"
START_FUND_CENTS = int(float(os.environ.get("TOUR_FUND_START", "2500")) * 100)
MEMBER_START_CENTS = int(float(os.environ.get("TOUR_MEMBER_START", "2500")) * 100)
DEMO_MEMBERS = int(os.environ.get("TOUR_MEMBERS_IN_BANK", "4"))  # members mirrored in Nessie


class NessieError(RuntimeError):
    pass


def _key() -> str:
    key = os.environ.get("NESSIE_API_KEY", "")
    if not key:
        raise NessieError("NESSIE_API_KEY is not set in .env")
    return key


def _req(method: str, path: str, body: dict | None = None) -> dict:
    r = httpx.request(method, f"{API}{path}", json=body, timeout=30,
                      headers={"Authorization": f"Bearer {_key()}"})
    if r.status_code >= 400:
        raise NessieError(f"Nessie {method} {path} -> {r.status_code}: {r.text[:300]}")
    return r.json() if r.content else {}


def _load_state() -> dict:
    return json.loads(STATE.read_text()) if STATE.exists() else {}


def _save_state(state: dict) -> None:
    STATE.write_text(json.dumps(state, indent=2))


ADDRESS = {"street_number": "1", "street_name": "Tour Rd", "city": "Princeton", "state": "NJ", "zip": "08544"}


def ensure_group(group_name: str = "Encore Tour Fund") -> dict:
    """Create (once) the group's treasury customer + fund account and a few member accounts."""
    state = _load_state()
    if state.get("fund_account_id"):
        return state
    treasurer = _req("POST", "/customers", {"first_name": "Tour", "last_name": "Treasury", "address": ADDRESS})
    fund = _req("POST", f"/customers/{treasurer['id']}/accounts",
                {"type": "Checking", "nickname": group_name, "balance_cents": START_FUND_CENTS})
    members = []
    for i in range(DEMO_MEMBERS):
        cust = _req("POST", "/customers", {"first_name": f"Singer{i + 1}", "last_name": "Member", "address": ADDRESS})
        acct = _req("POST", f"/customers/{cust['id']}/accounts",
                    {"type": "Checking", "nickname": f"Singer {i + 1}", "balance_cents": MEMBER_START_CENTS})
        members.append({"customer_id": cust["id"], "account_id": acct["id"], "name": f"Singer {i + 1}"})
    state = {"fund_account_id": fund["id"], "treasurer_id": treasurer["id"], "members": members}
    _save_state(state)
    return state


def fund_snapshot() -> dict:
    state = ensure_group()
    fund = _req("GET", f"/accounts/{state['fund_account_id']}")
    bills = _req("GET", f"/accounts/{state['fund_account_id']}/bills").get("items", [])
    txns = _req("GET", f"/accounts/{state['fund_account_id']}/transactions").get("items", [])
    pending = sum(b.get("payment_amount") or 0 for b in bills if b.get("status") == "pending")
    return {
        "account_id": state["fund_account_id"],
        "nickname": fund.get("nickname"),
        "balance": _dollars(fund),
        "pending_bills": round(pending, 2),
        "available_after_bills": round(_dollars(fund) - pending, 2),
        "bills": [{"payee": b.get("payee"), "amount": b.get("payment_amount"), "status": b.get("status"),
                   "nickname": b.get("nickname")} for b in bills[-8:]],
        "recent": [{"type": t.get("type"), "amount": _cents_to_dollars(t.get("amount_cents")),
                    "description": t.get("description"), "status": t.get("status")} for t in txns[-8:]],
        "members_in_bank": len(state["members"]),
    }


def _dollars(account: dict) -> float:
    if "balance_cents" in account:
        return round(account["balance_cents"] / 100, 2)
    return float(account.get("balance") or 0)


def _cents_to_dollars(c) -> float | None:
    return round(c / 100, 2) if isinstance(c, (int, float)) else None


def venue_fee_estimate(venue: dict, space_area_sqft: float | None) -> dict:
    """Rough one-evening rental estimate; the outreach email asks for the real number."""
    area = space_area_sqft or 1500
    if venue.get("hotel"):
        fee = max(400, area * 0.35)
        basis = "hotel event space, ~$0.35 per sq ft per evening"
    elif venue["property_type"] == "Multifamily":
        fee = max(250, area * 0.15)
        basis = "residential amenity space, ~$0.15 per sq ft per evening"
    else:
        fee = max(350, area * 0.25)
        basis = "commercial space, ~$0.25 per sq ft per evening"
    return {"fee": round(fee, -1), "basis": basis}


def plan_tour_budget(venue_id: int, group_size: int = 14, nights: int = 2, audience: int = 60,
                     lodging_total: float | None = None, space_area_sqft: float | None = None) -> dict:
    """Can the tour fund cover this stop? Costs, break-even ticket price and per-member share."""
    venue = data.venues().get(int(venue_id))
    if not venue:
        return {"error": f"Unknown venue {venue_id}"}
    if lodging_total is None:
        from .scout import find_housing
        options = find_housing(venue_id, group_size=group_size, nights=nights).get("options") or []
        lodging_total = options[0].get("estimated_total") if options else 0
    fee = venue_fee_estimate(venue, space_area_sqft)
    deposit = round(fee["fee"] * 0.5, 2)
    total = round(fee["fee"] + (lodging_total or 0), 2)
    try:
        fund = fund_snapshot()
        available = fund["available_after_bills"]
        bank = "Capital One Nessie"
    except (NessieError, httpx.HTTPError) as exc:
        fund, available, bank = None, None, f"unavailable ({exc})"
    shortfall = round(max(0.0, total - available), 2) if available is not None else None
    per_member = round(total / max(group_size, 1), 2)
    return {
        "venue": venue["name"],
        "costs": {"venue_fee_estimate": fee["fee"], "venue_fee_basis": fee["basis"],
                  "venue_deposit_50pct": deposit, "lodging_estimate": lodging_total, "total": total},
        "fund": fund and {k: fund[k] for k in ("balance", "pending_bills", "available_after_bills")},
        "bank": bank,
        "affordable": shortfall == 0 if shortfall is not None else None,
        "shortfall": shortfall,
        "per_member_share": per_member,
        "break_even_ticket": round(total / max(audience, 1), 2),
        "suggested_ticket": round(max(5, (total / max(audience * 0.7, 1))) + 0.49, 0),
        "note": "Venue fee is an estimate until the venue quotes; lodging uses CoStar average rates.",
    }


def commit_stop(venue_id: int, group_size: int = 14, nights: int = 2, audience: int = 60,
                space_area_sqft: float | None = None, collect_dues: bool = True) -> dict:
    """Treasurer-approved: hold the venue deposit and lodging as bills, collect member shares."""
    plan = plan_tour_budget(venue_id, group_size, nights, audience, space_area_sqft=space_area_sqft)
    if "error" in plan:
        return plan
    state = ensure_group()
    fund_id = state["fund_account_id"]
    venue = data.venues()[int(venue_id)]
    actions = []
    bill = _req("POST", f"/accounts/{fund_id}/bills", {
        "status": "pending", "payee": venue["name"], "nickname": "Venue deposit (50%)",
        "payment_amount": plan["costs"]["venue_deposit_50pct"]})
    actions.append({"type": "bill", "payee": venue["name"], "amount": bill.get("payment_amount"), "id": bill.get("id")})
    if plan["costs"]["lodging_estimate"]:
        bill = _req("POST", f"/accounts/{fund_id}/bills", {
            "status": "pending", "payee": "Group lodging", "nickname": f"Lodging hold, {nights} night(s)",
            "payment_amount": plan["costs"]["lodging_estimate"]})
        actions.append({"type": "bill", "payee": "Group lodging", "amount": bill.get("payment_amount"), "id": bill.get("id")})
    if collect_dues:
        share_cents = int(round(plan["per_member_share"] * 100))
        for m in state["members"]:
            try:
                available = _req("GET", f"/accounts/{m['account_id']}").get("balance_cents", 0)
            except NessieError:
                available = 0
            pay_cents = min(share_cents, max(0, available))
            if pay_cents <= 0:
                actions.append({"type": "short", "from": m["name"], "amount": plan["per_member_share"],
                                "owed": plan["per_member_share"]})
                continue
            try:
                t = _req("POST", f"/accounts/{m['account_id']}/transfers", {
                    "payee_id": fund_id, "amount_cents": pay_cents,
                    "description": f"Tour share: {venue['name']}"})
            except NessieError as exc:
                actions.append({"type": "short", "from": m["name"], "amount": 0,
                                "owed": plan["per_member_share"], "error": str(exc)[:200]})
                continue
            if t.get("id") and t.get("status") == "pending":
                try:  # sandbox: fast-forward settlement so the fund updates during the demo
                    t = _req("POST", f"/transactions/{t['id']}/settle") or t
                except NessieError:
                    pass
            paid = round(pay_cents / 100, 2)
            owed = round(plan["per_member_share"] - paid, 2)
            actions.append({"type": "transfer", "from": m["name"], "amount": paid, "owed": owed,
                            "id": t.get("id"), "status": t.get("status")})
    return {"plan": plan, "actions": actions, "fund": fund_snapshot(),
            "note": f"Dues collected from the {len(state['members'])} members mirrored in the sandbox bank."}
