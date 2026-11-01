import {
  AlertTriangle, CalendarDays, Download, Info, Network, ShieldCheck, Wrench, Zap, type LucideIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import type { EventType, OpsEvent } from "@/lib/api"
import { formatDateTime } from "@/lib/format"

export const EVENT_ICONS: Record<EventType, LucideIcon> = {
  "Planned maintenance": Wrench,
  "Power work": Zap,
  "Network change": Network,
  "Software update": Download,
  "Service outage": AlertTriangle,
  "Public holiday": CalendarDays,
  "Patch Tuesday": ShieldCheck,
  Other: Info,
}

export const CALENDAR_TYPES: EventType[] = ["Public holiday", "Patch Tuesday"]

export function EventTypeBadge({ type }: { type: EventType }) {
  const Icon = EVENT_ICONS[type] ?? Info
  return (
    <Badge variant="outline" className="gap-1 font-normal">
      <Icon className="size-3" style={{ color: "var(--node-event)" }} aria-hidden /> {type}
    </Badge>
  )
}

const STATUS_LABEL = { active: "Happening now", upcoming: "Upcoming", past: "Past" } as const

export function EventStatus({ status }: { status: OpsEvent["status"] }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      {status === "active" && (
        <span className="relative flex size-2" aria-hidden>
          <span className="absolute inline-flex size-full animate-ping rounded-full opacity-60" style={{ background: "var(--status-warning)" }} />
          <span className="relative inline-flex size-2 rounded-full" style={{ background: "var(--status-warning)" }} />
        </span>
      )}
      <span className={status === "active" ? "font-medium" : "text-muted-foreground"}>{STATUS_LABEL[status]}</span>
    </span>
  )
}

/** "28 Oct, 08:00 – 14:00" on one day, otherwise "28 Oct, 08:00 – 30 Oct, 23:59". */
export function formatWindow(start: string, end: string): string {
  const sameDay = start.slice(0, 10) === end.slice(0, 10)
  return sameDay ? `${formatDateTime(start)} – ${end.slice(11, 16)}` : `${formatDateTime(start)} – ${formatDateTime(end)}`
}

export function eventWhere(e: Pick<OpsEvent, "all_locations" | "locations">): string {
  return e.all_locations || !e.locations?.length ? "All locations" : e.locations.join(", ")
}
