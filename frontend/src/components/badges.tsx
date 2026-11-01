// Priority and state badges. Status colours always come with an icon and a text label.
import { AlertOctagon, AlertTriangle, ArrowDown, CheckCircle2, Circle, Clock, Loader, PauseCircle } from "lucide-react"
import type { ComponentType } from "react"

import { Badge } from "@/components/ui/badge"
import type { Priority, TicketState } from "@/lib/api"

type Tone = "good" | "warning" | "serious" | "critical" | "neutral"
const TONE: Record<Tone, string> = {
  good: "var(--status-good)", warning: "var(--status-warning)", serious: "var(--status-serious)",
  critical: "var(--status-critical)", neutral: "var(--muted-foreground)",
}

function ToneBadge({ tone, icon: Icon, label }: { tone: Tone; icon: ComponentType<{ className?: string; style?: object }>; label: string }) {
  return (
    <Badge variant="outline" className="gap-1.5 font-normal whitespace-nowrap">
      <Icon className="size-3.5" style={{ color: TONE[tone] }} aria-hidden />
      {label}
    </Badge>
  )
}

export function PriorityBadge({ priority }: { priority: Priority | string }) {
  const label = priority.split(" - ")[1] ?? priority
  switch (priority.charAt(0)) {
    case "1": return <ToneBadge tone="critical" icon={AlertOctagon} label={label} />
    case "2": return <ToneBadge tone="serious" icon={AlertTriangle} label={label} />
    case "3": return <ToneBadge tone="warning" icon={AlertTriangle} label={label} />
    default: return <ToneBadge tone="neutral" icon={ArrowDown} label={label} />
  }
}

export function StateBadge({ state }: { state: TicketState | string }) {
  switch (state) {
    case "New": return <ToneBadge tone="neutral" icon={Circle} label="New" />
    case "In Progress": return <ToneBadge tone="warning" icon={Loader} label="In progress" />
    case "On Hold": return <ToneBadge tone="neutral" icon={PauseCircle} label="On hold" />
    case "Resolved": return <ToneBadge tone="good" icon={CheckCircle2} label="Resolved" />
    case "Closed": return <ToneBadge tone="good" icon={CheckCircle2} label="Closed" />
    default: return <ToneBadge tone="neutral" icon={Clock} label={state} />
  }
}

export function SlaBadge({ breached }: { breached: boolean }) {
  return breached ? <ToneBadge tone="critical" icon={AlertOctagon} label="SLA breached" /> : null
}
