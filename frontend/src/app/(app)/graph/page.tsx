import type { Metadata } from "next"
import { Suspense } from "react"

import { GraphExplorer } from "@/components/graph/graph-explorer"
import { Skeleton } from "@/components/ui/skeleton"

export const metadata: Metadata = { title: "Network graph" }

export default function GraphPage() {
  // The ticket/event to show lives in the URL (useSearchParams): request-time data, needs Suspense.
  return (
    <Suspense fallback={<Skeleton className="h-[600px] w-full" />}>
      <GraphExplorer />
    </Suspense>
  )
}
