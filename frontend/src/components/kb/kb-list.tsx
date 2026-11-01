"use client"

import { FileText, Search } from "lucide-react"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useEffect, useMemo, useState } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { api, type KBArticle } from "@/lib/api"
import { kbPdfUrl } from "@/lib/format"

export function KBList() {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const q = params.get("q") ?? ""
  const category = params.get("category") ?? ""

  const [result, setResult] = useState<{ q: string; items: KBArticle[] } | null>(null)
  const articles = result && result.q === q ? result.items : null  // null while a new search loads
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState(q)

  useEffect(() => {
    let cancelled = false
    api.kbList(q || undefined)
      .then((items) => { if (!cancelled) { setResult({ q, items }); setError(null) } })
      .catch((e) => { if (!cancelled) setError((e as Error).message) })
    return () => { cancelled = true }
  }, [q])

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params.toString())
    if (value) next.set(key, value); else next.delete(key)
    router.replace(`${pathname}${next.size ? `?${next}` : ""}`)
  }

  const categories = useMemo(() => {
    const counts = new Map<string, number>()
    for (const a of articles ?? []) counts.set(a.category, (counts.get(a.category) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [articles])
  const shown = (articles ?? []).filter((a) => !category || a.category === category)

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Knowledge base</h1>
        <p className="text-muted-foreground text-sm">
          Step-by-step fixes used by the service desk and the assistant{articles && !q ? ` · ${articles.length} articles` : ""}.
        </p>
      </div>

      <form onSubmit={(e) => { e.preventDefault(); setParam("q", search.trim()) }} className="flex gap-2">
        <div className="relative flex-1">
          <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search, e.g. VPN error 809, BitLocker key, printer offline…"
                 className="pl-8" aria-label="Search the knowledge base" maxLength={200} />
        </div>
        <Button type="submit">Search</Button>
        {q && <Button type="button" variant="ghost" onClick={() => { setSearch(""); setParam("q", "") }}>Clear</Button>}
      </form>

      {categories.length > 1 && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by category">
          <Button size="sm" variant={category ? "outline" : "secondary"} onClick={() => setParam("category", "")}>All</Button>
          {categories.map(([c, n]) => (
            <Button key={c} size="sm" variant={category === c ? "secondary" : "outline"} aria-pressed={category === c}
                    onClick={() => setParam("category", category === c ? "" : c)}>
              {c} <span className="text-muted-foreground tabular-nums">{n}</span>
            </Button>
          ))}
        </div>
      )}

      {error && <Card><CardContent className="py-8 text-center">{error}</CardContent></Card>}
      {!articles && !error && <div className="space-y-2">{[...Array(6)].map((_, i) => <Skeleton key={i} className="h-20 w-full" />)}</div>}
      {articles && shown.length === 0 && (
        <Card><CardContent className="text-muted-foreground py-8 text-center">No articles match. Try different words, or ask the assistant.</CardContent></Card>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {shown.map((a) => (
          <Card key={a.kb_id} className="gap-2 py-4 transition-colors hover:bg-muted/40">
            <CardContent className="space-y-2 px-4">
              <div className="flex items-start justify-between gap-3">
                <Link href={`/kb/${a.kb_id}`} className="font-medium leading-snug hover:underline">{a.title}</Link>
                <a href={kbPdfUrl(a.file_name, a.file_url)} target="_blank" rel="noopener noreferrer" aria-label={`Open ${a.title} PDF`}
                   className="text-muted-foreground hover:text-foreground shrink-0"><FileText className="size-4" /></a>
              </div>
              <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                <span className="font-mono">{a.kb_id}</span>
                <Badge variant="outline">{a.subcategory}</Badge>
                {a.owner && <span>{a.owner}</span>}
                <span>{a.pages} {a.pages === 1 ? "page" : "pages"}</span>
                {a.tickets_resolved > 0 && <span>used in {a.tickets_resolved} tickets</span>}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
