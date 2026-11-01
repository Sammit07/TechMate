"use client"

import { AlertTriangle, CheckCircle2, Loader2, TicketPlus } from "lucide-react"
import Link from "next/link"
import { useState } from "react"
import { toast } from "sonner"

import { PriorityBadge } from "@/components/badges"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { api, type Ticket, type TicketDraft } from "@/lib/api"

const CALLER_KEY = "itsa.caller"

function savedCaller(): { name?: string; email?: string } {
  try {
    return JSON.parse(localStorage.getItem(CALLER_KEY) ?? "{}")
  } catch {
    return {}  // storage unavailable
  }
}

export function TicketDraftCard({ draft }: { draft: TicketDraft }) {
  const [title, setTitle] = useState(draft.short_description)
  const [description, setDescription] = useState(draft.description)
  // The card only appears in the browser (after a chat turn), so storage can be read on mount.
  const [name, setName] = useState(() => savedCaller().name ?? "")
  const [email, setEmail] = useState(() => savedCaller().email ?? "")
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState<Ticket | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const ticket = await api.createTicket({
        caller_name: name.trim(), caller_email: email.trim(), short_description: title.trim(),
        description: description.trim(), subcategory: draft.subcategory ?? undefined, priority: draft.priority,
        contact_type: "Chat",
      })
      try { localStorage.setItem(CALLER_KEY, JSON.stringify({ name: name.trim(), email: email.trim() })) } catch { /* */ }
      setCreated(ticket)
      toast.success(`Ticket ${ticket.number} created`)
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (created) {
    return (
      <Card className="border-l-4" style={{ borderLeftColor: "var(--status-good)" }}>
        <CardContent className="space-y-2 py-4 text-sm">
          <div className="flex items-center gap-2 font-medium">
            <CheckCircle2 className="size-4" style={{ color: "var(--status-good)" }} />
            Ticket <Link href={`/tickets/${created.number}`} className="underline">{created.number}</Link> created
          </div>
          <p className="text-muted-foreground">
            Assigned to <strong className="text-foreground">{created.assignment_group}</strong> as priority{" "}
            <strong className="text-foreground">{created.priority}</strong>. You can track it here or ask me for its status.
          </p>
          {created.possible_major_incident && (
            <Alert>
              <AlertTriangle className="size-4" style={{ color: "var(--status-serious)" }} />
              <AlertTitle>Possible wider incident</AlertTitle>
              <AlertDescription>{created.possible_major_incident.message} The service desk has been alerted.</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><TicketPlus className="size-4" /> Ticket draft</CardTitle>
        <CardDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>{draft.category}{draft.subcategory ? ` · ${draft.subcategory}` : ""}</span>
          <span aria-hidden>→</span>
          <span className="text-foreground font-medium">{draft.assignment_group}</span>
          <PriorityBadge priority={draft.priority} />
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="draft-title">Title</Label>
            <Input id="draft-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="draft-desc">Description</Label>
            <Textarea id="draft-desc" value={description} onChange={(e) => setDescription(e.target.value)}
                      rows={4} maxLength={4000} required />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="caller-name">Your name</Label>
              <Input id="caller-name" value={name} onChange={(e) => setName(e.target.value)} minLength={2} maxLength={100}
                     autoComplete="name" required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="caller-email">Work email</Label>
              <Input id="caller-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                     autoComplete="email" required />
            </div>
          </div>
          <p className="text-muted-foreground text-xs">{draft.rationale}</p>
          <Button type="submit" disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <TicketPlus />} Create ticket
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
