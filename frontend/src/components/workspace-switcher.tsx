"use client"

import { BookOpen, Building2, Check, ChevronsUpDown, FileX2, Loader2, Plus } from "lucide-react"
import { useEffect, useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { api, type Workspace, type WorkspaceTemplate } from "@/lib/api"
import { cn } from "@/lib/utils"

const TEMPLATES: { value: WorkspaceTemplate; title: string; description: string; icon: typeof BookOpen }[] = [
  { value: "knowledge", title: "Standard knowledge base", icon: BookOpen,
    description: "106 IT how-to articles, ticket categories and routing, holidays. Add your own tickets." },
  { value: "blank", title: "Blank", icon: FileX2,
    description: "Ticket categories, routing and holidays only. Bring your own tickets and documents." },
]

/** After switching, detail pages (a ticket, an article) belong to the old workspace: go to their list. */
function landingPath(): string {
  const path = window.location.pathname
  if (path.startsWith("/tickets/")) return "/tickets"
  if (path.startsWith("/kb/")) return "/kb"
  if (path.startsWith("/graph")) return "/graph"
  return path
}

export function WorkspaceSwitcher() {
  const [items, setItems] = useState<Workspace[]>([])
  const [current, setCurrent] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [switching, setSwitching] = useState(false)

  useEffect(() => {
    api.workspaces().then((r) => { setItems(r.items); setCurrent(r.current) }).catch(() => {})
  }, [])

  async function select(id: string) {
    if (id === current) return
    setSwitching(true)
    try {
      await api.selectWorkspace(id)
      window.location.assign(landingPath())  // reload everything against the other workspace
    } catch (e) {
      toast.error((e as Error).message)
      setSwitching(false)
    }
  }

  const active = items.find((w) => w.id === current)
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="hover:bg-sidebar-accent/60 flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left text-sm transition-colors"
                  aria-label="Switch workspace" disabled={switching}>
            <span className="bg-muted grid size-7 shrink-0 place-items-center rounded-md">
              {switching ? <Loader2 className="size-4 animate-spin" /> : <Building2 className="size-4" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="text-muted-foreground block text-[11px] leading-tight">Workspace</span>
              <span className="block truncate font-medium leading-tight">{active?.name ?? "…"}</span>
            </span>
            <ChevronsUpDown className="text-muted-foreground size-4 shrink-0" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
          {items.map((w) => (
            <DropdownMenuItem key={w.id} onSelect={() => select(w.id)} className="gap-2">
              <Building2 className="size-4" />
              <span className="flex-1 truncate">{w.name}</span>
              {w.id === current && <Check className="size-4" aria-label="Current" />}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setCreating(true)} className="gap-2">
            <Plus className="size-4" /> New workspace…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <CreateWorkspaceDialog open={creating} onOpenChange={setCreating} />
    </>
  )
}

function CreateWorkspaceDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [name, setName] = useState("")
  const [template, setTemplate] = useState<WorkspaceTemplate>("knowledge")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function create(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const ws = await api.createWorkspace(name.trim(), template)
      toast.success(`Created ${ws.name}`, { description: "Upload your ticket history to get started." })
      // Full reload against the new workspace (now active); next step: bring in data.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign("/data")
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o) }}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={create} className="space-y-4">
          <DialogHeader>
            <DialogTitle>New workspace</DialogTitle>
            <DialogDescription>
              A separate service desk with its own tickets, knowledge base, events and uploads.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="ws-name">Name</Label>
            <Input id="ws-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus required
                   minLength={2} maxLength={60} placeholder="e.g. Pune campus service desk" />
          </div>
          <fieldset className="space-y-2">
            <legend className="mb-1.5 text-sm font-medium">Start with</legend>
            {TEMPLATES.map((t) => (
              <label key={t.value}
                     className={cn("flex cursor-pointer gap-3 rounded-lg border p-3 text-sm transition-colors",
                                   template === t.value ? "border-[var(--series-1)] bg-[var(--series-1)]/5" : "hover:bg-muted/50")}>
                <input type="radio" name="template" value={t.value} checked={template === t.value}
                       onChange={() => setTemplate(t.value)} className="sr-only" />
                <t.icon className="mt-0.5 size-4 shrink-0" style={{ color: "var(--series-1)" }} aria-hidden />
                <span>
                  <span className="block font-medium">{t.title}</span>
                  <span className="text-muted-foreground">{t.description}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {error && <p className="text-sm" role="alert" style={{ color: "var(--status-critical)" }}>{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
            <Button type="submit" disabled={busy || name.trim().length < 2}>
              {busy ? <><Loader2 className="animate-spin" /> Creating…</> : "Create workspace"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
