"use client"

import {
  AlertTriangle, Building2, CalendarClock, CheckCircle2, Download, FileSpreadsheet, FileText, FileUp, KeyRound, Loader2,
  Trash2, Undo2,
} from "lucide-react"
import Link from "next/link"
import { useCallback, useEffect, useState, useSyncExternalStore } from "react"
import { toast } from "sonner"

import { NoticeUploader } from "@/components/events/notice-uploader"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  api, getUploadKey, setUploadKey, type DocumentUploadResult, type ImportRecord, type TicketImportResult,
  type Workspace,
} from "@/lib/api"
import { formatDateTime } from "@/lib/format"

const CSV_COLUMNS = ["Number", "User", "Location", "Service offering", "CMDB CI", "Category", "Reporting category",
  "Reporting category 2", "Assignment group", "Priority", "State", "Short description", "Description", "Assigned to",
  "Opened at", "System updated on", "Opened by", "Work notes", "Close code", "Close notes", "Resolved by",
  "Calendar duration", "Comments", "Reassignment count", "Active", "Resolved at", "Closed at", "Category item", "Contact type"]
const CSV_EXAMPLE = ["INC1001001", "Varun Pillai", "Pune - Hinjewadi", "Network Services", "VPN Gateway", "Network", "Network",
  "VPN", "Network Support", "3 - Moderate", "Closed", "VPN authentication failed", "Cannot connect to VPN from home.",
  "Gaurav Sethi", "2026-04-05 09:01:36", "2026-04-09 08:41:30", "Gaurav Sethi", "Re-issued VPN certificate.",
  "Solved Remotely (Permanently)", "Re-issued expired VPN certificate. User connected.", "Gaurav Sethi", "3600",
  "Thanks, it is working now.", "0", "false", "2026-04-05 10:01:36", "2026-04-08 10:01:36", "VPN connectivity", "Phone"]

