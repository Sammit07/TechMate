"""FastAPI application: routes, middleware and error handling.

All routes live under /api (Vercel routes /api/* to this service).
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from collections.abc import Iterator

from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from openai import APIError
from pydantic import BaseModel, Field

from . import auth, db, storage
from .config import get_settings
from .ingest import documents, imports, knowledge, tickets_csv
from .ratelimit import chat_limit, check as check_rate, require_admin, upload_limit, write_limit
from .retrieval import hybrid_search, similar_to_ticket
from .schemas import ChatRequest, ClassifyRequest, CreateTicketRequest, TicketDraft, UpdateTicketRequest
from .services import analytics, assistant, classifier, events, forecast, graph_view, kb, tickets, workspaces
from .services.events import MAX_EVENTS_PER_NOTICE, EventIn
from .services.taxonomy import taxonomy

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
for noisy in ("httpx", "openai", "urllib3"):
    logging.getLogger(noisy).setLevel(logging.WARNING)
log = logging.getLogger("api")

app = FastAPI(title="TechMate API", version="2.2.0",
              description="TechMate, an AI IT service desk on a knowledge graph: GraphRAG chat, ticketing, "
                          "dashboard, forecasting, operational events and data uploads.",
              docs_url="/api/docs", openapi_url="/api/openapi.json", redoc_url=None)
app.add_middleware(CORSMiddleware, allow_origins=get_settings().cors_origins, allow_methods=["GET", "POST", "PATCH", "DELETE"],
                   allow_headers=["Content-Type", "X-Admin-Token"], max_age=600)


app.add_middleware(auth.AccessMiddleware)


@app.middleware("http")
async def request_context(request: Request, call_next):
    """Request id + timing on every response; logs one line per request."""
    request_id = request.headers.get("x-request-id") or uuid.uuid4().hex[:12]
    started = time.perf_counter()
    response = await call_next(request)
    response.headers["x-request-id"] = request_id
    response.headers["x-content-type-options"] = "nosniff"
    log.info("%s %s %s %dms id=%s", request.method, request.url.path, response.status_code,
             (time.perf_counter() - started) * 1000, request_id)
    return response


@app.exception_handler(tickets.TicketNotFound)
async def _not_found(_: Request, e: tickets.TicketNotFound):
    return JSONResponse(status_code=404, content={"detail": f"Ticket {e} not found"})


@app.exception_handler(LookupError)
async def _missing(_: Request, e: LookupError):
    return JSONResponse(status_code=404, content={"detail": f"{e} not found"})


@app.exception_handler(ValueError)
async def _bad_value(_: Request, e: ValueError):
    return JSONResponse(status_code=422, content={"detail": str(e)})


@app.exception_handler(APIError)
async def _llm_error(_: Request, e: APIError):
    log.error("LLM provider error: %s", e)
    return JSONResponse(status_code=503, content={"detail": "The AI service is temporarily unavailable. "
                                                            "Please try again shortly."})


@app.exception_handler(Exception)
async def _unexpected(request: Request, e: Exception):
    log.exception("unhandled error on %s", request.url.path)
    return JSONResponse(status_code=500, content={"detail": "Internal error. Please try again."})


# --- meta ---------------------------------------------------------------------------------------

@app.get("/api/health", tags=["meta"])
def health(request: Request) -> dict:
    """Liveness. Details (counts, memory, models) only for signed-in users."""
    s = get_settings()
    try:
        tickets_n = db.read("MATCH (t:Ticket) RETURN count(t) AS n")[0]["n"]
        database = {"ok": True, "tickets": tickets_n, **db.memory_usage_mb()}
    except Exception as e:  # noqa: BLE001
        database = {"ok": False, "error": type(e).__name__}
    status = "ok" if database["ok"] else "degraded"
    if not auth.valid_token(request.cookies.get(auth.SESSION_COOKIE)):
        return {"status": status}
    return {"status": status, "database": database,
            "models": {"fast": s.model_fast, "reasoning": s.model_reasoning, "embeddings": s.embed_model}}


@app.get("/api/taxonomy", tags=["meta"])
def get_taxonomy() -> dict:
    t = taxonomy()
    return {"categories": t["categories"], "groups": t["groups"],
            "subcategories": [{k: s[k] for k in ("name", "category", "group")} for s in t["subcategories"]],
            "locations": events.known_locations(), "event_types": list(events.EVENT_TYPES)}


# --- assistant ----------------------------------------------------------------------------------

def _sse(events: Iterator[dict]) -> Iterator[str]:
    try:
        for event in events:
            yield f"data: {json.dumps(event, default=str)}\n\n"
    except Exception:  # noqa: BLE001 - surface to the UI instead of a dead stream
        log.exception("chat stream failed")
        yield f"data: {json.dumps({'type': 'error', 'message': 'Something went wrong. Please try again.'})}\n\n"


@app.post("/api/chat", tags=["assistant"], dependencies=[Depends(chat_limit)])
def chat(req: ChatRequest) -> StreamingResponse:
    """One assistant turn, streamed as Server-Sent Events."""
    if req.messages[-1].role != "user":
        raise HTTPException(422, "The last message must be from the user")
    return StreamingResponse(_sse(assistant.run_turn(req.messages)), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.post("/api/classify", tags=["tickets"], response_model=TicketDraft, dependencies=[Depends(chat_limit)])
def classify_issue(req: ClassifyRequest) -> TicketDraft:
    draft, _ = classifier.classify(req.text)
    return draft


@app.get("/api/search", tags=["assistant"], dependencies=[Depends(chat_limit)])
def search(q: str = Query(..., min_length=3, max_length=300), k: int = Query(5, ge=1, le=10)) -> dict:
    r = hybrid_search(q, k=k)
    return {"chunks": r.chunks, "entities": r.entities, "fix_paths": r.fix_paths,
            "similar_tickets": r.similar_tickets, "timings_ms": r.timings_ms}


# --- tickets ------------------------------------------------------------------------------------

@app.get("/api/tickets", tags=["tickets"])
def list_tickets(state: str | None = Query(None, pattern="^(open|closed|New|In Progress|On Hold|Resolved|Closed)$"),
                 group: str | None = Query(None, max_length=60), subcategory: str | None = Query(None, max_length=80),
                 priority: str | None = Query(None, max_length=20), q: str | None = Query(None, max_length=200),
                 limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0, le=100_000)) -> dict:
    return tickets.list_tickets(state=state, group=group, subcategory=subcategory, priority=priority, q=q,
                                limit=limit, offset=offset)


@app.post("/api/tickets", tags=["tickets"], status_code=201, dependencies=[Depends(write_limit)])
def create_ticket(req: CreateTicketRequest) -> dict:
    """Create a ticket. If no subcategory/priority is given, the issue is classified first."""
    draft = None
    if not (req.subcategory and req.priority):
        draft, _ = classifier.classify(f"{req.short_description}\n{req.description}")
    return tickets.create_ticket(req, draft)


@app.get("/api/tickets/{number}", tags=["tickets"])
def get_ticket(number: str) -> dict:
    if not number.upper().startswith("INC") or len(number) > 12:
        raise HTTPException(404, "Ticket not found")
    return tickets.get_ticket(number)


@app.get("/api/tickets/{number}/related", tags=["tickets"], dependencies=[Depends(chat_limit)])
def related(number: str) -> dict:
    """KB articles and similar resolved tickets for an agent working this ticket (hybrid GraphRAG)."""
    t = tickets.get_ticket(number)
    r = hybrid_search(f"{t['short_description']}. {t['description'].split(' Device:')[0]}", k=4, with_tickets=False)
    return {"chunks": r.chunks, "fix_paths": r.fix_paths, "similar_tickets": similar_to_ticket(t),
            "entities": r.entities[:8]}


@app.patch("/api/tickets/{number}", tags=["tickets"], dependencies=[Depends(write_limit)])
def update_ticket(number: str, req: UpdateTicketRequest) -> dict:
    return tickets.update_ticket(number, req)


# --- analytics ----------------------------------------------------------------------------------

@app.get("/api/dashboard", tags=["analytics"])
def dashboard(days: int = Query(30, ge=7, le=180)) -> dict:
    """Live service-desk metrics (cached ~30 s)."""
    return analytics.dashboard(days)


@app.get("/api/forecast", tags=["analytics"])
def get_forecast(horizon: int = Query(14, ge=7, le=42)) -> dict:
    """Expected ticket volume per day, category and support group, with backtest accuracy."""
    return forecast.forecast(horizon)


# --- knowledge base -----------------------------------------------------------------------------

@app.get("/api/kb", tags=["knowledge base"])
def kb_list(q: str | None = Query(None, max_length=200), category: str | None = Query(None, max_length=60)) -> list[dict]:
    return kb.list_articles(q, category)


@app.get("/api/kb/{kb_id}", tags=["knowledge base"])
def kb_article(kb_id: str) -> dict:
    article = kb.get_article(kb_id.upper()) if kb_id.upper().startswith("KB") and len(kb_id) <= 12 else None
    if article is None:
        raise HTTPException(404, "Article not found")
    return article


@app.get("/api/files/{kind}/{name}", tags=["knowledge base"], include_in_schema=False)
def stored_file(kind: str, name: str) -> FileResponse:
    """Original uploaded documents (local storage only; see app/storage.py)."""
    path = storage.path_for(kind, name)
    if path is None:
        raise HTTPException(404, "File not found")
    media = "application/pdf" if path.suffix.lower() == ".pdf" else "text/plain; charset=utf-8"
    # Shown inline on the article page (same site only); text types are served as plain text, never rendered.
    return FileResponse(path, media_type=media, headers={"Content-Disposition": f'inline; filename="{path.name}"',
                                                         "Cache-Control": "private, max-age=3600",
                                                         "X-Frame-Options": "SAMEORIGIN",
                                                         "Content-Security-Policy": "sandbox; frame-ancestors 'self'"})


# --- uploads ------------------------------------------------------------------------------------

def _read_upload(file: UploadFile, allowed: tuple[str, ...]) -> tuple[str, bytes]:
    name = (file.filename or "upload").strip()
    if not name.lower().endswith(allowed):
        raise HTTPException(415, f"Unsupported file type. Allowed: {', '.join(allowed)}")
    limit = int(get_settings().max_upload_mb * 1024 * 1024)
    data = file.file.read(limit + 1)
    if len(data) > limit:
        raise HTTPException(413, f"File too large: the limit is {get_settings().max_upload_mb:g} MB")
    if not data:
        raise HTTPException(422, "The file is empty")
    return name[-200:], data


@app.post("/api/imports/tickets", tags=["uploads"], dependencies=[Depends(require_admin), Depends(upload_limit)])
def import_tickets(file: UploadFile = File(...), dry_run: bool = Form(False)) -> dict:
    """Import incidents from a ServiceNow CSV export. `dry_run` validates and previews without saving."""
    name, data = _read_upload(file, (".csv",))
    return tickets_csv.import_csv(name, data, dry_run=dry_run)


@app.post("/api/imports/documents", tags=["uploads"], dependencies=[Depends(require_admin), Depends(upload_limit)])
def upload_document(file: UploadFile = File(...), title: str | None = Form(None, max_length=150),
                    subcategory: str | None = Form(None, max_length=80)) -> dict:
    """Add a PDF/TXT/Markdown document to the knowledge base (chunked, embedded, entity-extracted)."""
    name, data = _read_upload(file, documents.ALLOWED_TYPES)
    return documents.upload_document(name, data, title=title or None, subcategory=subcategory or None)


@app.get("/api/imports", tags=["uploads"])
def list_imports() -> list[dict]:
    return imports.list_imports()


@app.delete("/api/imports/{import_id}", tags=["uploads"], dependencies=[Depends(require_admin), Depends(write_limit)])
def undo_import(import_id: str) -> dict:
    """Undo an upload: removes the tickets, document or events it added."""
    return imports.delete_import(import_id)


# --- operational events -------------------------------------------------------------------------

@app.post("/api/events/extract", tags=["events"], dependencies=[Depends(require_admin), Depends(upload_limit)])
def extract_events(file: UploadFile | None = File(None), text: str | None = Form(None, max_length=20_000)) -> dict:
    """Read a maintenance / power / change notice (file or pasted text) into event drafts. Nothing is saved."""
    if file is not None and file.filename:
        name, data = _read_upload(file, (".pdf", ".txt", ".md", ".eml"))
        body = " ".join(t for _, t in knowledge.document_pages(name, data))
    elif text and text.strip():
        name, body = "pasted notice", text
    else:
        raise HTTPException(422, "Upload a notice file or paste its text")
    return {"file_name": name, "events": events.extract_notice(body), "locations": events.known_locations()}


class SaveEventsRequest(BaseModel):
    file_name: str = Field("notice", max_length=200)
    events: list[EventIn] = Field(..., min_length=1, max_length=MAX_EVENTS_PER_NOTICE)


@app.post("/api/events", tags=["events"], status_code=201, dependencies=[Depends(require_admin), Depends(write_limit)])
def save_events(req: SaveEventsRequest) -> dict:
    """Save confirmed events and link them to the incidents they affected."""
    return events.save_notice(req.events, file_name=req.file_name, file_url=None)


@app.get("/api/events", tags=["events"])
def list_events(when: str = Query("all", pattern="^(all|active|upcoming|past)$"),
                type: list[str] | None = Query(None), limit: int = Query(200, ge=1, le=500)) -> list[dict]:
    return events.list_events(when, type, limit)


@app.get("/api/events/{event_id}", tags=["events"])
def get_event(event_id: str) -> dict:
    event = events.get_event(event_id.upper())
    if event is None:
        raise HTTPException(404, "Event not found")
    return event


@app.delete("/api/events/{event_id}", tags=["events"], dependencies=[Depends(require_admin), Depends(write_limit)])
def delete_event(event_id: str) -> dict:
    if not events.delete_event(event_id.upper()):
        raise HTTPException(404, "Event not found")
    return {"deleted": event_id.upper()}


# --- network graph ------------------------------------------------------------------------------

@app.get("/api/graph/ticket/{number}", tags=["graph"])
def ticket_graph(number: str) -> dict:
    """How a ticket was raised, routed and resolved, and the events that affected it."""
    if not number.upper().startswith("INC") or len(number) > 12:
        raise HTTPException(404, "Ticket not found")
    return graph_view.ticket_graph(number)


@app.get("/api/graph/event/{event_id}", tags=["graph"])
def event_graph(event_id: str) -> dict:
    """An event, where and what it impacted, and the incidents linked to it."""
    graph = graph_view.event_graph(event_id.upper())
    if graph is None:
        raise HTTPException(404, "Event not found")
    return graph


# --- sign-in --------------------------------------------------------------------------------------

class LoginRequest(BaseModel):
    password: str = Field(..., min_length=1, max_length=200)


def _set_cookie(response: Response, request: Request, name: str, value: str, max_age: int, *, http_only: bool) -> None:
    secure = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
    response.set_cookie(name, value, max_age=max_age, path="/", httponly=http_only, secure=secure, samesite="lax")


@app.post("/api/auth/login", tags=["auth"])
def login(req: LoginRequest, request: Request, response: Response) -> dict:
    """Sign in with the app password; sets the session cookie."""
    check_rate(request, "login", 5)  # slows down password guessing
    if not auth.auth_required():
        return {"authenticated": True, "auth_required": False}
    if not auth.check_password(req.password):
        raise HTTPException(401, "Wrong password")
    _set_cookie(response, request, auth.SESSION_COOKIE, auth.make_token(), get_settings().session_days * 86400,
                http_only=True)
    return {"authenticated": True, "auth_required": True}


@app.get("/api/auth/session", tags=["auth"])
def session(request: Request, response: Response) -> dict:
    """Is this browser signed in? With sign-in off, marks the browser as allowed in."""
    if not auth.auth_required():
        _set_cookie(response, request, auth.SESSION_COOKIE, auth.OPEN_SESSION, 86400, http_only=True)
        return {"authenticated": True, "auth_required": False}
    return {"authenticated": auth.valid_token(request.cookies.get(auth.SESSION_COOKIE)), "auth_required": True}


@app.post("/api/auth/logout", tags=["auth"])
def logout(response: Response) -> dict:
    response.delete_cookie(auth.SESSION_COOKIE, path="/")
    return {"authenticated": False}


# --- workspaces ---------------------------------------------------------------------------------

class CreateWorkspaceRequest(BaseModel):
    name: str = Field(..., min_length=2, max_length=60)
    template: str = Field("knowledge", pattern="^(blank|knowledge)$")


def _current_workspace_id(request: Request) -> str:
    ws = request.cookies.get(auth.WORKSPACE_COOKIE)
    return ws if ws and workspaces.get(ws) else workspaces.DEFAULT_ID


@app.get("/api/workspaces", tags=["workspaces"])
def list_workspaces(request: Request) -> dict:
    return {"current": _current_workspace_id(request),
            "items": [{k: w[k] for k in ("id", "name", "template", "created_at")} for w in workspaces.list_workspaces()]}


@app.post("/api/workspaces", tags=["workspaces"], status_code=201, dependencies=[Depends(write_limit)])
def create_workspace(req: CreateWorkspaceRequest, request: Request, response: Response) -> dict:
    """Create a workspace (its own graph) and switch to it."""
    ws = workspaces.create(req.name, req.template)
    _set_cookie(response, request, auth.WORKSPACE_COOKIE, ws["id"], 365 * 86400, http_only=False)
    return ws


@app.post("/api/workspaces/{workspace_id}/select", tags=["workspaces"])
def select_workspace(workspace_id: str, request: Request, response: Response) -> dict:
    w = workspaces.get(workspace_id)
    if w is None:
        raise HTTPException(404, "Workspace not found")
    _set_cookie(response, request, auth.WORKSPACE_COOKIE, w["id"], 365 * 86400, http_only=False)
    return workspaces.summary(w)


@app.delete("/api/workspaces/{workspace_id}", tags=["workspaces"],
            dependencies=[Depends(require_admin), Depends(write_limit)])
def delete_workspace(workspace_id: str, request: Request, response: Response) -> dict:
    """Delete a workspace and all its data (not the default one)."""
    workspaces.delete(workspace_id)
    if request.cookies.get(auth.WORKSPACE_COOKIE) == workspace_id:
        response.delete_cookie(auth.WORKSPACE_COOKIE, path="/")
    return {"deleted": workspace_id}
