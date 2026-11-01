"use client"

import { ArrowDownRight, ArrowRight, ArrowUpRight, CalendarDays } from "lucide-react"
import Link from "next/link"
import { useEffect, useMemo, useState } from "react"
import { Area, CartesianGrid, ComposedChart, Line, LineChart, ReferenceLine, XAxis, YAxis } from "recharts"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, type ChartConfig } from "@/components/ui/chart"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { api, type Forecast as ForecastData, type ForecastUnavailable } from "@/lib/api"
import { formatDay } from "@/lib/format"

const HISTORY_DAYS = 42

const forecastConfig = {
  actual: { label: "Actual", color: "var(--series-1)" },
  expected: { label: "Forecast", color: "var(--series-2)" },
  band: { label: "80% range", color: "var(--series-2)" },
} satisfies ChartConfig
const backtestConfig = {
  actual: { label: "Actual", color: "var(--series-1)" },
  predicted: { label: "Predicted", color: "var(--series-2)" },
} satisfies ChartConfig

const tick = { fill: "var(--muted-foreground)", fontSize: 12 }

type Row = { date: string; actual?: number; expected?: number; band?: [number, number]; events?: string[] }

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

function Change({ from, to }: { from: number; to: number }) {
  if (!from) return <span className="text-muted-foreground">–</span>
  const pct = Math.round(((to - from) / from) * 100)
  const Icon = pct > 2 ? ArrowUpRight : pct < -2 ? ArrowDownRight : ArrowRight
  return (
    <span className="inline-flex items-center gap-0.5 tabular-nums">
      <Icon className="text-muted-foreground size-3.5" aria-hidden />{pct > 0 ? "+" : ""}{pct}%
    </span>
  )
}

function ForecastTooltip({ active, payload }: { active?: boolean; payload?: { payload: Row }[] }) {
  const row = payload?.[0]?.payload
  if (!active || !row) return null
  return (
    <div className="bg-background grid min-w-40 gap-1 rounded-lg border px-2.5 py-1.5 text-xs shadow-xl">
      <div className="font-medium">{formatDay(row.date)}</div>
      {row.actual != null && (
        <div className="flex items-center gap-2">
          <span className="size-2.5 rounded-[2px]" style={{ background: "var(--series-1)" }} />Actual
          <span className="ml-auto font-mono font-medium tabular-nums">{row.actual}</span>
        </div>
      )}
      {row.expected != null && row.band && (
        <div className="flex items-center gap-2">
          <span className="size-2.5 rounded-[2px]" style={{ background: "var(--series-2)" }} />Forecast
          <span className="ml-auto font-mono font-medium tabular-nums">{Math.round(row.expected)}</span>
        </div>
      )}
      {row.band && row.actual == null && (
        <div className="text-muted-foreground">likely {Math.round(row.band[0])}–{Math.round(row.band[1])}</div>
      )}
      {row.events?.map((e) => <div key={e} className="text-muted-foreground">{e}</div>)}
    </div>
  )
}

function BreakdownTable({ title, rows, horizon }: { title: string; rows: ForecastData["by_group"]; horizon: number }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>Expected tickets compared with the last 7 days</CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">Name</TableHead>
                <TableHead className="text-right">Last 7 days</TableHead>
                <TableHead className="text-right">Next 7 days</TableHead>
                <TableHead className="text-right">Change</TableHead>
                <TableHead className="pr-6 text-right">Next {horizon} days</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.name}>
                  <TableCell className="pl-6 whitespace-nowrap">{r.name}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.last_7_days}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{Math.round(r.next_7_days)}</TableCell>
                  <TableCell className="text-right"><Change from={r.last_7_days} to={r.next_7_days} /></TableCell>
                  <TableCell className="pr-6 text-right tabular-nums">{Math.round(r.next_horizon)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  )
}

