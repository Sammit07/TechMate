// Typed client for the FastAPI backend. Requests go to same-origin /api:
// on Vercel, Services routing sends /api/* to the Python backend; in local dev,
// next.config.ts rewrites /api/* to the backend on 127.0.0.1:8000.

export type Priority = "1 - Critical" | "2 - High" | "3 - Moderate" | "4 - Low"
export type TicketState = "New" | "In Progress" | "On Hold" | "Resolved" | "Closed"

export interface TicketSummary {
  number: string
  short_description: string
  state: TicketState
  priority: Priority
  category: string | null
  subcategory: string | null
  assignment_group: string
  opened_at: string
  sla_breached: boolean
  /** Titles of events linked to the ticket (list rows only). */
  events?: string[]
}

export interface Ticket extends Omit<TicketSummary, "events"> {
  description: string
  caller: string | null
  caller_email: string | null
  service_offering?: string | null
  opened_by?: string | null
  updated_at?: string | null
  resolved_by?: string | null
  comments?: string | null
  location: string | null
  device: string | null
  assigned_to: string | null
  contact_type: string
  impact: string
  urgency: string
  active: boolean
  resolved_at?: string | null
  closed_at?: string | null
  resolution_minutes?: number | null
  resolution_notes?: string | null
  resolution_code?: string | null
  sla_target_minutes: number
  reassignment_count?: number
  work_notes?: string | null
  kb_article: { kb_id: string; title: string; file_name: string; file_url?: string | null } | null
  possible_major_incident?: { message: string; open_tickets_last_2h: number } | null
  events?: OpsEvent[]
}

export interface TicketDraft {
  short_description: string
  description: string
  category: string
  subcategory: string | null
  assignment_group: string
  priority: Priority
  impact: number
  urgency: number
  confidence: number
  rationale: string
}

export interface SourceChunk {
  kb_id: string
  title: string
  page: number
  file_name: string
  file_url?: string | null
  subcategory: string
}

export interface SimilarTicket {
  number: string
  short_description: string
  resolution: string
  subcategory: string
}

export interface FixPath {
  symptom: string
  cause: string
  fix: string
}

export type ChatEvent =
  | { type: "status"; stage: "understanding" | "searching" | "drafting_ticket" | "answering" }
  | { type: "sources"; chunks: SourceChunk[]; fix_paths: FixPath[]; similar_tickets: SimilarTicket[];
      entities: { name: string; type: string }[] }
  | { type: "token"; text: string }
  | { type: "ticket_draft"; draft: TicketDraft }
  | { type: "ticket"; ticket: Partial<Ticket> }
  | { type: "events"; events: Pick<OpsEvent, "event_id" | "title" | "type" | "start_at" | "end_at" | "status" | "advice"
                                    | "user_impact" | "locations" | "all_locations" | "reason">[] }
  | { type: "done"; intent: string; timings_ms: Record<string, number> }
  | { type: "error"; message: string }

