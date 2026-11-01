import type { Metadata } from "next"
import { Suspense } from "react"

import { TicketList } from "@/components/tickets/ticket-list"
import { Skeleton } from "@/components/ui/skeleton"

export const metadata: Metadata = { title: "Tickets" }

export default function TicketsPage() {
  // Filters live in the URL (useSearchParams), which is request-time data: needs Suspense.
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <TicketList />
    </Suspense>
  )
}
