import type { Metadata } from "next"
import { Suspense } from "react"

import { KBArticleView } from "@/components/kb/kb-article"
import { Skeleton } from "@/components/ui/skeleton"

export const metadata: Metadata = { title: "Knowledge article" }

export default function KBArticlePage() {
  // Article ids come from the URL (useParams), which suspends: needs Suspense.
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <KBArticleView />
    </Suspense>
  )
}