export interface ChatMessage {
  role: "user" | "assistant"
  content: string
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

/** Signed out (or the session expired): go to the sign-in page, then come back here. */
function toSignIn(): never {
  const here = `${window.location.pathname}${window.location.search}`
  // Full page load (outside React): the session is gone, so drop all in-memory state.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  window.location.assign(`/login${here === "/" ? "" : `?next=${encodeURIComponent(here)}`}`)
  throw new ApiError(401, "Sign in required")
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } })
  if (res.status === 401 && !path.startsWith("/api/auth/")) toSignIn()
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`
    try {
      const body = await res.json()
      if (typeof body?.detail === "string") detail = body.detail
      else if (Array.isArray(body?.detail)) detail = body.detail.map((d: { msg: string }) => d.msg).join("; ")
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, detail)
  }
  return res.json() as Promise<T>
}

export const api = {
  taxonomy: () => request<{ categories: string[]; groups: { name: string; description: string }[];
                            subcategories: { name: string; category: string; group: string }[];
                            locations: string[]; event_types: EventType[] }>("/api/taxonomy"),
  tickets: (params: Record<string, string | number | undefined>) => {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, String(v))
    return request<{ total: number; items: TicketSummary[]; limit: number; offset: number }>(`/api/tickets?${qs}`)
  },
  ticket: (n: string) => request<Ticket>(`/api/tickets/${encodeURIComponent(n)}`),
  related: (n: string) => request<{ chunks: (SourceChunk & { text: string })[]; fix_paths: FixPath[];
                                    similar_tickets: SimilarTicket[] }>(`/api/tickets/${encodeURIComponent(n)}/related`),
  createTicket: (body: Record<string, unknown>) =>
    request<Ticket>("/api/tickets", { method: "POST", body: JSON.stringify(body) }),
  updateTicket: (n: string, body: Record<string, unknown>) =>
    request<Ticket>(`/api/tickets/${encodeURIComponent(n)}`, { method: "PATCH", body: JSON.stringify(body) }),
  dashboard: (days: number) => request<Dashboard>(`/api/dashboard?days=${days}`),
  forecast: (horizon: number) => request<Forecast | ForecastUnavailable>(`/api/forecast?horizon=${horizon}`),
  kbList: (q?: string) => request<KBArticle[]>(`/api/kb${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  kbArticle: (id: string) => request<KBArticleDetail>(`/api/kb/${encodeURIComponent(id)}`),

  events: (when: EventWhen = "all", types?: string[]) => {
    const qs = new URLSearchParams({ when })
    for (const t of types ?? []) qs.append("type", t)
    return request<OpsEvent[]>(`/api/events?${qs}`)
  },
  event: (id: string) => request<OpsEventDetail>(`/api/events/${encodeURIComponent(id)}`),
  extractNotice: (input: { file?: File; text?: string }) => {
    const form = new FormData()
    if (input.file) form.append("file", input.file)
    if (input.text) form.append("text", input.text)
    return upload<{ file_name: string; events: EventDraft[]; locations: string[] }>("/api/events/extract", form)
  },
  saveEvents: (file_name: string, events: EventDraft[]) =>
    request<{ import_id: string; events: (OpsEvent & { warnings: string[] })[] }>("/api/events", {
      method: "POST", headers: adminHeaders(), body: JSON.stringify({ file_name, events }),
    }),
  deleteEvent: (id: string) =>
    request<{ deleted: string }>(`/api/events/${encodeURIComponent(id)}`, { method: "DELETE", headers: adminHeaders() }),

  importTickets: (file: File, dryRun: boolean) => {
    const form = new FormData()
    form.append("file", file)
    form.append("dry_run", String(dryRun))
    return upload<TicketImportResult>("/api/imports/tickets", form)
  },
  uploadDocument: (file: File, title?: string, subcategory?: string) => {
    const form = new FormData()
    form.append("file", file)
    if (title) form.append("title", title)
    if (subcategory) form.append("subcategory", subcategory)
    return upload<DocumentUploadResult>("/api/imports/documents", form)
  },
  imports: () => request<ImportRecord[]>("/api/imports"),
  undoImport: (id: string) =>
    request<{ import_id: string; kind: string; removed: number }>(`/api/imports/${encodeURIComponent(id)}`,
                                                                   { method: "DELETE", headers: adminHeaders() }),

  ticketGraph: (n: string) => request<NetworkGraph>(`/api/graph/ticket/${encodeURIComponent(n)}`),
  eventGraph: (id: string) => request<NetworkGraph>(`/api/graph/event/${encodeURIComponent(id)}`),

  session: () => request<{ authenticated: boolean; auth_required: boolean }>("/api/auth/session"),
  login: (password: string) =>
    request<{ authenticated: boolean }>("/api/auth/login", { method: "POST", body: JSON.stringify({ password }) }),
  logout: () => request<{ authenticated: boolean }>("/api/auth/logout", { method: "POST" }),

  workspaces: () => request<{ current: string; items: Workspace[] }>("/api/workspaces"),
  createWorkspace: (name: string, template: WorkspaceTemplate) =>
    request<Workspace>("/api/workspaces", { method: "POST", body: JSON.stringify({ name, template }) }),
  selectWorkspace: (id: string) =>
    request<Workspace>(`/api/workspaces/${encodeURIComponent(id)}/select`, { method: "POST" }),
  deleteWorkspace: (id: string) =>
    request<{ deleted: string }>(`/api/workspaces/${encodeURIComponent(id)}`, { method: "DELETE", headers: adminHeaders() }),
}

