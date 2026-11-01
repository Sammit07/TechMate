"use client"

import { CalendarClock, ChevronLeft, ChevronRight, Search } from "lucide-react"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useEffect, useState } from "react"

import { PriorityBadge, SlaBadge, StateBadge } from "@/components/badges"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { api, type TicketSummary } from "@/lib/api"
import { formatDateTime } from "@/lib/format"

const PAGE_SIZE = 25
const ALL = "__all"
const STATES = [["open", "Open"], ["closed", "Resolved & closed"], ["New", "New"], ["In Progress", "In progress"],
                ["On Hold", "On hold"], ["Resolved", "Resolved"], ["Closed", "Closed"]]
const PRIORITIES = ["1 - Critical", "2 - High", "3 - Moderate", "4 - Low"]

export function TicketList() {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const state = params.get("state") ?? "open"
  const group = params.get("group") ?? ""
  const priority = params.get("priority") ?? ""
  const q = params.get("q") ?? ""
  const page = Math.max(0, Number(params.get("page") ?? 0))

  type Page = { total: number; items: TicketSummary[] }
  const key = JSON.stringify([state, group, priority, q, page])
  const [result, setResult] = useState<{ key: string; data?: Page; error?: string } | null>(null)
  const current = result?.key === key ? result : null  // null while new filters load
  const data = current?.data ?? null
  const error = current?.error ?? null
  const [groups, setGroups] = useState<string[]>([])
  const [search, setSearch] = useState(q)

  useEffect(() => { api.taxonomy().then((t) => setGroups(t.groups.map((g) => g.name))).catch(() => {}) }, [])
  useEffect(() => {
    let cancelled = false
    api.tickets({ state: state === ALL ? undefined : state, group, priority, q, limit: PAGE_SIZE, offset: page * PAGE_SIZE })
      .then((d) => { if (!cancelled) setResult({ key, data: d }) })
      .catch((e) => { if (!cancelled) setResult({ key, error: (e as Error).message }) })
    return () => { cancelled = true }
  }, [key, state, group, priority, q, page])

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params.toString())
    if (value && value !== ALL) next.set(key, value); else next.delete(key)
    if (key !== "page") next.delete("page")
    router.replace(`${pathname}?${next}`)
  }

  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Tickets</h1>
        <p className="text-muted-foreground text-sm">Service-desk queue. Open a ticket to work on it.</p>
      </div>

      <div className="flex flex-wrap gap-2">
        <form onSubmit={(e) => { e.preventDefault(); setParam("q", search.trim()) }} className="relative min-w-56 flex-1">
          <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search tickets or INC number…"
                 className="pl-8" aria-label="Search tickets" maxLength={200} />
        </form>
        <Select value={state} onValueChange={(v) => setParam("state", v)}>
          <SelectTrigger className="w-44" aria-label="State"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All states</SelectItem>
            {STATES.map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={group || ALL} onValueChange={(v) => setParam("group", v)}>
          <SelectTrigger className="w-56" aria-label="Support group"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All support groups</SelectItem>
            {groups.map((g) => <SelectItem key={g} value={g}>{g}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={priority || ALL} onValueChange={(v) => setParam("priority", v)}>
          <SelectTrigger className="w-40" aria-label="Priority"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All priorities</SelectItem>
            {PRIORITIES.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <Card className="py-0">
        <CardContent className="px-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Ticket</TableHead>
                  <TableHead>Short description</TableHead>
                  <TableHead>Subcategory</TableHead>
                  <TableHead>Priority</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Group</TableHead>
                  <TableHead className="pr-4">Opened</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!data && !error && [...Array(8)].map((_, i) => (
                  <TableRow key={i}><TableCell colSpan={7} className="px-4"><Skeleton className="h-6 w-full" /></TableCell></TableRow>
                ))}
                {error && <TableRow><TableCell colSpan={7} className="px-4 py-8 text-center">{error}</TableCell></TableRow>}
                {data?.items.length === 0 && (
                  <TableRow><TableCell colSpan={7} className="text-muted-foreground px-4 py-8 text-center">No tickets match these filters.</TableCell></TableRow>
                )}
                {data?.items.map((t) => (
                  <TableRow key={t.number} className="cursor-pointer" onClick={() => router.push(`/tickets/${t.number}`)}>
                    <TableCell className="pl-4 font-mono text-xs">
                      <Link href={`/tickets/${t.number}`} onClick={(e) => e.stopPropagation()} className="hover:underline">{t.number}</Link>
                    </TableCell>
                    <TableCell className="max-w-80">
                      <div className="truncate">{t.short_description}</div>
                      {(t.sla_breached || (t.events && t.events.length > 0)) && (
                        <div className="mt-1 flex flex-wrap items-center gap-2">
                          {t.sla_breached && <SlaBadge breached />}
                          {t.events?.map((e) => (
                            <span key={e} className="text-muted-foreground inline-flex max-w-56 items-center gap-1 text-xs" title={`Linked event: ${e}`}>
                              <CalendarClock className="size-3 shrink-0" style={{ color: "var(--node-event)" }} aria-label="Linked event" />
                              <span className="truncate">{e}</span>
                            </span>
                          ))}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground whitespace-nowrap">{t.subcategory ?? "Unclassified"}</TableCell>
                    <TableCell><PriorityBadge priority={t.priority} /></TableCell>
                    <TableCell><StateBadge state={t.state} /></TableCell>
                    <TableCell className="whitespace-nowrap">{t.assignment_group}</TableCell>
                    <TableCell className="text-muted-foreground pr-4 whitespace-nowrap tabular-nums">{formatDateTime(t.opened_at)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {data && data.total > 0 && (
        <div className="text-muted-foreground flex items-center justify-between text-sm">
          <span className="tabular-nums">{page * PAGE_SIZE + 1}–{Math.min(data.total, (page + 1) * PAGE_SIZE)} of {data.total.toLocaleString()}</span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setParam("page", String(page - 1))}>
              <ChevronLeft /> Previous
            </Button>
            <Button variant="outline" size="sm" disabled={page + 1 >= pages} onClick={() => setParam("page", String(page + 1))}>
              Next <ChevronRight />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
