"use client"

import {
  Building2, CalendarClock, CheckCircle2, CircleDot, FileText, Headset, Laptop, MapPin, Radio, Tag, Ticket, User,
  Users, type LucideIcon,
} from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"

import type { GraphLink, GraphNode, GraphNodeType, NetworkGraph } from "@/lib/api"

// Colour by node type (tokens in globals.css, with the light values as fallback); an icon and a
// text label carry identity too, so colour is never the only cue.
export const NODE_TYPES: { type: GraphNodeType; label: string; icon: LucideIcon; fallback: string }[] = [
  { type: "ticket", label: "Ticket", icon: Ticket, fallback: "#2a78d6" },
  { type: "event", label: "Event", icon: CalendarClock, fallback: "#eb6834" },
  { type: "context", label: "Caller & context", icon: User, fallback: "#e87ba4" },
  { type: "classification", label: "Classification", icon: Tag, fallback: "#1baf7a" },
  { type: "routing", label: "Routing", icon: Users, fallback: "#6250d6" },
  { type: "outcome", label: "Outcome", icon: CheckCircle2, fallback: "#eda100" },
]

const KIND_ICONS: Record<string, LucideIcon> = {
  Caller: User, Location: MapPin, Channel: Radio, Device: Laptop, "Support group": Users, Agent: Headset,
  "KB article": FileText, Resolution: CheckCircle2, Status: CircleDot, "Similar ticket": Ticket, Category: Building2,
  Subcategory: Tag,
}

const FALLBACK = Object.fromEntries(NODE_TYPES.map((t) => [t.type, t.fallback])) as Record<GraphNodeType, string>
export const nodeColor = (type: GraphNodeType) => `var(--node-${type}, ${FALLBACK[type]})`
const TYPE_ORDER: GraphNodeType[] = ["event", "context", "ticket", "classification", "routing", "outcome"]

const MAX_NODE_W = 196
const NODE_H = 52
const FOCUS_H = 64
const ROW_GAP = 16
const HEADER_H = 34
const PAD_Y = 20
const MIN_COL_W = 160  // narrower containers scroll sideways

interface Placed extends GraphNode { x: number; y: number; h: number }

/** Columns by layer; within a column, order nodes by where their neighbours sit (fewer crossings). */
function layout(graph: NetworkGraph, width: number, focusId: string) {
  const layers = graph.layers.length
  const colW = Math.max(MIN_COL_W, width / layers)
  const nodeW = Math.min(MAX_NODE_W, colW - 36)
  const cols: GraphNode[][] = Array.from({ length: layers }, () => [])
  for (const n of graph.nodes) cols[Math.min(n.layer, layers - 1)].push(n)
  for (const col of cols) col.sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type))

  const neighbours = new Map<string, string[]>()
  for (const l of graph.links) {
    neighbours.set(l.source, [...(neighbours.get(l.source) ?? []), l.target])
    neighbours.set(l.target, [...(neighbours.get(l.target) ?? []), l.source])
  }
  const index = () => new Map(cols.flatMap((col) => col.map((n, i) => [n.id, i / Math.max(1, col.length - 1)] as const)))
  // Two barycentre sweeps: left-to-right uses earlier columns, right-to-left uses later ones.
  for (const forward of [true, false]) {
    const pos = index()
    const order = forward ? [...cols.keys()].slice(1) : [...cols.keys()].reverse().slice(1)
    for (const c of order) {
      const key = new Map(cols[c].map((n, i) => {
        const near = (neighbours.get(n.id) ?? []).filter((id) => {
          const layer = graph.nodes.find((m) => m.id === id)?.layer ?? c
          return forward ? layer < c : layer > c
        })
        const score = near.length ? near.reduce((s, id) => s + (pos.get(id) ?? 0), 0) / near.length : i / Math.max(1, cols[c].length - 1)
        return [n.id, score] as const
      }))
      cols[c].sort((a, b) => key.get(a.id)! - key.get(b.id)!)
    }
  }

  const heightOf = (n: GraphNode) => (n.id === focusId ? FOCUS_H : NODE_H)
  const colHeight = (col: GraphNode[]) => col.reduce((s, n) => s + heightOf(n), 0) + Math.max(0, col.length - 1) * ROW_GAP
  const height = HEADER_H + PAD_Y * 2 + Math.max(NODE_H, ...cols.map(colHeight))
  const placed = new Map<string, Placed>()
  cols.forEach((col, layer) => {
    let y = HEADER_H + PAD_Y + (height - HEADER_H - PAD_Y * 2 - colHeight(col)) / 2
    for (const n of col) {
      placed.set(n.id, { ...n, x: layer * colW + (colW - nodeW) / 2, y, h: heightOf(n) })
      y += heightOf(n) + ROW_GAP
    }
  })
  return { placed, width: colW * layers, height, colW, nodeW }
}

