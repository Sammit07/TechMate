"use client"

import { ArrowLeft, ExternalLink, MessageSquare } from "lucide-react"
import Link from "next/link"
import { useParams } from "next/navigation"
import { useEffect, useState } from "react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { api, type KBArticleDetail } from "@/lib/api"
import { kbPdfUrl } from "@/lib/format"

// Entity types extracted from the articles for GraphRAG, in reading order.
const ENTITY_TYPES = [["Symptom", "Symptoms"], ["ErrorCode", "Error codes"], ["Cause", "Causes"], ["Fix", "Fixes"],
                      ["Product", "Products"], ["Component", "Components"]] as const

export function KBArticleView() {
  const { id } = useParams<{ id: string }>()
  const [article, setArticle] = useState<KBArticleDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api.kbArticle(id)
      .then((a) => { if (!cancelled) setArticle(a) })
      .catch((e) => { if (!cancelled) setError((e as Error).message) })
    return () => { cancelled = true }
  }, [id])

  if (error) {
    return (
      <Alert>
        <AlertTitle>Could not load {id}</AlertTitle>
        <AlertDescription>{error} <Link href="/kb" className="underline">Back to the knowledge base</Link></AlertDescription>
      </Alert>
    )
  }
  if (!article) return <div className="space-y-4"><Skeleton className="h-32 w-full" /><Skeleton className="h-[600px] w-full" /></div>

  // Catalog articles are PDFs; uploads may be PDF/TXT/Markdown, or have no stored file (serverless storage).
  const hasFile = article.source !== "upload" || Boolean(article.file_url)
  const pdf = kbPdfUrl(article.file_name, article.file_url)
  const isPdf = article.file_name.toLowerCase().endsWith(".pdf")
  const pagesText = article.chunks.filter((c, i, all) => all.findIndex((x) => x.page === c.page) === i)
  return (
    <div className="space-y-6">
      <Link href="/kb" className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm">
        <ArrowLeft className="size-4" /> Knowledge base
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <div className="text-muted-foreground font-mono text-sm">{article.kb_id}</div>
          <h1 className="text-2xl font-semibold tracking-tight">{article.title}</h1>
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <Badge variant="outline">{article.category}</Badge>
            <Badge variant="outline">{article.subcategory}</Badge>
            {article.owner && <span>Owner: {article.owner}</span>}
            <span>{article.pages} {article.pages === 1 ? "page" : "pages"}</span>
            {article.tickets_resolved > 0 && <span>Used to resolve {article.tickets_resolved} tickets</span>}
          </div>
        </div>
        <div className="flex gap-2">
          {hasFile && (
            <Button asChild variant="outline">
              <a href={pdf} target="_blank" rel="noopener noreferrer"><ExternalLink /> Open {isPdf ? "PDF" : "file"}</a>
            </Button>
          )}
          <Button asChild>
            <Link href={`/?q=${encodeURIComponent(`Help me with: ${article.title}`)}`}><MessageSquare /> Ask the assistant</Link>
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-3">
        <Card className="overflow-hidden py-0 lg:col-span-2">
          {/* Browsers on phones often can't show PDFs inline; the Open PDF button covers that. */}
          {hasFile && isPdf && (
            <iframe src={`${pdf}#view=FitH`} title={`${article.title} (PDF)`} className="hidden h-[80vh] w-full md:block" />
          )}
          <div className={`space-y-4 p-4 ${hasFile && isPdf ? "md:hidden" : ""}`}>
            {article.summary && <p className="text-muted-foreground text-sm italic">{article.summary}</p>}
            {pagesText.map((c) => (
              <p key={c.idx} className="text-sm whitespace-pre-wrap">{c.text}</p>
            ))}
          </div>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">In the knowledge graph</CardTitle>
              <CardDescription>Extracted from this article and used to connect it to tickets and other articles</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {ENTITY_TYPES.map(([type, label]) => {
                const items = article.entities.filter((e) => e.type === type)
                if (!items.length) return null
                return (
                  <div key={type}>
                    <div className="text-muted-foreground mb-1.5 text-xs font-medium tracking-wide uppercase">{label}</div>
                    <div className="flex flex-wrap gap-1.5">
                      {items.map((e) => <Badge key={e.name} variant="secondary" className="font-normal">{e.name}</Badge>)}
                    </div>
                  </div>
                )
              })}
              {article.entities.length === 0 && <p className="text-muted-foreground text-sm">No entities extracted.</p>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Indexed passages</CardTitle>
              <CardDescription>{article.chunks.length} overlapping chunks used for search</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {article.chunks.map((c) => (
                <details key={c.idx} className="rounded-md border px-3 py-2 text-sm">
                  <summary className="cursor-pointer">
                    Passage {c.idx + 1} <span className="text-muted-foreground">· page {c.page}</span>
                  </summary>
                  <p className="text-muted-foreground mt-2 text-xs whitespace-pre-wrap">{c.text}</p>
                </details>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
