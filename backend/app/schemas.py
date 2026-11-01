"""Request and response models. Every user-supplied string has a length limit."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, EmailStr, Field

TicketState = Literal["New", "In Progress", "On Hold", "Resolved", "Closed"]
Priority = Literal["1 - Critical", "2 - High", "3 - Moderate", "4 - Low"]
OPEN_STATES = ("New", "In Progress", "On Hold")


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(..., min_length=1, max_length=4000)


class ChatRequest(BaseModel):
    messages: list[ChatMessage] = Field(..., min_length=1, max_length=40)


class TicketDraft(BaseModel):
    """A classified ticket the user can review before it's created."""
    short_description: str = Field(..., min_length=3, max_length=120)
    description: str = Field(..., min_length=3, max_length=4000)
    category: str
    subcategory: str | None
    assignment_group: str
    priority: Priority
    impact: int = Field(..., ge=1, le=3)
    urgency: int = Field(..., ge=1, le=3)
    confidence: float = Field(..., ge=0, le=1)
    rationale: str = ""


class ClassifyRequest(BaseModel):
    text: str = Field(..., min_length=5, max_length=4000)


class CreateTicketRequest(BaseModel):
    caller_name: str = Field(..., min_length=2, max_length=100)
    caller_email: EmailStr
    short_description: str = Field(..., min_length=3, max_length=120)
    description: str = Field(..., min_length=3, max_length=4000)
    subcategory: str | None = Field(None, max_length=80)
    priority: Priority | None = None
    department: str | None = Field(None, max_length=60)
    location: str | None = Field(None, max_length=60)
    contact_type: Literal["Chat", "Self-service", "Phone", "Email", "Walk-in"] = "Chat"


class UpdateTicketRequest(BaseModel):
    state: TicketState | None = None
    priority: Priority | None = None
    assignment_group: str | None = Field(None, max_length=60)
    assigned_to: str | None = Field(None, max_length=80)
    work_note: str | None = Field(None, max_length=2000)
    resolution_notes: str | None = Field(None, max_length=2000)