function edgeGeometry(s: Placed, t: Placed, nodeW: number) {
  const sy = s.y + s.h / 2
  const ty = t.y + t.h / 2
  if (s.layer === t.layer) {  // same column: arc out to the right
    const x = s.x + nodeW
    return { d: `M ${x} ${sy} C ${x + 34} ${sy}, ${x + 34} ${ty}, ${x + 2} ${ty}`, sx: x, sy, tx: x, ty, forward: true }
  }
  const forward = t.layer > s.layer
  const x1 = forward ? s.x + nodeW : s.x
  const x2 = forward ? t.x - 2 : t.x + nodeW + 2
  const dx = Math.max(40, Math.abs(x2 - x1) / 2) * (forward ? 1 : -1)
  return { d: `M ${x1} ${sy} C ${x1 + dx} ${sy}, ${x2 - dx} ${ty}, ${x2} ${ty}`, sx: x1, sy, tx: x2, ty, forward }
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s)

export function NetworkGraphView({ graph, selected, onSelect }: {
  graph: NetworkGraph
  selected: string | null
  onSelect: (node: GraphNode | null) => void
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(1000)
  const [hover, setHover] = useState<string | null>(null)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const focusId = `${graph.focus.kind}:${graph.focus.id}`
  const { placed, width: w, height: h, colW, nodeW } = useMemo(() => layout(graph, width, focusId), [graph, width, focusId])
  const maxChars = Math.floor((nodeW - 56) / 6.8)
  const active = hover ?? selected
  const activeNode = active ? placed.get(active) : undefined
  const neighbours = useMemo(() => {
    if (!active) return null
    const set = new Set([active])
    for (const l of graph.links) {
      if (l.source === active) set.add(l.target)
      if (l.target === active) set.add(l.source)
    }
    return set
  }, [active, graph.links])
  const touches = (l: GraphLink) => l.source === active || l.target === active
  // With a node active, each connected card says how it relates (in place of its type caption),
  // so link labels never need to float over other cards.
  const relation = useMemo(() => {
    const out = new Map<string, string>()
    if (!active) return out
    for (const l of graph.links) {
      const text = l.detail ? `${l.label} · ${l.detail}` : l.label
      if (l.source === active) out.set(l.target, `← ${text}`)
      else if (l.target === active) out.set(l.source, `${text} →`)
    }
    return out
  }, [active, graph.links])

  return (
    <div ref={wrapRef} className="w-full overflow-x-auto" onClick={() => onSelect(null)}>
      <svg width={w} height={h} role="img" aria-label={`Network graph of ${graph.focus.id}: ${graph.nodes.length} nodes`}
           className="block select-none">
        <defs>
          <marker id="arrow-muted" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 1 L 9 5 L 0 9 z" style={{ fill: "var(--muted-foreground)" }} />
          </marker>
          {NODE_TYPES.map(({ type }) => (
            <marker key={type} id={`arrow-${type}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 1 L 9 5 L 0 9 z" style={{ fill: nodeColor(type) }} />
            </marker>
          ))}
        </defs>

        {/* Lanes: one faint band per stage, so the left-to-right flow reads at a glance. */}
        {graph.layers.map((name, i) => (
          <g key={name}>
            <rect x={i * colW + 6} y={0} width={colW - 12} height={h} rx={12}
                  style={{ fill: "var(--muted)", opacity: i % 2 === 0 ? 0.55 : 0.3 }} />
            <text x={i * colW + colW / 2} y={22} textAnchor="middle"
                  className="fill-muted-foreground text-[11px] font-medium uppercase tracking-wider">{name}</text>
          </g>
        ))}

        {/* Links: quiet by default; the hovered/selected node's links light up in its colour. */}
        {graph.links.map((l) => {
          const s = placed.get(l.source)
          const t = placed.get(l.target)
          if (!s || !t) return null
          const { d } = edgeGeometry(s, t, nodeW)
          const lit = !active || touches(l)
          const hot = Boolean(active && touches(l) && activeNode)
          return (
            <path key={`${l.source}->${l.target}`} d={d} fill="none"
                  style={{ stroke: hot ? nodeColor(activeNode!.type) : "var(--muted-foreground)" }}
                  strokeOpacity={hot ? 0.95 : lit ? 0.4 : 0.1} strokeWidth={hot ? 2 : 1.25}
                  strokeDasharray={l.dashed ? "5 4" : undefined} strokeLinecap="round"
                  markerEnd={`url(#${hot ? `arrow-${activeNode!.type}` : "arrow-muted"})`} />
          )
        })}

        {[...placed.values()].map((n) => {
          const Icon = n.type === "ticket" && n.kind !== "Similar ticket" ? Ticket : n.type === "event" ? CalendarClock
            : KIND_ICONS[n.kind] ?? NODE_TYPES.find((t) => t.type === n.type)?.icon ?? CircleDot
          const dim = Boolean(neighbours && !neighbours.has(n.id))
          const isFocus = n.id === focusId
          const isSelected = n.id === selected
          const c = nodeColor(n.type)
          return (
            <g key={n.id} transform={`translate(${n.x}, ${n.y})`} className="cursor-pointer outline-none"
               tabIndex={0} role="button" aria-label={`${n.kind}: ${n.label}`} aria-pressed={isSelected}
               onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)}
               onFocus={() => setHover(n.id)} onBlur={() => setHover(null)}
               onClick={(e) => { e.stopPropagation(); onSelect(n) }}
               onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(n) } }}>
              <title>{`${n.kind}: ${n.label}${n.detail ? `\n${n.detail}` : ""}`}</title>
              {/* Opaque card first, so links pass behind nodes even when the node is faded. */}
              <rect width={nodeW} height={n.h} rx={10} className="fill-card" />
              <g opacity={dim ? 0.35 : 1}>
                <rect width={nodeW} height={n.h} rx={10} style={{ fill: c }} fillOpacity={isFocus ? 0.16 : 0.07} />
                <rect width={nodeW} height={n.h} rx={10} fill="none" style={{ stroke: c }}
                      strokeOpacity={isFocus || isSelected || n.id === hover ? 1 : 0.35}
                      strokeWidth={isFocus || isSelected ? 2 : 1} />
                <rect x={10} y={n.h / 2 - 14} width={28} height={28} rx={8} style={{ fill: c }} fillOpacity={0.16} />
                <Icon x={16} y={n.h / 2 - 8} width={16} height={16} style={{ color: c }} strokeWidth={2} aria-hidden />
                <text x={48} y={n.h / 2 - 3} className={`fill-foreground font-semibold ${isFocus ? "text-[13.5px]" : "text-[12.5px]"}`}>
                  {truncate(n.label, maxChars)}
                </text>
                {relation.has(n.id) ? (
                  <text x={48} y={n.h / 2 + 13} className="fill-foreground text-[10.5px] font-medium">
                    {truncate(relation.get(n.id)!, maxChars + 4)}
                  </text>
                ) : (
                  <text x={48} y={n.h / 2 + 13} className="fill-muted-foreground text-[10.5px]">{truncate(n.kind, maxChars + 4)}</text>
                )}
              </g>
            </g>
          )
        })}

      </svg>
    </div>
  )
}

export function GraphLegend() {
  return (
    <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
      {NODE_TYPES.map(({ type, label, icon: Icon }) => (
        <span key={type} className="inline-flex items-center gap-1.5">
          <span className="inline-grid size-5 place-items-center rounded-md"
                style={{ background: `color-mix(in oklab, ${nodeColor(type)} 18%, transparent)` }} aria-hidden>
            <Icon className="size-3" style={{ color: nodeColor(type) }} />
          </span>
          {label}
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5">
        <svg width="22" height="6" aria-hidden><line x1="0" y1="3" x2="22" y2="3" stroke="currentColor" strokeDasharray="4 3" /></svg>
        inferred link (event, similar ticket, default route)
      </span>
    </div>
  )
}
