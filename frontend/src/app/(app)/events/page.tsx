import type { Metadata } from "next"
import { Suspense } from "react"

import { EventsPage } from "@/components/events/events-page"
import { Skeleton } from "@/components/ui/skeleton"

export const metadata: Metadata = { title: "Events" }

export default function Events() {
  // ?focus=EVT… comes from the URL (useSearchParams): request-time data, needs Suspense.
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <EventsPage />
    </Suspense>
  )
}