export function Forecast() {
  const [horizon, setHorizon] = useState(14)
  const [data, setData] = useState<ForecastData | null>(null)
  const [unavailable, setUnavailable] = useState<ForecastUnavailable | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api.forecast(horizon)
      .then((d) => {
        if (cancelled) return
        if (d.insufficient_data) { setUnavailable(d); setData(null) } else { setData(d); setUnavailable(null) }
        setError(null)
      })
      .catch((e) => { if (!cancelled) setError((e as Error).message) })
    return () => { cancelled = true }
  }, [horizon])
  // Busy while the forecast on screen is for the previously selected horizon.
  const shownHorizon = data?.horizon_days ?? unavailable?.horizon_days
  const loading = shownHorizon !== undefined && shownHorizon !== horizon

  const rows = useMemo<Row[]>(() => {
    if (!data) return []
    const history: Row[] = data.history.slice(-HISTORY_DAYS).map((h) => ({ date: h.date, actual: h.actual }))
    // Start the forecast line at the last actual value so the two lines join.
    const last = history.at(-1)
    if (last?.actual != null) Object.assign(last, { expected: last.actual, band: [last.actual, last.actual] })
    return [...history, ...data.forecast.map((f) => ({ date: f.date, expected: f.expected, band: [f.low, f.high] as [number, number], events: f.events }))]
  }, [data])

  const events = data?.forecast.filter((f) => f.events.length) ?? []
  const bt = data?.backtest

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Ticket forecast</h1>
          <p className="text-muted-foreground text-sm">How many tickets to expect, so the desk can plan staffing.</p>
        </div>
        <Tabs value={String(horizon)} onValueChange={(v) => setHorizon(Number(v))}>
          <TabsList>
            <TabsTrigger value="14">14 days</TabsTrigger>
            <TabsTrigger value="28">28 days</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {error && <Alert><AlertTitle>Could not load the forecast</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
      {unavailable && (
        <Card>
          <CardContent className="space-y-2 py-8 text-center">
            <p className="font-medium">Not enough ticket history to forecast yet</p>
            <p className="text-muted-foreground text-sm">
              This workspace has {unavailable.history_days} day{unavailable.history_days === 1 ? "" : "s"} of tickets;
              the forecast needs at least {unavailable.min_history_days} (8 weeks) to learn the weekly pattern and test itself.
            </p>
            <Link href="/data" className="text-sm underline">Upload your ticket history</Link>
          </CardContent>
        </Card>
      )}
      {!data && !error && !unavailable && <Skeleton className="h-[600px] w-full" />}

      {data && bt && (
        <div className={`space-y-6 transition-opacity ${loading ? "opacity-70" : ""}`}>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label="Next 7 days" value={Math.round(data.next_7_days_total)}
                  hint={<>last 7 days: {data.last_7_days_total} (<Change from={data.last_7_days_total} to={data.next_7_days_total} />)</>} />
            <Stat label={`Next ${horizon} days`} value={Math.round(data.forecast.reduce((s, f) => s + f.expected, 0))}
                  hint={`busiest: ${formatDay(data.forecast.reduce((a, b) => (b.expected > a.expected ? b : a)).date)}`} />
            <Stat label="Weekly total error" value={bt.weekly_total_error_pct != null ? `${bt.weekly_total_error_pct}%` : "–"}
                  hint={`backtest on the last ${bt.holdout_days} days`} />
            <Stat label="Daily error (WAPE)" value={`${bt.wape_pct}%`}
                  hint={bt.improvement_vs_baseline_pct != null ? `${bt.improvement_vs_baseline_pct}% better than "same day last week"` : undefined} />
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Tickets per day</CardTitle>
              <CardDescription>Last {HISTORY_DAYS} days and the next {horizon}; shaded area is the 80% range, dotted lines mark calendar events</CardDescription>
            </CardHeader>
            <CardContent>
              <ChartContainer config={forecastConfig} className="h-80 w-full">
                <ComposedChart data={rows} margin={{ left: 0, right: 12, top: 20 }}>
                  <CartesianGrid vertical={false} stroke="var(--grid-line)" />
                  <XAxis dataKey="date" tickLine={false} axisLine={false} minTickGap={28}
                         tickFormatter={(v: string) => formatDay(v, false)} tick={tick} />
                  <YAxis tickLine={false} axisLine={false} width={32} allowDecimals={false} tick={tick} />
                  {events.map((e) => (
                    <ReferenceLine key={e.date} x={e.date} stroke="var(--muted-foreground)" strokeOpacity={0.5} strokeDasharray="3 3" />
                  ))}
                  <ChartTooltip cursor={{ stroke: "var(--border)" }} content={<ForecastTooltip />} />
                  <ChartLegend content={<ChartLegendContent />} />
                  <Area dataKey="band" type="monotone" stroke="none" fill="var(--color-band)" fillOpacity={0.18}
                        isAnimationActive={false} legendType="none" />
                  <Line dataKey="actual" type="monotone" stroke="var(--color-actual)" strokeWidth={2} dot={false} isAnimationActive={false} />
                  <Line dataKey="expected" type="monotone" stroke="var(--color-expected)" strokeWidth={2} strokeDasharray="5 4"
                        dot={false} isAnimationActive={false} />
                </ComposedChart>
              </ChartContainer>
              {events.length > 0 && (
                <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
                  <CalendarDays className="text-muted-foreground size-4" aria-hidden />
                  {events.map((e) => (
                    <Badge key={e.date} variant="outline">{formatDay(e.date)}: {e.events.join(", ")}</Badge>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
            <BreakdownTable title="By category" rows={data.by_category} horizon={horizon} />
            <BreakdownTable title="By support group" rows={data.by_group} horizon={horizon} />
          </div>

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
            <Card className="xl:col-span-2">
              <CardHeader>
                <CardTitle className="text-base">How accurate is it?</CardTitle>
                <CardDescription>
                  Model trained without the last {bt.holdout_days} days, then compared with what happened:
                  {" "}{Math.round(bt.predicted_total)} predicted vs {bt.actual_total} actual tickets
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ChartContainer config={backtestConfig} className="h-64 w-full">
                  <LineChart data={bt.points} margin={{ left: 0, right: 12, top: 8 }}>
                    <CartesianGrid vertical={false} stroke="var(--grid-line)" />
                    <XAxis dataKey="date" tickLine={false} axisLine={false} minTickGap={28}
                           tickFormatter={(v: string) => formatDay(v, false)} tick={tick} />
                    <YAxis tickLine={false} axisLine={false} width={32} allowDecimals={false} tick={tick} />
                    <ChartTooltip cursor={{ stroke: "var(--border)" }} content={<BacktestTooltip />} />
                    <ChartLegend content={<ChartLegendContent />} />
                    <Line dataKey="actual" type="monotone" stroke="var(--color-actual)" strokeWidth={2} dot={false} isAnimationActive={false} />
                    <Line dataKey="predicted" type="monotone" stroke="var(--color-predicted)" strokeWidth={2} strokeDasharray="5 4"
                          dot={false} isAnimationActive={false} />
                  </LineChart>
                </ChartContainer>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">About the model</CardTitle>
                <CardDescription>{data.model.type}</CardDescription>
              </CardHeader>
              <CardContent className="text-muted-foreground space-y-3 text-sm">
                <p>Learns the weekly rhythm (Mondays busiest, weekends quiet) and the overall trend from {data.model.training_days} days of tickets.</p>
                <ul className="space-y-1">
                  <li>Public holidays: <span className="text-foreground tabular-nums">×{data.model.calendar_factors.holiday}</span> of a normal day</li>
                  <li>Day after Patch Tuesday: <span className="text-foreground tabular-nums">×{data.model.calendar_factors.patch_1}</span></li>
                  <li>Two days after: <span className="text-foreground tabular-nums">×{data.model.calendar_factors.patch_2}</span></li>
                </ul>
                <p>Daily numbers are noisy; weekly totals are more reliable (about {bt.weekly_total_error_pct ?? "–"}% off in testing).</p>
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </div>
  )
}

function BacktestTooltip({ active, payload }: { active?: boolean; payload?: { payload: { date: string; actual: number; predicted: number } }[] }) {
  const row = payload?.[0]?.payload
  if (!active || !row) return null
  return (
    <div className="bg-background grid min-w-36 gap-1 rounded-lg border px-2.5 py-1.5 text-xs shadow-xl">
      <div className="font-medium">{formatDay(row.date)}</div>
      {([["Actual", row.actual, "var(--series-1)"], ["Predicted", Math.round(row.predicted), "var(--series-2)"]] as const).map(([l, v, c]) => (
        <div key={l} className="flex items-center gap-2">
          <span className="size-2.5 rounded-[2px]" style={{ background: c }} />{l}
          <span className="ml-auto font-mono font-medium tabular-nums">{v}</span>
        </div>
      ))}
    </div>
  )
}
