"use client"

import { ArrowUp, BookOpen, CalendarClock, CheckCircle2, GitBranch, History, Loader2, RotateCcw, Square } from "lucide-react"
import Link from "next/link"
import { useEffect, useRef, useState } from "react"

import { StateBadge } from "@/components/badges"
import { EventStatus, EventTypeBadge, eventWhere, formatWindow } from "@/components/events/event-meta"
import { Markdown } from "@/components/markdown"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { type ChatEvent, type ChatMessage, streamChat, type Ticket, type TicketDraft } from "@/lib/api"
import { kbPdfUrl } from "@/lib/format"
import { TicketDraftCard } from "./ticket-draft-card"

type Sources = Extract<ChatEvent, { type: "sources" }>
type KnownEvents = Extract<ChatEvent, { type: "events" }>["events"]

interface Turn {
  role: "user" | "assistant"
  content: string
  stage?: string
  sources?: Sources
  events?: KnownEvents
  draft?: TicketDraft
  ticket?: Partial<Ticket>
  error?: string
  done?: boolean
}

const STAGES: Record<string, string> = {
  understanding: "Understanding your question…",
  searching: "Searching the knowledge base and past tickets…",
  drafting_ticket: "Preparing a ticket…",
  answering: "Writing an answer…",
}

const SUGGESTIONS = [
  "My VPN says the certificate has expired and I can't connect from home",
  "Windows update keeps failing with error 0x800f0922",
  "I got a new phone and Microsoft Authenticator has no accounts",
  "I think I clicked a phishing link",
  "What's the status of my ticket INC2005990?",
]

const STORAGE_KEY = "itsa.chat"

export function AssistantChat() {
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState("")
  const [busy, setBusy] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  // Keep the conversation across reloads in this tab.
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(STORAGE_KEY)
      if (saved) setTurns(JSON.parse(saved))
    } catch { /* storage unavailable */ }
    // "Ask the assistant" links (e.g. from a KB article) prefill the input via ?q=; read once, then drop it from the URL.
    const q = new URLSearchParams(window.location.search).get("q")
    if (q) {
      setInput(q.slice(0, 4000))
      window.history.replaceState(null, "", window.location.pathname)
    }
  }, [])
  useEffect(() => {
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(turns.filter((t) => t.done || t.role === "user"))) } catch { /* */ }
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })
  }, [turns])

  function update(fn: (t: Turn) => Turn) {
    setTurns((prev) => [...prev.slice(0, -1), fn(prev[prev.length - 1])])
  }

  async function send(text: string) {
    const content = text.trim()
    if (!content || busy) return
    const history: ChatMessage[] = [...turns.filter((t) => t.content), { role: "user" as const, content }]
      .map(({ role, content }) => ({ role, content })).slice(-12)
    setTurns((prev) => [...prev, { role: "user", content }, { role: "assistant", content: "", stage: "understanding" }])
    setInput("")
    setBusy(true)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      await streamChat(history, (e) => {
        switch (e.type) {
          case "status": update((t) => ({ ...t, stage: e.stage })); break
          case "sources": update((t) => ({ ...t, sources: e })); break
          case "events": update((t) => ({ ...t, events: e.events })); break
          case "token": update((t) => ({ ...t, content: t.content + e.text, stage: undefined })); break
          case "ticket_draft": update((t) => ({ ...t, draft: e.draft })); break
          case "ticket": update((t) => ({ ...t, ticket: e.ticket })); break
          case "error": update((t) => ({ ...t, error: e.message })); break
          case "done": update((t) => ({ ...t, stage: undefined, done: true })); break
        }
      }, controller.signal)
    } catch (err) {
      if ((err as Error).name !== "AbortError") update((t) => ({ ...t, error: (err as Error).message, stage: undefined }))
    } finally {
      update((t) => ({ ...t, stage: undefined, done: true }))
      setBusy(false)
      abortRef.current = null
    }
  }

  function reset() {
    abortRef.current?.abort()
    setTurns([])
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">IT support assistant</h1>
          <p className="text-muted-foreground text-sm">
            Describe the problem. I&apos;ll help you fix it from the knowledge base, or raise a ticket with the right team.
          </p>
        </div>
        {turns.length > 0 && (
          <Button variant="outline" size="sm" onClick={reset}><RotateCcw /> New chat</Button>
        )}
      </div>

      <div className="flex-1 space-y-6 pb-36">
        {turns.length === 0 && (
          <div className="grid gap-2 sm:grid-cols-2">
            {SUGGESTIONS.map((s) => (
              <button key={s} onClick={() => send(s)}
                      className="hover:bg-muted rounded-lg border p-3 text-left text-sm transition-colors">{s}</button>
            ))}
          </div>
        )}

        {turns.map((t, i) => t.role === "user" ? (
          <div key={i} className="flex justify-end">
            <div className="bg-muted max-w-[85%] rounded-2xl rounded-br-sm px-4 py-2.5 text-sm whitespace-pre-wrap">{t.content}</div>
          </div>
        ) : (
          <div key={i} className="space-y-3">
            {t.stage && (
              <div className="text-muted-foreground flex items-center gap-2 text-sm" role="status">
                <Loader2 className="size-4 animate-spin" /> {STAGES[t.stage] ?? "Working…"}
              </div>
            )}
            {t.ticket && (
              <div className="flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm">
                <Link href={`/tickets/${t.ticket.number}`} className="font-mono font-medium underline">{t.ticket.number}</Link>
                <span className="text-muted-foreground">{t.ticket.short_description}</span>
                {t.ticket.state && <StateBadge state={t.ticket.state} />}
              </div>
            )}
            {t.events && t.events.length > 0 && <KnownEventsCard events={t.events} />}
            {t.draft && <TicketDraftCard draft={t.draft} />}
            {t.content && <Markdown text={t.content} />}
            {t.error && <p className="text-sm" style={{ color: "var(--status-critical)" }}>{t.error}</p>}
            {t.done && t.sources && t.sources.similar_tickets.length > 0 && <SimilarTickets tickets={t.sources.similar_tickets} />}
            {t.done && t.sources && <SourcesPanel sources={t.sources} />}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <form onSubmit={(e) => { e.preventDefault(); void send(input) }}
            className="bg-background/95 fixed inset-x-0 bottom-0 z-20 border-t px-4 pt-3 backdrop-blur md:left-60"
            style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom, 0px))" }}>
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <Textarea value={input} onChange={(e) => setInput(e.target.value)} rows={1} maxLength={4000}
                    placeholder="Describe your IT issue…" aria-label="Message"
                    className="max-h-40 min-h-11 resize-none"
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(input) } }} />
          {busy ? (
            <Button type="button" size="icon" variant="outline" aria-label="Stop" onClick={() => abortRef.current?.abort()}>
              <Square />
            </Button>
          ) : (
            <Button type="submit" size="icon" aria-label="Send" disabled={!input.trim()}><ArrowUp /></Button>
          )}
        </div>
        <p className="text-muted-foreground mx-auto mt-1.5 max-w-3xl text-center text-xs">
          Never share passwords or MFA codes. Answers come from the IT knowledge base; check before acting.
        </p>
      </form>
    </div>
  )
}

