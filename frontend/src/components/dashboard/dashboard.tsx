"use client"

import { AlertTriangle, CalendarClock, Pause, Play, RefreshCw } from "lucide-react"
import Link from "next/link"
import { useCallback, useEffect, useRef, useState } from "react"
import { Bar, BarChart, CartesianGrid, LabelList, Line, LineChart, XAxis, YAxis } from "recharts"

import { PriorityBadge, StateBadge } from "@/components/badges"
import { EventStatus, EventTypeBadge, eventWhere, formatWindow } from "@/components/events/event-meta"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { api, type Dashboard as DashboardData, type OpsEvent } from "@/lib/api"
import { formatDateTime, formatDay, formatHours, WEEKDAYS } from "@/lib/format"

const REFRESH_MS = 30_000

const trendConfig = {
  created: { label: "Created", color: "var(--series-1)" },
  resolved: { label: "Resolved", color: "var(--series-2)" },
} satisfies ChartConfig
const categoryConfig = { count: { label: "Tickets", color: "var(--series-1)" } } satisfies ChartConfig

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <Card className="gap-1 py-4">
      <CardHeader className="px-4">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-3xl font-semibold">{value}</CardTitle>
      </CardHeader>
      {hint && <CardContent className="text-muted-foreground px-4 text-xs">{hint}</CardContent>}
    </Card>
  )
}

