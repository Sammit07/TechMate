"use client"

import { ArrowRight, Loader2, Search } from "lucide-react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { useEffect, useMemo, useState } from "react"

import { PriorityBadge, StateBadge } from "@/components/badges"
import { EventStatus, EventTypeBadge, formatWindow } from "@/components/events/event-meta"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { api, type EventType, type GraphNode, type NetworkGraph, type OpsEvent, type Priority, type TicketState } from "@/lib/api"
import { formatDay } from "@/lib/format"
import { GraphLegend, NetworkGraphView } from "./network-graph"

export function GraphExplorer() {
  const router = useRouter()
  const params = useSearchParams()
  const ticket = params.get("ticket")?.toUpperCase() ?? null
  const eventId = params.get("event")?.toUpperCase() ?? null

  const [graph, setGraph] = useState<NetworkGraph | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<GraphNode | null>(null)
  const [events, setEvents] = useState<OpsEvent[]>([])
  const [search, setSearch] = useState(ticket ?? "")

  useEffect(() => {
    api.events("all").then((list) => {
      const withLinks = list.filter((e) => e.linked_tickets > 0)
      setEvents(withLinks)
      // Nothing chosen yet: start from the most recent operational event that affected incidents.
      if (!ticket && !eventId) {
        const start = withLinks.find((e) => e.type !== "Public holiday" && e.type !== "Patch Tuesday") ?? withLinks[0]
        if (start) router.replace(`/graph?event=${start.event_id}`)
      }
    }).catch(() => setEvents([]))
  }, [ticket, eventId, router])

  useEffect(() => {
    if (!ticket && !eventId) return
    let cancelled = false
    ;(ticket ? api.ticketGraph(ticket) : api.eventGraph(eventId!))
      .then((g) => {
        if (cancelled) return
        setGraph(g)
        setSelected(null)
        setSearch(ticket ?? "")
        setError(null)
      })
      .catch((e) => { if (!cancelled) setError((e as Error).message) })
    return () => { cancelled = true }
  }, [ticket, eventId])
  // Busy while the graph on screen isn't the one the URL asks for.
  const requested = ticket ? `ticket:${ticket}` : eventId ? `event:${eventId}` : null
  const loading = Boolean(graph && requested && requested !== `${graph.focus.kind}:${graph.focus.id}`)

  const connections = useMemo(() => {
    if (!graph || !selected) return []
    const byId = new Map(graph.nodes.map((n) => [n.id, n]))
    return graph.links.filter((l) => l.source === selected.id || l.target === selected.id).map((l) => ({
      ...l, outgoing: l.source === selected.id, other: byId.get(l.source === selected.id ? l.target : l.source)!,
    }))
  }, [graph, selected])

  const focus = graph?.focus
  // Where the selected node's button goes. A link to the graph already on screen would do nothing,
  // so the event in its own graph opens its event page instead.
  const nodeAction = useMemo(() => {
    if (!selected?.href || !focus) return null
    if (selected.href === `/graph?${focus.kind}=${focus.id}`) {
      return focus.kind === "event" ? { href: `/events?focus=${focus.id}`, label: "Event details" } : null
    }
    return { href: selected.href, label: selected.href.startsWith("/graph") ? "Show its graph" : "Open" }
  }, [selected, focus])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Network graph</h1>
        <p className="text-muted-foreground text-sm">
          How a ticket was raised, routed and resolved, and what affected it: maintenance, outages, updates, holidays.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <form onSubmit={(e) => { e.preventDefault(); if (search.trim()) router.push(`/graph?ticket=${search.trim().toUpperCase()}`) }}
              className="flex min-w-64 flex-1 gap-2">
          <div className="relative flex-1">
            <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Ticket number, e.g. INC2005975"
                   className="pl-8 font-mono" aria-label="Ticket number" maxLength={12} />
          </div>
          <Button type="submit" variant="secondary">Show ticket</Button>
        </form>
        <Select value={eventId ?? ""} onValueChange={(v) => router.push(`/graph?event=${v}`)}>
          <SelectTrigger className="w-full sm:w-96" aria-label="Event"><SelectValue placeholder="…or pick an event" /></SelectTrigger>
          <SelectContent>
            {events.map((e) => (
              <SelectItem key={e.event_id} value={e.event_id}>
                {e.title} · {formatDay(e.start_at.slice(0, 10), false)} · {e.linked_tickets} incidents
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {error && <Alert><AlertTitle>Could not load the graph</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
      {!graph && !error && <Skeleton className="h-[480px] w-full" />}

      {graph && focus && (
        <div className={`space-y-4 transition-opacity ${loading ? "opacity-60" : ""}`}>
          <Card className="gap-3 py-4">
            <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 text-sm">
              {focus.kind === "ticket" ? (
                <>
                  <Link href={`/tickets/${focus.id}`} className="font-mono font-medium underline">{focus.id}</Link>
                  <span className="font-medium">{focus.title}</span>
                  <StateBadge state={focus.state as TicketState} />
                  <PriorityBadge priority={focus.priority as Priority} />
                  <span className="text-muted-foreground">Owner: <span className="text-foreground">{String(focus.assignment_group)}</span></span>
                  <span className="text-muted-foreground">Reassigned {String(focus.reassignments)}×</span>
                  <span className="text-muted-foreground">{String(focus.events)} linked event{focus.events === 1 ? "" : "s"}</span>
                </>
              ) : (
                <>
                  <EventTypeBadge type={focus.type as EventType} />
                  <span className="font-medium">{focus.title}</span>
                  <EventStatus status={focus.status as OpsEvent["status"]} />
                  <span className="text-muted-foreground">{formatWindow(String(focus.start_at), String(focus.end_at))}</span>
                  <span className="text-muted-foreground">
                    {String(focus.linked_tickets)} linked incidents
                    {Number(focus.linked_tickets) > Number(focus.shown_tickets) && ` (first ${String(focus.shown_tickets)} shown)`}
                  </span>
                  <Link href={`/events?focus=${focus.id}`} className="text-muted-foreground underline">Event details</Link>
                </>
              )}
              {loading && <Loader2 className="text-muted-foreground size-4 animate-spin" />}
            </CardContent>
          </Card>

          {/* Full width for the graph (labels need the room); details for the clicked node underneath. */}
          <Card className="min-w-0 gap-3 py-3">
            <CardContent className="space-y-3 px-3">
              <NetworkGraphView graph={graph} selected={selected?.id ?? null} onSelect={setSelected} />
              <div className="flex flex-wrap items-center justify-between gap-2 px-1">
                <GraphLegend />
                <span className="text-muted-foreground text-xs">Hover a node to trace its links · click for details</span>
              </div>
            </CardContent>
          </Card>

          {selected ? (
            <Card className="gap-3 py-4">
              <CardHeader className="px-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <CardDescription>{selected.kind}</CardDescription>
                    <CardTitle className="text-base">{selected.label}</CardTitle>
                  </div>
                  {nodeAction && (
                    <Button asChild size="sm" variant="outline">
                      <Link href={nodeAction.href}>{nodeAction.label} <ArrowRight /></Link>
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent className="grid grid-cols-1 gap-4 px-4 text-sm md:grid-cols-2">
                {selected.detail && <p className="text-muted-foreground">{selected.detail}</p>}
                {connections.length > 0 && (
                  <ul className="space-y-1.5">
                    {connections.map((c) => (
                      <li key={`${c.source}-${c.target}`} className="text-muted-foreground">
                        {c.outgoing ? <>{c.label} <span className="text-foreground">{c.other.label}</span></>
                          : <><span className="text-foreground">{c.other.label}</span> {c.label} this</>}
                        {c.detail && <span className="text-xs"> ({c.detail})</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          ) : (
            <p className="text-muted-foreground px-1 text-sm">
              {focus.kind === "ticket"
                ? "Left to right: who raised it and what affected it, the ticket, how it was classified, how it was routed between support groups, and how it ended."
                : "Left to right: where the event happened and which ticket areas it hit, the event, the incidents linked to it, the groups that handled them, and how they ended."}
              {" "}Click any node for details.
            </p>
          )}

          <details className="rounded-lg border text-sm">
            <summary className="text-muted-foreground cursor-pointer px-3 py-2">Connections as a list ({graph.links.length})</summary>
            <ul className="space-y-1 border-t px-3 py-2">
              {graph.links.map((l) => {
                const name = (id: string) => graph.nodes.find((n) => n.id === id)?.label ?? id
                return <li key={`${l.source}-${l.target}`}>{name(l.source)} <span className="text-muted-foreground">{l.label}</span> {name(l.target)}{l.detail ? ` (${l.detail})` : ""}</li>
              })}
            </ul>
          </details>
        </div>
      )}
    </div>
  )
}