function templateHref() {
  const quote = (v: string) => (/[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
  const csv = `${CSV_COLUMNS.join(",")}\n${CSV_EXAMPLE.map(quote).join(",")}\n`
  return `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`
}

function FilePick({ accept, file, onFile, label }: { accept: string; file: File | null; onFile: (f: File | null) => void; label: string }) {
  return (
    <label className="hover:bg-muted flex cursor-pointer items-center gap-2 rounded-md border border-dashed px-3 py-3 text-sm">
      <FileUp className="text-muted-foreground size-4 shrink-0" />
      <span className={file ? "truncate" : "text-muted-foreground"}>{file ? `${file.name} · ${(file.size / 1024).toFixed(0)} KB` : label}</span>
      <input type="file" accept={accept} className="sr-only" onChange={(e) => onFile(e.target.files?.[0] ?? null)} />
    </label>
  )
}

const noSubscribe = () => () => {}

function UploadKeyCard() {
  // Saved key from sessionStorage ("" during server rendering); typing overrides it.
  const saved = useSyncExternalStore(noSubscribe, getUploadKey, () => "")
  const [draft, setKey] = useState<string | null>(null)
  const key = draft ?? saved
  return (
    <Card className="gap-3 py-4">
      <CardContent className="flex flex-wrap items-end gap-3 px-4">
        <div className="min-w-56 flex-1 space-y-1.5">
          <Label htmlFor="upload-key" className="flex items-center gap-1.5"><KeyRound className="size-3.5" /> Upload key</Label>
          <Input id="upload-key" type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off"
                 placeholder="Only needed if your administrator set one (ADMIN_TOKEN)" />
        </div>
        <Button variant="outline" onClick={() => { setUploadKey(key.trim()); toast.success(key.trim() ? "Upload key saved for this tab" : "Upload key cleared") }}>
          Save key
        </Button>
      </CardContent>
    </Card>
  )
}

function TicketImport({ onDone }: { onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [check, setCheck] = useState<TicketImportResult | null>(null)
  const [busy, setBusy] = useState<"check" | "import" | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function run(dryRun: boolean) {
    if (!file) return
    setBusy(dryRun ? "check" : "import")
    setError(null)
    try {
      const res = await api.importTickets(file, dryRun)
      if (dryRun) setCheck(res)
      else {
        toast.success(`Imported ${res.rows_valid} tickets`, {
          description: `${res.new_tickets} new, ${res.replaced_tickets} updated · ${res.event_links ?? 0} linked to events`,
        })
        setCheck(null)
        setFile(null)
        onDone()
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><FileSpreadsheet className="size-4" /> Tickets (CSV)</CardTitle>
        <CardDescription>
          ServiceNow incident export with the standard columns (Number, User, Location, … Category item, Contact type).
          Existing ticket numbers are updated. <a href={templateHref()} download="ticket-import-template.csv" className="underline">
          <Download className="inline size-3.5" /> Template</a>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <FilePick accept=".csv" file={file} onFile={(f) => { setFile(f); setCheck(null); setError(null) }} label="Choose a CSV file (max 4 MB)" />
        {error && <p className="text-sm" style={{ color: "var(--status-critical)" }}>{error}</p>}
        {check && (
          <div className="space-y-3 rounded-md border p-3 text-sm">
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <span><strong className="tabular-nums">{check.rows_valid}</strong> valid rows</span>
              <span><strong className="tabular-nums">{check.new_tickets}</strong> new</span>
              <span><strong className="tabular-nums">{check.replaced_tickets}</strong> update existing</span>
              {check.rows_invalid > 0 && (
                <span className="inline-flex items-center gap-1"><AlertTriangle className="size-3.5" style={{ color: "var(--status-warning)" }} />
                  <strong className="tabular-nums">{check.rows_invalid}</strong> invalid (skipped)</span>
              )}
              {check.opened_from && <span className="text-muted-foreground">opened {formatDateTime(check.opened_from)} – {formatDateTime(check.opened_to)}</span>}
            </div>
            {check.new_subcategories.length > 0 && (
              <p className="text-muted-foreground">New ticket areas will be added: {check.new_subcategories.join(", ")}</p>
            )}
            {check.warnings.map((w) => <p key={w} className="text-muted-foreground">{w}</p>)}
            {check.errors.length > 0 && (
              <ul className="text-muted-foreground max-h-28 space-y-0.5 overflow-y-auto text-xs">
                {check.errors.map((e) => <li key={e.row}>Row {e.row}{e.number ? ` (${e.number})` : ""}: {e.error}</li>)}
              </ul>
            )}
            {check.preview.length > 0 && (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader><TableRow><TableHead>Number</TableHead><TableHead>Short description</TableHead><TableHead>Maps to</TableHead><TableHead>Group</TableHead><TableHead>State</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {check.preview.map((p) => (
                      <TableRow key={p.number}>
                        <TableCell className="font-mono text-xs">{p.number}</TableCell>
                        <TableCell className="max-w-56 truncate">{p.short_description}</TableCell>
                        <TableCell className="whitespace-nowrap">{p.subcategory}</TableCell>
                        <TableCell className="text-muted-foreground whitespace-nowrap">{p.assignment_group}</TableCell>
                        <TableCell className="text-muted-foreground">{p.state}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        )}
        <div className="flex gap-2">
          <Button variant={check ? "outline" : "default"} onClick={() => run(true)} disabled={!file || busy !== null}>
            {busy === "check" && <Loader2 className="animate-spin" />} Check file
          </Button>
          {check && check.rows_valid > 0 && (
            <Button onClick={() => run(false)} disabled={busy !== null}>
              {busy === "import" && <Loader2 className="animate-spin" />} Import {check.rows_valid} tickets
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function DocumentUpload({ onDone }: { onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [title, setTitle] = useState("")
  const [sub, setSub] = useState("")
  const [subs, setSubs] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<DocumentUploadResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { api.taxonomy().then((t) => setSubs(t.subcategories.map((s) => s.name))).catch(() => {}) }, [])

  async function submit() {
    if (!file) return
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const res = await api.uploadDocument(file, title.trim() || undefined, sub || undefined)
      setResult(res)
      setFile(null)
      setTitle("")
      setSub("")
      toast.success(`Added ${res.kb_id} to the knowledge base`)
      onDone()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><FileText className="size-4" /> Knowledge document</CardTitle>
        <CardDescription>
          A how-to or troubleshooting guide (PDF, TXT or Markdown). It is split into passages, embedded and added to the
          knowledge graph, so the assistant can cite it straight away.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <FilePick accept=".pdf,.txt,.md,.markdown" file={file} onFile={(f) => { setFile(f); setError(null) }} label="Choose a document (max 4 MB)" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="doc-title">Title <span className="text-muted-foreground">(optional)</span></Label>
            <Input id="doc-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={150} placeholder="Read from the document" />
          </div>
          <div className="space-y-1.5">
            <Label>Ticket area <span className="text-muted-foreground">(optional)</span></Label>
            <Select value={sub} onValueChange={setSub}>
              <SelectTrigger className="w-full" aria-label="Ticket area"><SelectValue placeholder="Chosen automatically" /></SelectTrigger>
              <SelectContent>{subs.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </div>
        {error && <p className="text-sm" style={{ color: "var(--status-critical)" }}>{error}</p>}
        {result && (
          <div className="flex items-start gap-2 rounded-md border p-3 text-sm">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" style={{ color: "var(--status-good)" }} aria-label="Added" />
            <div>
              <Link href={`/kb/${result.kb_id}`} className="font-medium underline">{result.kb_id} · {result.title}</Link>
              <p className="text-muted-foreground">
                Filed under {result.subcategory} · {result.chunks} passages · {result.entities} entities · {result.relations} relations
                {result.ticket_links > 0 && ` · linked to ${result.ticket_links} past tickets`} · {result.seconds}s
                {!result.file_stored && " · original file not stored (no persistent storage); its text is searchable"}
              </p>
            </div>
          </div>
        )}
        <Button onClick={submit} disabled={!file || busy}>
          {busy ? <><Loader2 className="animate-spin" /> Reading and indexing…</> : "Add to knowledge base"}
        </Button>
      </CardContent>
    </Card>
  )
}

const KIND_LABEL = { tickets: "Tickets", document: "Document", notice: "Notice" } as const

function History({ items, onUndo }: { items: ImportRecord[] | null; onUndo: () => void }) {
  async function undo(i: ImportRecord) {
    const what = i.kind === "tickets" ? `the ${i.rows} tickets it added or updated` : i.kind === "document" ? `article ${i.kb_id}` : `its ${i.events} events`
    if (!window.confirm(`Undo ${i.import_id} (${i.file_name})? This removes ${what}.`)) return
    try {
      const res = await api.undoImport(i.import_id)
      toast.success(`Undone: removed ${res.removed}`)
      onUndo()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Upload history</CardTitle>
        <CardDescription>Every upload can be undone.</CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        {items && items.length === 0 && <p className="text-muted-foreground px-6 text-sm">Nothing uploaded yet.</p>}
        {items && items.length > 0 && (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader><TableRow><TableHead className="pl-6">When</TableHead><TableHead>Type</TableHead><TableHead>File</TableHead><TableHead>Result</TableHead><TableHead className="pr-6" /></TableRow></TableHeader>
              <TableBody>
                {items.map((i) => (
                  <TableRow key={i.import_id}>
                    <TableCell className="text-muted-foreground pl-6 whitespace-nowrap tabular-nums">{formatDateTime(i.created_at)}</TableCell>
                    <TableCell><Badge variant="outline" className="font-normal">{KIND_LABEL[i.kind]}</Badge></TableCell>
                    <TableCell className="max-w-48 truncate">{i.file_name}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {i.kind === "tickets" && `${i.rows} tickets (${i.new_tickets} new, ${i.replaced_tickets} updated)`}
                      {i.kind === "document" && <Link href={`/kb/${i.kb_id}`} className="underline">{i.kb_id}</Link>}
                      {i.kind === "notice" && `${i.events} events · ${i.linked_tickets ?? 0} incidents linked`}
                    </TableCell>
                    <TableCell className="pr-6 text-right">
                      <Button variant="ghost" size="sm" onClick={() => undo(i)}><Undo2 /> Undo</Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

const TEMPLATE_LABEL = { demo: "Demo data", knowledge: "Standard knowledge base", blank: "Blank" } as const

function Workspaces() {
  const [items, setItems] = useState<Workspace[] | null>(null)
  const [current, setCurrent] = useState<string | null>(null)
  const load = useCallback(() => {
    api.workspaces().then((r) => { setItems(r.items); setCurrent(r.current) }).catch(() => setItems([]))
  }, [])
  useEffect(() => { load() }, [load])

  async function remove(w: Workspace) {
    const typed = window.prompt(`Delete "${w.name}" and ALL its tickets, documents, events and uploads? `
      + "This can't be undone.\n\nType the workspace name to confirm:")
    if (typed?.trim() !== w.name) {
      if (typed !== null) toast.error("The name didn't match; nothing was deleted")
      return
    }
    try {
      await api.deleteWorkspace(w.id)
      toast.success(`Deleted ${w.name}`)
      // Full reload: every view must forget the deleted workspace.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      if (w.id === current) window.location.assign("/data")
      else load()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><Building2 className="size-4" /> Workspaces</CardTitle>
        <CardDescription>
          Each workspace is a separate service desk with its own data. Switch or create one from the sidebar.
          A workspace with the standard knowledge base uses about 25 MB of the database.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader><TableRow><TableHead className="pl-6">Name</TableHead><TableHead>Started with</TableHead><TableHead>Created</TableHead><TableHead className="pr-6" /></TableRow></TableHeader>
            <TableBody>
              {items?.map((w) => (
                <TableRow key={w.id}>
                  <TableCell className="pl-6 font-medium">
                    {w.name}{w.id === current && <Badge variant="secondary" className="ml-2 font-normal">current</Badge>}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{TEMPLATE_LABEL[w.template]}</TableCell>
                  <TableCell className="text-muted-foreground tabular-nums">{formatDateTime(w.created_at)}</TableCell>
                  <TableCell className="pr-6 text-right">
                    {w.id !== "default" && (
                      <Button variant="ghost" size="sm" onClick={() => remove(w)}><Trash2 /> Delete</Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  )
}

export function DataPage() {
  const [history, setHistory] = useState<ImportRecord[] | null>(null)
  const refresh = useCallback(() => { api.imports().then(setHistory).catch(() => setHistory([])) }, [])
  useEffect(() => { refresh() }, [refresh])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Data upload</h1>
        <p className="text-muted-foreground text-sm">Bring in ticket history, knowledge documents and operational notices.</p>
      </div>
      <UploadKeyCard />
      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-2">
        <TicketImport onDone={refresh} />
        <DocumentUpload onDone={refresh} />
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><CalendarClock className="size-4" /> Maintenance, power work &amp; change notices</CardTitle>
          <CardDescription>
            Events read from the notice are linked to incidents opened during them, shown on tickets and in the
            assistant, and drawn in the network graph. <Link href="/events" className="underline">See all events</Link>
          </CardDescription>
        </CardHeader>
        <CardContent><NoticeUploader onSaved={refresh} /></CardContent>
      </Card>
      <History items={history} onUndo={refresh} />
      <Workspaces />
    </div>
  )
}