export function Dashboard() {
  const [days, setDays] = useState(30)
  const [data, setData] = useState<DashboardData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [live, setLive] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [events, setEvents] = useState<OpsEvent[]>([])
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchAll = useCallback(async () => {
    const [dashboard, active, upcoming] = await Promise.all([api.dashboard(days), api.events("active"), api.events("upcoming")])
    // Events happening now or in the next two weeks (holidays included: they shape the workload).
    const soon = Date.now() + 14 * 86_400_000
    const shown = [...active, ...upcoming.filter((e) => new Date(e.start_at.replace(" ", "T")).getTime() <= soon)].slice(0, 6)
    return { dashboard, events: shown }
  }, [days])

  // Refresh button and the 30 s timer.
  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      const r = await fetchAll()
      setData(r.dashboard)
      setEvents(r.events)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRefreshing(false)
    }
  }, [fetchAll])

  useEffect(() => {
    let cancelled = false
    fetchAll()
      .then((r) => { if (!cancelled) { setData(r.dashboard); setEvents(r.events); setError(null) } })
      .catch((e) => { if (!cancelled) setError((e as Error).message) })
    return () => { cancelled = true }
  }, [fetchAll])
  useEffect(() => {
    if (!live) return
    timer.current = setInterval(() => { if (document.visibilityState === "visible") void refresh() }, REFRESH_MS)
    return () => { if (timer.current) clearInterval(timer.current) }
  }, [live, refresh])

  // Busy while refreshing, or while the data on screen is for the previously selected period.
  const loading = refreshing || (data !== null && data.period_days !== days)

  const k = data?.kpis
  // Refetch keeps the frame: previous data stays visible (dimmed) while reloading.
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Service-desk dashboard</h1>
          <p className="text-muted-foreground flex items-center gap-2 text-sm">
            {live && <span className="relative flex size-2"><span className="absolute inline-flex size-full animate-ping rounded-full opacity-60" style={{ background: "var(--status-good)" }} /><span className="relative inline-flex size-2 rounded-full" style={{ background: "var(--status-good)" }} /></span>}
            {data ? `Updated ${data.generated_at.slice(11, 19)}` : "Loading…"}{live ? " · refreshes every 30 s" : " · paused"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Tabs value={String(days)} onValueChange={(v) => setDays(Number(v))}>
            <TabsList>
              <TabsTrigger value="7">7 days</TabsTrigger>
              <TabsTrigger value="30">30 days</TabsTrigger>
              <TabsTrigger value="90">90 days</TabsTrigger>
            </TabsList>
          </Tabs>
          <Button variant="outline" size="icon" aria-label={live ? "Pause live updates" : "Resume live updates"} onClick={() => setLive(!live)}>
            {live ? <Pause /> : <Play />}
          </Button>
          <Button variant="outline" size="icon" aria-label="Refresh now" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw className={loading ? "animate-spin" : ""} />
          </Button>
        </div>
      </div>

      {error && <Alert><AlertTitle>Could not load the dashboard</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
      {!data && !error && <Skeleton className="h-[600px] w-full" />}

      {data && k && (
        <div className={`space-y-6 transition-opacity ${loading ? "opacity-70" : ""}`}>
          {data.spikes.length > 0 && (
            <Alert>
              <AlertTriangle className="size-4" style={{ color: "var(--status-serious)" }} />
              <AlertTitle>Possible incident{data.spikes.length > 1 ? "s" : ""}</AlertTitle>
              <AlertDescription>
                {data.spikes.map((s) => `${s.subcategory}: ${s.last_24h} tickets in the last 24 h (typically ${s.typical})`).join(" · ")}
              </AlertDescription>
            </Alert>
          )}

          {events.length > 0 && (
            <Card className="gap-3 py-4">
              <CardHeader className="px-4">
                <CardTitle className="flex items-center gap-2 text-base">
                  <CalendarClock className="size-4" style={{ color: "var(--node-event)" }} aria-hidden /> Events now and in the next 14 days
                </CardTitle>
              </CardHeader>
              <CardContent className="px-4">
                <ul className="divide-y text-sm">
                  {events.map((e) => (
                    <li key={e.event_id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 first:pt-0 last:pb-0">
                      <EventTypeBadge type={e.type} />
                      <Link href={`/events?focus=${e.event_id}`} className="font-medium hover:underline">{e.title}</Link>
                      <EventStatus status={e.status} />
                      <span className="text-muted-foreground">{formatWindow(e.start_at, e.end_at)} · {eventWhere(e)}</span>
                      {e.linked_tickets > 0 && <span className="text-muted-foreground">{e.linked_tickets} incidents linked</span>}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
            <Stat label="Open tickets" value={k.open} hint={<><strong className="text-foreground">{k.open_past_sla}</strong> past SLA</>} />
            <Stat label="Created today" value={k.created_today} hint={`${k.resolved_today} resolved today`} />
            <Stat label="SLA breached" value={k.sla_breach_rate != null ? `${k.sla_breach_rate}%` : "–"} hint={`of ${k.resolved_period} resolved, last ${days} days`} />
            <Stat label="First-contact resolution" value={k.first_contact_resolution_rate != null ? `${k.first_contact_resolution_rate}%` : "–"} hint="solved by the service desk directly" />
            <Stat label="Median time to resolve" value={formatHours(k.median_resolution_hours)} hint={`90% within ${formatHours(k.p90_resolution_hours)}`} />
            <Stat label="Reassigned" value={k.reassignment_rate != null ? `${k.reassignment_rate}%` : "–"} hint="of resolved tickets changed group" />
          </div>

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
            <Card className="xl:col-span-2">
              <CardHeader>
                <CardTitle className="text-base">Created vs resolved</CardTitle>
                <CardDescription>Tickets per day, last {days} days</CardDescription>
              </CardHeader>
              <CardContent>
                <ChartContainer config={trendConfig} className="h-72 w-full">
                  <LineChart data={data.trend} margin={{ left: 0, right: 12, top: 8 }}>
                    <CartesianGrid vertical={false} stroke="var(--grid-line)" />
                    <XAxis dataKey="date" tickLine={false} axisLine={false} minTickGap={24}
                           tickFormatter={(v: string) => formatDay(v, false)} tick={{ fill: "var(--muted-foreground)", fontSize: 12 }} />
                    <YAxis tickLine={false} axisLine={false} width={32} allowDecimals={false} tick={{ fill: "var(--muted-foreground)", fontSize: 12 }} />
                    <ChartTooltip cursor={{ stroke: "var(--border)" }}
                                  content={<ChartTooltipContent indicator="line" labelFormatter={(v) => formatDay(String(v))} />} />
                    <ChartLegend content={<ChartLegendContent />} />
                    <Line dataKey="created" type="monotone" stroke="var(--color-created)" strokeWidth={2} dot={false} isAnimationActive={false} />
                    <Line dataKey="resolved" type="monotone" stroke="var(--color-resolved)" strokeWidth={2} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ChartContainer>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Tickets by category</CardTitle>
                <CardDescription>Last {days} days</CardDescription>
              </CardHeader>
              <CardContent>
                <ChartContainer config={categoryConfig} className="w-full" style={{ height: Math.max(180, data.by_category.length * 34) }}>
                  <BarChart data={data.by_category} layout="vertical" margin={{ left: 0, right: 36 }}>
                    <XAxis type="number" hide />
                    <YAxis type="category" dataKey="category" width={150} tickLine={false} axisLine={false}
                           tick={{ fill: "var(--foreground)", fontSize: 12 }} />
                    <ChartTooltip cursor={{ fill: "var(--muted)", opacity: 0.5 }} content={<ChartTooltipContent hideIndicator />} />
                    <Bar dataKey="count" fill="var(--color-count)" barSize={18} radius={[0, 4, 4, 0]} isAnimationActive={false}>
                      <LabelList dataKey="count" position="right" className="fill-foreground" fontSize={12} />
                    </Bar>
                  </BarChart>
                </ChartContainer>
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
            <Card className="xl:col-span-2">
              <CardHeader>
                <CardTitle className="text-base">Support groups</CardTitle>
                <CardDescription>Workload and performance, last {days} days</CardDescription>
              </CardHeader>
              <CardContent className="px-0">
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="pl-6">Group</TableHead>
                        <TableHead className="text-right">Open</TableHead>
                        <TableHead className="text-right">Past SLA</TableHead>
                        <TableHead className="text-right">Created</TableHead>
                        <TableHead className="text-right">Median resolve</TableHead>
                        <TableHead className="pr-6 text-right">SLA breached</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody className="tabular-nums">
                      {data.by_group.map((g) => (
                        <TableRow key={g.group}>
                          <TableCell className="pl-6">
                            <Link href={`/tickets?state=open&group=${encodeURIComponent(g.group)}`} className="hover:underline">{g.group}</Link>
                          </TableCell>
                          <TableCell className="text-right">{g.open}</TableCell>
                          <TableCell className="text-right">{g.open_past_sla}</TableCell>
                          <TableCell className="text-right">{g.created_period}</TableCell>
                          <TableCell className="text-right">{formatHours(g.median_resolution_hours)}</TableCell>
                          <TableCell className="pr-6 text-right">{g.sla_breach_rate != null ? `${g.sla_breach_rate}%` : "–"}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Busiest hours</CardTitle>
                <CardDescription>Tickets opened by weekday and hour, last {days} days</CardDescription>
              </CardHeader>
              <CardContent><Heatmap cells={data.heatmap} /></CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <TicketListCard title="Open past SLA" description="Oldest first"
                            empty="No open tickets are past their SLA."
                            rows={data.open_past_sla.map((t) => ({ number: t.number, title: t.short_description,
                              right: <PriorityBadge priority={t.priority} />, meta: `${t.group} · open ${formatHours(t.hours_open)}` }))} />
            <TicketListCard title="Latest tickets" description="Newest first" empty="No tickets yet."
                            rows={data.recent.map((t) => ({ number: t.number, title: t.short_description,
                              right: <StateBadge state={t.state} />, meta: `${t.group} · ${formatDateTime(t.opened_at)}` }))} />
          </div>
        </div>
      )}
    </div>
  )
}

function TicketListCard({ title, description, rows, empty }: {
  title: string; description: string; empty: string
  rows: { number: string; title: string; right: React.ReactNode; meta: string }[]
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {rows.length === 0 && <p className="text-muted-foreground text-sm">{empty}</p>}
        {rows.map((r) => (
          <div key={r.number} className="flex items-start justify-between gap-3 text-sm">
            <div className="min-w-0">
              <Link href={`/tickets/${r.number}`} className="hover:underline"><span className="font-mono text-xs">{r.number}</span> {r.title}</Link>
              <div className="text-muted-foreground truncate text-xs">{r.meta}</div>
            </div>
            {r.right}
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

/** Weekday x hour heatmap: one hue, light -> dark (sequential); each cell has a hover title. */
function Heatmap({ cells }: { cells: DashboardData["heatmap"] }) {
  const hours = Array.from({ length: 13 }, (_, i) => i + 7) // 07:00-19:00, where almost all tickets are
  const max = Math.max(1, ...cells.map((c) => c.count))
  const step = (n: number) => (n === 0 ? 0 : Math.min(6, 1 + Math.floor((n / max) * 6)))
  const at = (wd: number, h: number) => cells.find((c) => c.weekday === wd && c.hour === h)?.count ?? 0
  return (
    <div className="space-y-2">
      <div className="grid gap-[2px]" style={{ gridTemplateColumns: `2.5rem repeat(${hours.length}, minmax(0, 1fr))` }}>
        <div />
        {hours.map((h) => <div key={h} className="text-muted-foreground text-center text-[10px] tabular-nums">{h % 3 === 1 ? h : ""}</div>)}
        {WEEKDAYS.map((name, wd) => (
          <div key={name} className="contents">
            <div className="text-muted-foreground self-center text-xs">{name}</div>
            {hours.map((h) => {
              const n = at(wd, h)
              return <div key={h} className="aspect-square rounded-[3px]" style={{ background: `var(--heat-${step(n)})` }}
                          title={`${name} ${String(h).padStart(2, "0")}:00 - ${n} ticket${n === 1 ? "" : "s"}`} />
            })}
          </div>
        ))}
      </div>
      <div className="text-muted-foreground flex items-center justify-end gap-1 text-[10px]">
        Fewer {[0, 2, 4, 6].map((s) => <span key={s} className="inline-block size-3 rounded-[2px]" style={{ background: `var(--heat-${s})` }} />)} More
      </div>
    </div>
  )
}