function KnownEventsCard({ events }: { events: KnownEvents }) {
  return (
    <div className="rounded-lg border p-3 text-sm" style={{ borderColor: "color-mix(in oklab, var(--node-event) 45%, transparent)" }}>
      <div className="mb-2 flex items-center gap-1.5 font-medium">
        <CalendarClock className="size-4" style={{ color: "var(--node-event)" }} aria-hidden />
        {events.some((e) => e.status === "active") ? "Known event right now" : "Related event"}
      </div>
      <ul className="space-y-2">
        {events.map((e) => (
          <li key={e.event_id} className="space-y-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <EventTypeBadge type={e.type} />
              <Link href={`/events?focus=${e.event_id}`} className="font-medium hover:underline">{e.title}</Link>
              <EventStatus status={e.status} />
            </div>
            <div className="text-muted-foreground">{formatWindow(e.start_at, e.end_at)} · {eventWhere(e)}</div>
            {e.advice && <div>{e.advice}</div>}
          </li>
        ))}
      </ul>
    </div>
  )
}

function SimilarTickets({ tickets }: { tickets: Sources["similar_tickets"] }) {
  return (
    <div className="rounded-lg border p-3 text-sm">
      <div className="text-muted-foreground mb-2 flex items-center gap-1.5 text-xs font-medium tracking-wide uppercase">
        <History className="size-3.5" /> Similar resolved tickets
      </div>
      <ul className="divide-y">
        {tickets.map((t) => (
          <li key={t.number} className="py-2 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <Link href={`/tickets/${t.number}`} className="font-mono text-xs font-medium underline">{t.number}</Link>
              <span>{t.short_description}</span>
              <span className="text-muted-foreground text-xs">{t.subcategory}</span>
            </div>
            <p className="text-muted-foreground mt-0.5">
              <CheckCircle2 className="mr-1 inline size-3.5 align-[-2px]" style={{ color: "var(--status-good)" }} aria-label="Resolved" />
              {t.resolution}
            </p>
          </li>
        ))}
      </ul>
    </div>
  )
}

function SourcesPanel({ sources }: { sources: Sources }) {
  const articles = sources.chunks.filter((c, i, all) => all.findIndex((x) => x.kb_id === c.kb_id) === i)
  if (!articles.length && !sources.fix_paths.length) return null
  return (
    <details className="group rounded-lg border text-sm">
      <summary className="text-muted-foreground hover:text-foreground flex cursor-pointer list-none items-center gap-2 px-3 py-2">
        <BookOpen className="size-4" />
        {articles.length} source{articles.length === 1 ? "" : "s"}
        {sources.fix_paths.length > 0 && " · knowledge-graph fixes"}
      </summary>
      <div className="space-y-4 border-t px-3 py-3">
        <ul className="space-y-1.5">
          {articles.map((c) => (
            <li key={c.kb_id} className="flex flex-wrap items-baseline gap-x-2">
              <Link href={`/kb/${c.kb_id}`} className="font-medium hover:underline">{c.title}</Link>
              <span className="text-muted-foreground text-xs">{c.kb_id} · p. {c.page}</span>
              <a href={kbPdfUrl(c.file_name, c.file_url)} target="_blank" rel="noopener noreferrer"
                 className="text-muted-foreground text-xs underline">PDF</a>
            </li>
          ))}
        </ul>
        {sources.fix_paths.length > 0 && (
          <div>
            <div className="text-muted-foreground mb-1 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide">
              <GitBranch className="size-3.5" /> Known causes and fixes
            </div>
            <ul className="space-y-1">
              {sources.fix_paths.map((p, i) => (
                <li key={i} className="text-muted-foreground">
                  {p.symptom !== p.cause && <>{p.symptom} <span aria-hidden>→</span> </>}
                  <span className="text-foreground">{p.cause}</span> <span aria-hidden>→</span>{" "}
                  <span className="text-foreground font-medium">{p.fix}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </details>
  )
}
