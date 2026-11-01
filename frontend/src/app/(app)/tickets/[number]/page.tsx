import type { Metadata } from "next"
import { Suspense } from "react"

import { TicketDetail } from "@/components/tickets/ticket-detail"
import { Skeleton } from "@/components/ui/skeleton"

export const metadata: Metadata = { title: "Ticket" }

export default function TicketPage() {
  // Ticket numbers aren't known at build time, so useParams suspends: needs Suspense.
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <TicketDetail />
    </Suspense>
  )
}
