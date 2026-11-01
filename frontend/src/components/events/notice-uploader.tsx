"use client"

import { AlertTriangle, FileUp, Loader2, Plus, Sparkles, Trash2, X } from "lucide-react"
import { useEffect, useState } from "react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { api, type EventDraft, type EventType } from "@/lib/api"
import { EVENT_ICONS } from "./event-meta"

const TYPES = Object.keys(EVENT_ICONS) as EventType[]
const EXAMPLE = `Subject: Planned power shutdown, Pune Hinjewadi campus
The UPS and main power panels will be serviced next Saturday from 08:00 to 14:00. Floors 2-5 will have no power:
Wi-Fi, desk network ports and printers will be down. Please shut down laptops and docks before leaving on Friday.`

const toInput = (v: string) => v.slice(0, 16).replace(" ", "T")
const fromInput = (v: string) => v.replace("T", " ")

function Chips({ items, onRemove }: { items: string[]; onRemove: (item: string) => void }) {
  return (
    <>
      {items.map((item) => (
        <Badge key={item} variant="secondary" className="gap-1 pr-1 font-normal">
          {item}
          <button type="button" onClick={() => onRemove(item)} aria-label={`Remove ${item}`}
                  className="hover:bg-background/60 rounded-sm p-0.5"><X className="size-3" /></button>
        </Badge>
      ))}
    </>
  )
}

function AddSelect({ options, placeholder, onAdd }: { options: string[]; placeholder: string; onAdd: (v: string) => void }) {
  if (!options.length) return null
  return (
    <Select value="" onValueChange={onAdd}>
      <SelectTrigger size="sm" className="h-7 w-auto gap-1 text-xs" aria-label={placeholder}>
        <Plus className="size-3" /><SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>{options.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}</SelectContent>
    </Select>
  )
}