// --- workspaces ---------------------------------------------------------------------------------

export type WorkspaceTemplate = "blank" | "knowledge"

export interface Workspace {
  id: string
  name: string
  template: WorkspaceTemplate | "demo"
  created_at: string
  tickets?: number
  articles?: number
}

// --- uploads (multipart; optional upload key) ----------------------------------------------------

const ADMIN_KEY = "techmate.uploadKey"

export function getUploadKey(): string {
  try { return sessionStorage.getItem(ADMIN_KEY) ?? "" } catch { return "" }
}

export function setUploadKey(key: string) {
  try { if (key) sessionStorage.setItem(ADMIN_KEY, key); else sessionStorage.removeItem(ADMIN_KEY) } catch { /* */ }
}

function adminHeaders(): Record<string, string> {
  const key = getUploadKey()
  return key ? { "X-Admin-Token": key } : {}
}

async function upload<T>(path: string, form: FormData): Promise<T> {
  // No Content-Type: the browser sets the multipart boundary itself.
  const res = await fetch(path, { method: "POST", body: form, headers: adminHeaders() })
  if (res.status === 401) toSignIn()
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`
    try {
      const body = await res.json()
      if (typeof body?.detail === "string") detail = body.detail
      else if (Array.isArray(body?.detail)) detail = body.detail.map((d: { msg: string }) => d.msg).join("; ")
    } catch { /* not JSON */ }
    throw new ApiError(res.status, detail)
  }
  return res.json() as Promise<T>
}

// --- operational events --------------------------------------------------------------------------

export type EventWhen = "all" | "active" | "upcoming" | "past"
export type EventType = "Planned maintenance" | "Power work" | "Network change" | "Software update" | "Service outage"
  | "Public holiday" | "Patch Tuesday" | "Other"

export interface OpsEvent {
  event_id: string
  title: string
  type: EventType
  start_at: string
  end_at: string
  status: "active" | "upcoming" | "past"
  all_locations: boolean
  locations: string[]
  subcategories: string[]
  services: string[] | null
  user_impact: string | null
  advice: string | null
  source: string
  import_id: string | null
  linked_tickets: number
  reason?: string
}

export interface OpsEventDetail extends OpsEvent {
  tickets: { number: string; short_description: string; state: TicketState; priority: Priority; subcategory: string;
             location: string | null; assignment_group: string; opened_at: string; reason: string }[]
  by_subcategory: { subcategory: string; count: number }[]
}

export interface EventDraft {
  title: string
  type: EventType
  start: string
  end: string
  all_locations: boolean
  locations: string[]
  subcategories: string[]
  services: string[]
  user_impact: string
  advice: string
  warnings?: string[]
}

// --- imports ------------------------------------------------------------------------------------

export interface TicketImportResult {
  rows_total: number
  rows_valid: number
  rows_invalid: number
  new_tickets: number
  replaced_tickets: number
  new_subcategories: string[]
  opened_from: string | null
  opened_to: string | null
  errors: { row: number; number: string | null; error: string }[]
  warnings: string[]
  dry_run: boolean
  preview: { number: string; short_description: string; priority: Priority; state: TicketState;
             assignment_group: string; opened_at: string; subcategory: string }[]
  import_id?: string
  entity_links?: number
  event_links?: number
}

export interface DocumentUploadResult {
  import_id: string
  kb_id: string
  title: string
  category: string
  subcategory: string
  summary: string | null
  pages: number
  chunks: number
  entities: number
  relations: number
  ticket_links: number
  extraction_failures: number
  file_stored: boolean
  seconds: number
}

export interface ImportRecord {
  import_id: string
  kind: "tickets" | "document" | "notice"
  file_name: string
  created_at: string
  rows?: number
  new_tickets?: number
  replaced_tickets?: number
  kb_id?: string
  title?: string
  events?: number
  linked_tickets?: number
}

// --- network graph -------------------------------------------------------------------------------

export type GraphNodeType = "ticket" | "event" | "context" | "classification" | "routing" | "outcome"

export interface GraphNode {
  id: string
  type: GraphNodeType
  kind: string
  label: string
  layer: number
  detail: string | null
  href: string | null
}

export interface GraphLink {
  source: string
  target: string
  label: string
  dashed: boolean
  detail: string | null
}

export interface NetworkGraph {
  focus: { kind: "ticket" | "event"; id: string; title: string; [key: string]: unknown }
  layers: string[]
  nodes: GraphNode[]
  links: GraphLink[]
}

/** Run one assistant turn, calling onEvent for every Server-Sent Event as it arrives. */
export async function streamChat(messages: ChatMessage[], onEvent: (e: ChatEvent) => void,
                                 signal?: AbortSignal): Promise<void> {
  const res = await fetch("/api/chat", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }), signal,
  })
  if (res.status === 401) toSignIn()
  if (!res.ok || !res.body) {
    let detail = `${res.status} ${res.statusText}`
    try {
      const body = await res.json()
      if (typeof body?.detail === "string") detail = body.detail
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, detail)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      if (frame.startsWith("data: ")) onEvent(JSON.parse(frame.slice(6)) as ChatEvent)
    }
  }
}

// --- analytics -----------------------------------------------------------------------------------

export interface Dashboard {
  generated_at: string
  period_days: number
  kpis: {
    open: number
    open_by_state: Record<string, number>
    open_by_priority: Record<string, number>
    open_past_sla: number
    created_today: number
    resolved_today: number
    created_period: number
    resolved_period: number
    sla_breach_rate: number | null
    first_contact_resolution_rate: number | null
    median_resolution_hours: number | null
    p90_resolution_hours: number | null
    reassignment_rate: number | null
  }
  trend: { date: string; created: number; resolved: number }[]
  by_category: { category: string; count: number }[]
  top_subcategories: { subcategory: string; count: number }[]
  by_group: { group: string; open: number; open_past_sla: number; created_period: number; resolved_period: number;
              median_resolution_hours: number | null; sla_breach_rate: number | null }[]
  by_channel: { channel: string; count: number }[]
  by_priority: { priority: string; count: number }[]
  heatmap: { weekday: number; hour: number; count: number }[]
  spikes: { subcategory: string; last_24h: number; typical: number; z_score: number }[]
  open_past_sla: { number: string; short_description: string; priority: Priority; group: string; hours_open: number }[]
  recent: { number: string; short_description: string; state: TicketState; priority: Priority; group: string;
            opened_at: string }[]
}

export interface ForecastPoint {
  date: string
  expected: number
  low: number
  high: number
  events: string[]
}

/** A workspace without enough history to forecast yet. */
export interface ForecastUnavailable {
  generated_at: string
  horizon_days: number
  insufficient_data: true
  history_days: number
  min_history_days: number
  tickets: number
}

export interface Forecast {
  insufficient_data?: false
  generated_at: string
  horizon_days: number
  operational_events: { event_id: string; title: string; type: string; start_at: string; end_at: string }[]
  history: { date: string; actual: number }[]
  forecast: ForecastPoint[]
  next_7_days_total: number
  last_7_days_total: number
  model: { type: string; alpha: number; beta: number; gamma: number; phi: number;
           calendar_factors: Record<string, number>; training_days: number }
  backtest: { holdout_days: number; wape_pct: number; weekly_total_error_pct: number | null; baseline_wape_pct: number;
              mae: number; improvement_vs_baseline_pct: number | null; actual_total: number; predicted_total: number;
              points: { date: string; actual: number; predicted: number }[] }
  by_category: { name: string; next_7_days: number; next_horizon: number; last_7_days: number }[]
  by_group: { name: string; next_7_days: number; next_horizon: number; last_7_days: number }[]
}

export interface KBArticle {
  kb_id: string
  title: string
  category: string
  subcategory: string
  pages: number
  file_name: string
  owner: string | null
  tickets_resolved: number
  file_url?: string | null
  source?: string | null
  summary?: string | null
}

export interface KBArticleDetail extends Omit<KBArticle, "tickets_resolved"> {
  tickets_resolved: number
  chunks: { idx: number; page: number; text: string }[]
  entities: { name: string; type: string; mentions: number }[]
}
