import type { Metadata } from "next"
import { Suspense } from "react"

import { KBList } from "@/components/kb/kb-list"
import { Skeleton } from "@/components/ui/skeleton"

export const metadata: Metadata = { title: "Knowledge base" }

export default function KBPage() {
  // Search and filter live in the URL (useSearchParams), which is request-time data: needs Suspense.
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <KBList />
    </Suspense>
  )
}