/** Paste or upload a maintenance / power / change notice; check the events it describes; save them. */
export function NoticeUploader({ onSaved }: { onSaved?: () => void }) {
  const [text, setText] = useState("")
  const [file, setFile] = useState<File | null>(null)
  const [fileName, setFileName] = useState("notice")
  const [drafts, setDrafts] = useState<EventDraft[] | null>(null)
  const [locations, setLocations] = useState<string[]>([])
  const [subcategories, setSubcategories] = useState<string[]>([])
  const [busy, setBusy] = useState<"read" | "save" | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.taxonomy().then((t) => { setLocations(t.locations); setSubcategories(t.subcategories.map((s) => s.name)) })
      .catch(() => {})
  }, [])

  async function read() {
    setBusy("read")
    setError(null)
    try {
      const res = await api.extractNotice(file ? { file } : { text })
      setDrafts(res.events)
      setFileName(res.file_name)
      if (res.locations.length) setLocations(res.locations)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  async function save() {
    if (!drafts?.length) return
    setBusy("save")
    setError(null)
    try {
      const res = await api.saveEvents(fileName, drafts.map((d) => ({ ...d, warnings: undefined })))
      const linked = res.events.reduce((n, e) => n + e.linked_tickets, 0)
      toast.success(`Saved ${res.events.length} event${res.events.length === 1 ? "" : "s"}`, {
        description: linked ? `Linked to ${linked} existing incident${linked === 1 ? "" : "s"}. New tickets will be linked as they arrive.`
          : "New tickets in the affected window will be linked as they arrive.",
      })
      setDrafts(null)
      setText("")
      setFile(null)
      onSaved?.()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const update = (i: number, patch: Partial<EventDraft>) =>
    setDrafts((d) => d && d.map((x, j) => (j === i ? { ...x, ...patch } : x)))

  if (drafts) {
    return (
      <div className="space-y-4">
        <p className="text-muted-foreground text-sm">
          Found {drafts.length} event{drafts.length === 1 ? "" : "s"} in <span className="text-foreground">{fileName}</span>.
          Check the times, places and affected ticket areas, then save. Tickets opened during each window (and a few hours
          after) at those locations and in those areas will be linked.
        </p>
        {drafts.map((d, i) => (
          <Card key={i} className="gap-3 py-4">
            <CardContent className="space-y-3 px-4">
              <div className="flex items-start gap-2">
                <div className="flex-1 space-y-1.5">
                  <Label htmlFor={`title-${i}`}>Title</Label>
                  <Input id={`title-${i}`} value={d.title} maxLength={150} onChange={(e) => update(i, { title: e.target.value })} />
                </div>
                <Button variant="ghost" size="icon" className="mt-6" aria-label="Remove this event"
                        onClick={() => setDrafts(drafts.filter((_, j) => j !== i))}><Trash2 /></Button>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <Label>Type</Label>
                  <Select value={d.type} onValueChange={(v) => update(i, { type: v as EventType })}>
                    <SelectTrigger className="w-full" aria-label="Event type"><SelectValue /></SelectTrigger>
                    <SelectContent>{TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`start-${i}`}>Starts</Label>
                  <Input id={`start-${i}`} type="datetime-local" value={toInput(d.start)}
                         onChange={(e) => update(i, { start: fromInput(e.target.value) })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`end-${i}`}>Ends</Label>
                  <Input id={`end-${i}`} type="datetime-local" value={toInput(d.end)}
                         onChange={(e) => update(i, { end: fromInput(e.target.value) })} />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Locations</Label>
                <div className="flex flex-wrap items-center gap-1.5">
                  <label className="mr-1 inline-flex items-center gap-1.5 text-sm">
                    <input type="checkbox" checked={d.all_locations} className="accent-[var(--series-1)]"
                           onChange={(e) => update(i, { all_locations: e.target.checked })} /> All locations
                  </label>
                  {!d.all_locations && (
                    <>
                      <Chips items={d.locations} onRemove={(x) => update(i, { locations: d.locations.filter((l) => l !== x) })} />
                      <AddSelect options={locations.filter((l) => !d.locations.includes(l))} placeholder="Add location"
                                 onAdd={(v) => update(i, { locations: [...d.locations, v] })} />
                    </>
                  )}
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Ticket areas it will affect</Label>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Chips items={d.subcategories}
                         onRemove={(x) => update(i, { subcategories: d.subcategories.filter((s) => s !== x) })} />
                  <AddSelect options={subcategories.filter((s) => !d.subcategories.includes(s))} placeholder="Add area"
                             onAdd={(v) => update(i, { subcategories: [...d.subcategories, v] })} />
                  {d.subcategories.length === 0 && <span className="text-muted-foreground text-xs">none: links tickets of any kind</span>}
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor={`impact-${i}`}>What users will notice</Label>
                  <Textarea id={`impact-${i}`} rows={2} maxLength={500} value={d.user_impact}
                            onChange={(e) => update(i, { user_impact: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`advice-${i}`}>Advice for users</Label>
                  <Textarea id={`advice-${i}`} rows={2} maxLength={500} value={d.advice}
                            onChange={(e) => update(i, { advice: e.target.value })} />
                </div>
              </div>
              {d.warnings?.map((w) => (
                <p key={w} className="text-muted-foreground flex items-center gap-1.5 text-xs">
                  <AlertTriangle className="size-3.5" style={{ color: "var(--status-warning)" }} aria-hidden /> {w}
                </p>
              ))}
            </CardContent>
          </Card>
        ))}
        {error && <p className="text-sm" style={{ color: "var(--status-critical)" }}>{error}</p>}
        <div className="flex gap-2">
          <Button onClick={save} disabled={busy !== null || drafts.length === 0}>
            {busy === "save" ? <Loader2 className="animate-spin" /> : null} Save {drafts.length} event{drafts.length === 1 ? "" : "s"}
          </Button>
          <Button variant="ghost" onClick={() => setDrafts(null)} disabled={busy !== null}>Back</Button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="notice-text">Paste the notice</Label>
        <Textarea id="notice-text" rows={6} maxLength={20000} value={text} disabled={Boolean(file)}
                  onChange={(e) => setText(e.target.value)} placeholder={EXAMPLE} />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="hover:bg-muted inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-sm">
          <FileUp className="size-4" /> {file ? file.name : "…or upload a file (PDF, TXT, MD, EML)"}
          <input type="file" accept=".pdf,.txt,.md,.eml" className="sr-only"
                 onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        {file && <Button variant="ghost" size="sm" onClick={() => setFile(null)}>Clear file</Button>}
      </div>
      {error && <p className="text-sm" style={{ color: "var(--status-critical)" }}>{error}</p>}
      <Button onClick={read} disabled={busy !== null || (!file && text.trim().split(/\s+/).length < 5)}>
        {busy === "read" ? <Loader2 className="animate-spin" /> : <Sparkles />} Read notice
      </Button>
    </div>
  )
}
