"use client"

import { ChevronDown, Loader2, Plus, Trash2, Waypoints } from "lucide-react"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useEffect, useState } from "react"
import { toast } from "sonner"

import { StateBadge } from "@/components/badges"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { api, type EventWhen, type OpsEvent, type OpsEventDetail } from "@/lib/api"
import { formatDateTime } from "@/lib/format"
import { CALENDAR_TYPES, EventStatus, EventTypeBadge, eventWhere, formatWindow } from "./event-meta"
import { NoticeUploader } from "./notice-uploader"

const OPERATIONAL = ["Planned maintenance", "Power work", "Network change", "Software update", "Service outage", "Other"]

function EventTickets({ id }: { id: string }) {
  const [detail, setDetail] = useState<OpsEventDetail | null>(null)
  useEffect(() => { api.event(id).then(setDetail).catch(() => setDetail(null)) }, [id])
  if (!detail) return <div className="text-muted-foreground flex items-center gap-2 text-sm"><Loader2 className="size-4 animate-spin" /> Loading incidents…</div>
  if (!detail.tickets.length) return <p className="text-muted-foreground text-sm">No incidents linked yet. Tickets opened in the window will be linked as they arrive.</p>
  return (
    <div className="space-y-2">
      {detail.by_subcategory.length > 0 && (
        <div className="flex flex-wrap gap-1.5 text-xs">
          {detail.by_subcategory.map((s) => <Badge key={s.subcategory} variant="secondary" className="font-normal">{s.subcategory} · {s.count}</Badge>)}
        </div>
      )}
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-3">Ticket</TableHead><TableHead>Short description</TableHead><TableHead>Area</TableHead>
              <TableHead>Location</TableHead><TableHead>Opened</TableHead><TableHead>State</TableHead><TableHead className="pr-3">Why linked</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {detail.tickets.slice(0, 50).map((t) => (
              <TableRow key={t.number}>
                <TableCell className="pl-3 font-mono text-xs"><Link href={`/tickets/${t.number}`} className="underline">{t.number}</Link></TableCell>
                <TableCell className="max-w-64 truncate">{t.short_description}</TableCell>
                <TableCell className="text-muted-foreground whitespace-nowrap">{t.subcategory}</TableCell>
                <TableCell className="text-muted-foreground whitespace-nowrap">{t.location ?? "–"}</TableCell>
                <TableCell className="text-muted-foreground whitespace-nowrap tabular-nums">{formatDateTime(t.opened_at)}</TableCell>
                <TableCell><StateBadge state={t.state} /></TableCell>
                <TableCell className="text-muted-foreground pr-3 whitespace-nowrap">{t.reason}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {detail.tickets.length > 50 && <p className="text-muted-foreground text-xs">Showing 50 of {detail.linked_tickets}.</p>}
    </div>
  )
}

function EventCard({ e, open, onToggle, onDeleted }: { e: OpsEvent; open: boolean; onToggle: () => void; onDeleted: () => void }) {
  const deletable = e.source === "notice"
  async function remove() {
    if (!window.confirm(`Delete "${e.title}"? Its links to incidents are removed too.`)) return
    try {
      await api.deleteEvent(e.event_id)
      toast.success("Event deleted")
      onDeleted()
    } catch (err) {
      toast.error((err as Error).message)
    }
  }
  return (
    <Card id={e.event_id} className={`gap-3 py-4 ${open ? "ring-2 ring-[var(--node-event)]/40" : ""}`}>
      <CardContent className="space-y-3 px-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <EventTypeBadge type={e.type} />
              <EventStatus status={e.status} />
              <span className="text-muted-foreground font-mono text-xs">{e.event_id}</span>
            </div>
            <div className="font-medium">{e.title}</div>
            <div className="text-muted-foreground text-sm">{formatWindow(e.start_at, e.end_at)} · {eventWhere(e)}</div>
          </div>
          <div className="flex items-center gap-1">
            <Button asChild variant="ghost" size="sm" disabled={!e.linked_tickets}>
              <Link href={`/graph?event=${e.event_id}`}><Waypoints /> Graph</Link>
            </Button>
            {deletable && <Button variant="ghost" size="icon" aria-label="Delete event" onClick={remove}><Trash2 /></Button>}
          </div>
        </div>
        {(e.user_impact || e.advice) && (
          <p className="text-sm">{e.user_impact}{e.advice && <span className="text-muted-foreground"> {e.advice}</span>}</p>
        )}
        {e.subcategories.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {e.subcategories.map((s) => <Badge key={s} variant="secondary" className="font-normal">{s}</Badge>)}
          </div>
        )}
        <button onClick={onToggle} aria-expanded={open}
                className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm">
          <ChevronDown className={`size-4 transition-transform ${open ? "rotate-180" : ""}`} />
          <span className="text-foreground font-medium tabular-nums">{e.linked_tickets}</span> linked incident{e.linked_tickets === 1 ? "" : "s"}
        </button>
        {open && <EventTickets id={e.event_id} />}
      </CardContent>
    </Card>
  )
}

async function fetchEvents(when: EventWhen | "now", calendar: boolean, focus: string | null): Promise<OpsEvent[]> {
  const types = calendar ? undefined : OPERATIONAL
  let list = when === "now"
    ? [...await api.events("active", types), ...await api.events("upcoming", types)]
    : await api.events(when, types)
  // Opened from a graph or ticket link: show that event even if this tab wouldn't list it.
  if (focus && !list.some((x) => x.event_id === focus.toUpperCase())) {
    try { list = [await api.event(focus), ...list] } catch { /* unknown id: ignore */ }
  }
  return list
}

export function EventsPage() {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const focus = params.get("focus")
  const [when, setWhen] = useState<EventWhen | "now">("now")
  const [calendar, setCalendar] = useState(false)
  const [items, setItems] = useState<OpsEvent[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // undefined = not touched yet: the event from ?focus= starts open.
  const [openState, setOpen] = useState<string | null | undefined>(undefined)
  const open = openState === undefined ? (focus?.toUpperCase() ?? null) : openState
  const [adding, setAdding] = useState(false)

  // After a save or delete.
  async function load() {
    try {
      setItems(await fetchEvents(when, calendar, focus))
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  useEffect(() => {
    let cancelled = false
    fetchEvents(when, calendar, focus)
      .then((list) => { if (!cancelled) { setItems(list); setError(null) } })
      .catch((e) => { if (!cancelled) setError((e as Error).message) })
    return () => { cancelled = true }
  }, [when, calendar, focus])
  useEffect(() => {
    if (focus && items?.length) {
      requestAnimationFrame(() => document.getElementById(focus.toUpperCase())?.scrollIntoView({ block: "center" }))
    }
  }, [focus, items])

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Events</h1>
          <p className="text-muted-foreground text-sm">
            Maintenance, power work, network changes, updates and outages, and the incidents they caused.
          </p>
        </div>
        <Button onClick={() => setAdding(true)}><Plus /> Add notice</Button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Tabs value={when} onValueChange={(v) => { setWhen(v as EventWhen | "now"); setItems(null); if (focus) router.replace(pathname) }}>
          <TabsList>
            <TabsTrigger value="now">Now & upcoming</TabsTrigger>
            <TabsTrigger value="past">Past</TabsTrigger>
            <TabsTrigger value="all">All</TabsTrigger>
          </TabsList>
        </Tabs>
        <label className="text-muted-foreground inline-flex items-center gap-2 text-sm">
          <input type="checkbox" checked={calendar} onChange={(e) => { setCalendar(e.target.checked); setItems(null) }}
                 className="accent-[var(--series-1)]" />
          Include {CALENDAR_TYPES.join(" & ").toLowerCase()}s
        </label>
      </div>

      {error && <Alert><AlertTitle>Could not load events</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
      {!items && !error && <div className="space-y-3">{[...Array(4)].map((_, i) => <Skeleton key={i} className="h-28 w-full" />)}</div>}
      {items?.length === 0 && (
        <Card><CardContent className="text-muted-foreground py-10 text-center text-sm">
          No events here. Add a maintenance or power-work notice so incidents during it are linked and the assistant can tell users.
        </CardContent></Card>
      )}
      <div className="space-y-3">
        {items?.map((e) => (
          <EventCard key={e.event_id} e={e} open={open === e.event_id} onDeleted={load}
                     onToggle={() => setOpen(open === e.event_id ? null : e.event_id)} />
        ))}
      </div>

      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Add a notice</DialogTitle>
            <DialogDescription>
              Planned maintenance, electrical/power work, network changes, software rollouts or outages. The events
              are read from the notice for you to check before saving.
            </DialogDescription>
          </DialogHeader>
          <NoticeUploader onSaved={() => { setAdding(false); setWhen("all"); setItems(null); void load() }} />
        </DialogContent>
      </Dialog>
    </div>
  )
}
