"use client"

import {
  BookOpen, CalendarClock, Headset, LayoutDashboard, LineChart, LogOut, Menu, Moon, Network, Sun, Ticket, Upload,
  Waypoints,
} from "lucide-react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { useTheme } from "next-themes"
import { Suspense, useState } from "react"

import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { WorkspaceSwitcher } from "@/components/workspace-switcher"
import { api } from "@/lib/api"
import { SITE } from "@/lib/site"
import { cn } from "@/lib/utils"

const NAV = [
  { title: "Support", items: [
    { href: "/", label: "Assistant", icon: Headset },
    { href: "/tickets", label: "Tickets", icon: Ticket },
    { href: "/kb", label: "Knowledge base", icon: BookOpen },
  ] },
  { title: "Insights", items: [
    { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    { href: "/forecast", label: "Forecast", icon: LineChart },
    { href: "/graph", label: "Network graph", icon: Waypoints },
    { href: "/events", label: "Events", icon: CalendarClock },
  ] },
  { title: "Admin", items: [
    { href: "/data", label: "Data upload", icon: Upload },
  ] },
]

function Brand() {
  return (
    <Link href="/" className="flex items-center gap-2.5 px-2 font-semibold">
      <span className="grid size-8 place-items-center rounded-lg text-white" style={{ background: "var(--series-1)" }}>
        <Network className="size-4" />
      </span>
      <span className="leading-tight">
        {SITE.name}
        <span className="text-muted-foreground block text-xs font-normal">{SITE.tagline}</span>
      </span>
    </Link>
  )
}

function NavLinks({ pathname, onNavigate }: { pathname: string | null; onNavigate?: () => void }) {
  const isActive = (href: string) => pathname != null && (href === "/" ? pathname === "/" : pathname.startsWith(href))
  return (
    <nav className="space-y-5" aria-label="Main">
      {NAV.map((group) => (
        <div key={group.title}>
          <div className="text-muted-foreground mb-1 px-2 text-xs font-medium">{group.title}</div>
          <ul className="space-y-0.5">
            {group.items.map(({ href, label, icon: Icon }) => (
              <li key={href}>
                <Link href={href} onClick={onNavigate} aria-current={isActive(href) ? "page" : undefined}
                      className={cn("flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors",
                                    isActive(href) ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                                      : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground")}>
                  <Icon className="size-4 shrink-0" />
                  {label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  )
}

// The current path is request-time data on dynamic routes: render links first, highlight once known.
function ActiveNavLinks({ onNavigate }: { onNavigate?: () => void }) {
  return <NavLinks pathname={usePathname()} onNavigate={onNavigate} />
}

function Nav({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <Suspense fallback={<NavLinks pathname={null} />}>
      <ActiveNavLinks onNavigate={onNavigate} />
    </Suspense>
  )
}

function ThemeToggle({ withLabel = false }: { withLabel?: boolean }) {
  const { resolvedTheme, setTheme } = useTheme()
  const dark = resolvedTheme === "dark"
  return (
    <Button variant="ghost" size={withLabel ? "sm" : "icon"} aria-label="Toggle dark mode"
            onClick={() => setTheme(dark ? "light" : "dark")} className={withLabel ? "w-full justify-start" : ""}>
      <Sun className="hidden dark:block" />
      <Moon className="dark:hidden" />
      {withLabel && <span className="text-muted-foreground">Theme</span>}
    </Button>
  )
}

function SignOut() {
  return (
    <Button variant="ghost" size="sm" className="w-full justify-start"
            // Full reload after signing out, so no signed-in data stays in memory.
            // eslint-disable-next-line @next/next/no-location-assign-relative-destination
            onClick={() => { api.logout().finally(() => window.location.assign("/login")) }}>
      <LogOut /> <span className="text-muted-foreground">Sign out</span>
    </Button>
  )
}

/** Fixed left sidebar on desktop. */
export function AppSidebar() {
  return (
    <aside className="bg-sidebar text-sidebar-foreground fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r md:flex">
      <div className="flex h-16 items-center px-3"><Brand /></div>
      <div className="px-3 pb-3"><WorkspaceSwitcher /></div>
      <div className="flex-1 overflow-y-auto px-3 py-2"><Nav /></div>
      <div className="space-y-0.5 border-t p-3"><ThemeToggle withLabel /><SignOut /></div>
    </aside>
  )
}

/** Top bar with a menu button on phones and small tablets. */
export function MobileHeader() {
  const [open, setOpen] = useState(false)
  return (
    <header className="bg-background/90 sticky top-0 z-30 flex h-14 items-center gap-2 border-b px-4 backdrop-blur md:hidden">
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Open menu"><Menu /></Button>
        </SheetTrigger>
        <SheetContent side="left" className="w-64 p-3">
          <SheetTitle className="sr-only">{SITE.name} menu</SheetTitle>
          <SheetDescription className="sr-only">Main navigation</SheetDescription>
          <div className="py-2"><Brand /></div>
          <WorkspaceSwitcher />
          <Nav onNavigate={() => setOpen(false)} />
          <div className="mt-auto border-t pt-2"><SignOut /></div>
        </SheetContent>
      </Sheet>
      <Brand />
      <div className="ml-auto"><ThemeToggle /></div>
    </header>
  )
}
