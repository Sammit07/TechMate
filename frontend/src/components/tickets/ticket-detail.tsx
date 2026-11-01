"use client"

import { ArrowLeft, BookOpen, CalendarClock, GitBranch, History, Loader2, Save, Waypoints } from "lucide-react"
import Link from "next/link"
import { useParams } from "next/navigation"
import { useEffect, useState } from "react"
import { toast } from "sonner"

import { PriorityBadge, SlaBadge, StateBadge } from "@/components/badges"
import { EventTypeBadge, eventWhere, formatWindow } from "@/components/events/event-meta"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { api, type FixPath, type SimilarTicket, type SourceChunk, type Ticket } from "@/lib/api"
import { formatDateTime, formatMinutes, kbPdfUrl } from "@/lib/format"

const STATES = ["New", "In Progress", "On Hold", "Resolved", "Closed"]
const PRIORITIES = ["1 - Critical", "2 - High", "3 - Moderate", "4 - Low"]

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="truncate text-sm">{children ?? "–"}</div>
    </div>
  )
}

export function TicketDetail() {
  const { number } = useParams<{ number: string }>()
  const [ticket, setTicket] = useState<Ticket | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [related, setRelated] = useState<{ chunks: SourceChunk[]; fix_paths: FixPath[]; similar_tickets: SimilarTicket[] } | null>(null)
  const [groups, setGroups] = useState<string[]>([])

  useEffect(() => {
    let cancelled = false
    api.ticket(number)
      .then((t) => { if (!cancelled) { setTicket(t); setError(null) } })
      .catch((e) => { if (!cancelled) setError((e as Error).message) })
    api.taxonomy().then((t) => setGroups(t.groups.map((g) => g.name))).catch(() => {})
    api.related(number).then(setRelated).catch(() => setRelated({ chunks: [], fix_paths: [], similar_tickets: [] }))
    return () => { cancelled = true }
  }, [number])

  if (error) {
    return (
      <Alert>
        <AlertTitle>Could not load {number}</AlertTitle>
        <AlertDescription>{error} <Link href="/tickets" className="underline">Back to tickets</Link></AlertDescription>
      </Alert>
    )
  }
  if (!ticket) return <div className="space-y-4"><Skeleton className="h-40 w-full" /><Skeleton className="h-72 w-full" /></div>

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-2">
        <Link href="/tickets" className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm">
          <ArrowLeft className="size-4" /> Tickets
        </Link>
        <Button asChild variant="outline" size="sm">
          <Link href={`/graph?ticket=${ticket.number}`}><Waypoints /> Network graph</Link>
        </Button>
      </div>

      {ticket.events && ticket.events.length > 0 && (
        <Alert>
          <CalendarClock className="size-4" style={{ color: "var(--node-event)" }} />
          <AlertTitle>Possibly affected by {ticket.events.length === 1 ? "an event" : `${ticket.events.length} events`}</AlertTitle>
          <AlertDescription>
            <ul className="mt-1 space-y-2">
              {ticket.events.map((e) => (
                <li key={e.event_id} className="space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <EventTypeBadge type={e.type} />
                    <Link href={`/events?focus=${e.event_id}`} className="text-foreground font-medium hover:underline">{e.title}</Link>
                  </div>
                  <div>{formatWindow(e.start_at, e.end_at)} · {eventWhere(e)}{e.reason ? ` · ticket ${e.reason}` : ""}</div>
                  {e.advice && <div>{e.advice}</div>}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardDescription className="font-mono">{ticket.number}</CardDescription>
          <CardTitle className="text-xl">{ticket.short_description}</CardTitle>
          <div className="flex flex-wrap gap-2 pt-1">
            <PriorityBadge priority={ticket.priority} />
            <StateBadge state={ticket.state} />
            <SlaBadge breached={ticket.sla_breached} />
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <p className="text-sm whitespace-pre-wrap">{ticket.description}</p>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-6">
            <Field label="Caller">{ticket.caller}</Field>
            <Field label="Service offering">{ticket.service_offering}</Field>
            <Field label="Location">{ticket.location}</Field>
            <Field label="Device">{ticket.device}</Field>
            <Field label="Subcategory">{ticket.subcategory ?? "Unclassified"}</Field>
            <Field label="Contact type">{ticket.contact_type}</Field>
            <Field label="Opened by">{ticket.opened_by}</Field>
            <Field label="Support group">{ticket.assignment_group}</Field>
            <Field label="Assigned to">{ticket.assigned_to}</Field>
            <Field label="Opened">{formatDateTime(ticket.opened_at)}</Field>
            <Field label="SLA target">{formatMinutes(ticket.sla_target_minutes)}</Field>
            <Field label="Resolved">{formatDateTime(ticket.resolved_at)}</Field>
            <Field label="Time to resolve">{formatMinutes(ticket.resolution_minutes)}</Field>
            <Field label="Updated">{formatDateTime(ticket.updated_at)}</Field>
          </div>
          {ticket.resolution_notes && (
            <div className="rounded-lg border p-3 text-sm">
              <div className="text-muted-foreground mb-1 text-xs">Resolution</div>
              {ticket.resolution_notes}
            </div>
          )}
          {ticket.kb_article && (
            <div className="flex items-center gap-2 text-sm">
              <BookOpen className="text-muted-foreground size-4" /> Resolved with{" "}
              <Link href={`/kb/${ticket.kb_article.kb_id}`} className="font-medium hover:underline">{ticket.kb_article.title}</Link>
            </div>
          )}
          {ticket.work_notes && (
            <details>
              <summary className="text-muted-foreground cursor-pointer text-sm">Work notes</summary>
              <pre className="bg-muted mt-2 rounded-md p-3 font-sans text-xs whitespace-pre-wrap">{ticket.work_notes}</pre>
            </details>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-5">
        <UpdatePanel key={`${ticket.number}:${ticket.updated_at ?? ""}`} ticket={ticket} groups={groups} onSaved={setTicket} />
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle className="text-base">Suggested fixes</CardTitle>
            <CardDescription>From the knowledge base and similar resolved tickets (GraphRAG)</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            {!related && <div className="text-muted-foreground flex items-center gap-2"><Loader2 className="size-4 animate-spin" /> Finding related knowledge…</div>}
            {related?.chunks.filter((c, i, all) => all.findIndex((x) => x.kb_id === c.kb_id) === i).map((c) => (
              <div key={c.kb_id} className="flex flex-wrap items-baseline gap-x-2">
                <BookOpen className="text-muted-foreground size-4 shrink-0 self-center" />
                <Link href={`/kb/${c.kb_id}`} className="font-medium hover:underline">{c.title}</Link>
                <span className="text-muted-foreground text-xs">p. {c.page}</span>
                <a href={kbPdfUrl(c.file_name, c.file_url)} target="_blank" rel="noopener noreferrer" className="text-muted-foreground text-xs underline">PDF</a>
              </div>
            ))}
            {related && related.fix_paths.length > 0 && (
              <div>
                <div className="text-muted-foreground mb-1 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide">
                  <GitBranch className="size-3.5" /> Known causes and fixes
                </div>
                <ul className="space-y-1">
                  {related.fix_paths.slice(0, 5).map((p, i) => (
                    <li key={i} className="text-muted-foreground"><span className="text-foreground">{p.cause}</span> → <span className="text-foreground font-medium">{p.fix}</span></li>
                  ))}
                </ul>
              </div>
            )}
            {related && related.similar_tickets.length > 0 && (
              <div>
                <div className="text-muted-foreground mb-1 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide">
                  <History className="size-3.5" /> Similar resolved tickets
                </div>
                <ul className="space-y-1">
                  {related.similar_tickets.slice(0, 5).map((t) => (
                    <li key={t.number}>
                      <Link href={`/tickets/${t.number}`} className="font-mono text-xs hover:underline">{t.number}</Link>{" "}
                      <span className="text-muted-foreground">{t.short_description}:</span> {t.resolution}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function UpdatePanel({ ticket, groups, onSaved }: { ticket: Ticket; groups: string[]; onSaved: (t: Ticket) => void }) {
  const [state, setState] = useState(ticket.state)
  const [priority, setPriority] = useState(ticket.priority)
  const [group, setGroup] = useState(ticket.assignment_group)
  const [assignee, setAssignee] = useState(ticket.assigned_to ?? "")
  const [note, setNote] = useState("")
  const [resolution, setResolution] = useState(ticket.resolution_notes ?? "")
  const [busy, setBusy] = useState(false)
  const resolving = (state === "Resolved" || state === "Closed") && ticket.active

  async function save(e: React.FormEvent) {
    e.preventDefault()
    const body: Record<string, string> = {}
    if (state !== ticket.state) body.state = state
    if (priority !== ticket.priority) body.priority = priority
    if (group !== ticket.assignment_group) body.assignment_group = group
    if (assignee.trim() && assignee.trim() !== (ticket.assigned_to ?? "")) body.assigned_to = assignee.trim()
    if (note.trim()) body.work_note = note.trim()
    if (resolution.trim() && resolution.trim() !== (ticket.resolution_notes ?? "")) body.resolution_notes = resolution.trim()
    if (!Object.keys(body).length) { toast.info("Nothing to save"); return }
    setBusy(true)
    try {
      const updated = await api.updateTicket(ticket.number, body)
      onSaved(updated)
      setNote("")
      toast.success(`${ticket.number} updated`)
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle className="text-base">Update ticket</CardTitle>
        <CardDescription>For service-desk agents</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>State</Label>
              <Select value={state} onValueChange={(v) => setState(v as Ticket["state"])}>
                <SelectTrigger className="w-full" aria-label="State"><SelectValue /></SelectTrigger>
                <SelectContent>{STATES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Priority</Label>
              <Select value={priority} onValueChange={(v) => setPriority(v as Ticket["priority"])}>
                <SelectTrigger className="w-full" aria-label="Priority"><SelectValue /></SelectTrigger>
                <SelectContent>{PRIORITIES.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Support group</Label>
            <Select value={group} onValueChange={setGroup}>
              <SelectTrigger className="w-full" aria-label="Support group"><SelectValue /></SelectTrigger>
              <SelectContent>{(groups.length ? groups : [group]).map((g) => <SelectItem key={g} value={g}>{g}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="assignee">Assigned to</Label>
            <Input id="assignee" value={assignee} onChange={(e) => setAssignee(e.target.value)} maxLength={80} placeholder="Agent name" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="note">Work note</Label>
            <Textarea id="note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={2000} placeholder="What you did or found" />
          </div>
          {(resolving || ticket.resolution_notes) && (
            <div className="space-y-1.5">
              <Label htmlFor="resolution">Resolution notes {resolving && <span className="text-muted-foreground">(required)</span>}</Label>
              <Textarea id="resolution" value={resolution} onChange={(e) => setResolution(e.target.value)} rows={2}
                        maxLength={2000} required={resolving} />
            </div>
          )}
          <Button type="submit" disabled={busy}>{busy ? <Loader2 className="animate-spin" /> : <Save />} Save changes</Button>
        </form>
      </CardContent>
    </Card>
  )
}
