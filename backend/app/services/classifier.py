"""Classify an issue into a ticket draft: subcategory, priority and support group.

The fast model picks the subcategory and rates impact and urgency; priority then comes
from the standard ITIL impact x urgency matrix, and the support group from the graph's
routing rules. Anything the model gets wrong is corrected or sent to L1 triage.
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from .. import llm
from ..config import get_settings
from ..schemas import TicketDraft
from .taxonomy import TRIAGE_GROUP, find_subcategory, taxonomy

# ITIL priority matrix: (impact, urgency) -> priority. 1 = high, 3 = low.
PRIORITY_MATRIX = {
    (1, 1): "1 - Critical", (1, 2): "2 - High", (2, 1): "2 - High",
    (1, 3): "3 - Moderate", (2, 2): "3 - Moderate", (3, 1): "3 - Moderate",
    (2, 3): "4 - Low", (3, 2): "4 - Low", (3, 3): "4 - Low",
}
MIN_CONFIDENCE = 0.45  # below this the ticket goes to L1 for manual triage


class _Classification(BaseModel):
    subcategory: str = Field(description="exactly one name from the list, or 'Unknown'")
    impact: int = Field(ge=1, le=3, description="1 = many users / whole team or site, 2 = a few users or one "
                                                "department, 3 = one user")
    urgency: int = Field(ge=1, le=3, description="1 = the user cannot do their job at all, or a security risk, "
                                                 "2 = work is degraded or slow, 3 = a workaround exists or it's a "
                                                 "request (install, access, how-to)")
    short_description: str = Field(description="ticket title, max 80 characters, no names or passwords")
    description: str = Field(description="what the user reported, error messages, device, and steps already tried")
    confidence: float = Field(ge=0, le=1)
    rationale: str = Field(description="one short sentence on why this subcategory and priority")


def _system_prompt() -> str:
    lines = [f"- {s['name']} ({s['category']}): e.g. {', '.join((s['examples'] or [])[:3])}"
             for s in taxonomy()["subcategories"]]
    return ("You are the triage engine of an IT service desk. Classify the user's issue into exactly one "
            "subcategory from this list, rate impact and urgency, and write a clear ticket.\n"
            "Subcategories:\n" + "\n".join(lines) + "\n"
            "Rules:\n"
            "- Urgency 1 when the user is fully blocked: can't log in or is locked out, can't connect to VPN while "
            "remote, laptop won't start, no network at all, BitLocker recovery screen, or after a still-failing fix.\n"
            "- Urgency 1 for a clicked phishing link or entered password, or an active malware alert.\n"
            "- Impact 1 if a whole office/site or many people are affected, 2 if several colleagues or a team, "
            "otherwise 3.\n"
            "- Never include passwords, MFA codes or other secrets in the ticket text.\n"
            "- If nothing fits, use 'Unknown' with low confidence.")


def classify(text: str) -> tuple[TicketDraft, dict]:
    """Return a ticket draft for free-text issue description (or conversation summary)."""
    result, info = llm.chat_json(get_settings().model_fast, _system_prompt(), text[:4000], _Classification,
                                 max_tokens=700, reasoning="off")
    sub = find_subcategory(result.subcategory)
    confident = sub is not None and result.confidence >= MIN_CONFIDENCE
    priority = PRIORITY_MATRIX[(result.impact, result.urgency)]
    if sub and sub["category"] == "Security" and priority in ("3 - Moderate", "4 - Low") and result.urgency == 1:
        priority = "2 - High"  # security incidents are never low priority
    draft = TicketDraft(
        short_description=result.short_description.strip()[:120] or "IT issue",
        description=result.description.strip()[:4000] or text[:4000],
        category=sub["category"] if sub else "Unclassified",
        subcategory=sub["name"] if sub else None,
        assignment_group=sub["group"] if confident else TRIAGE_GROUP,
        priority=priority, impact=result.impact, urgency=result.urgency,
        confidence=round(result.confidence, 2),
        rationale=result.rationale.strip()[:300] + ("" if confident else " (Low confidence: sent to L1 triage.)"),
    )
    info["model_subcategory"] = result.subcategory
    return draft, info
