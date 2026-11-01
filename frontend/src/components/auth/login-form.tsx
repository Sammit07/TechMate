"use client"

import { Loader2, LockKeyhole, Network } from "lucide-react"
import { useSearchParams } from "next/navigation"
import { useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { api } from "@/lib/api"
import { SITE } from "@/lib/site"

/** Only same-site paths, so ?next= can't send people to another site after signing in. */
function safeNext(value: string | null): string {
  return value && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/login") ? value : "/"
}

export function LoginForm() {
  const next = safeNext(useSearchParams().get("next"))
  const [password, setPassword] = useState("")
  const [checking, setChecking] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Already signed in (or sign-in is switched off): go straight in.
  useEffect(() => {
    api.session()
      .then((s) => { if (s.authenticated) window.location.replace(next); else setChecking(false) })
      .catch(() => setChecking(false))
  }, [next])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.login(password)
      window.location.replace(next)  // full load, so every page sees the new session cookie
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader className="items-center text-center">
        <span className="mx-auto mb-2 grid size-11 place-items-center rounded-xl text-white" style={{ background: "var(--series-1)" }}>
          <Network className="size-5" />
        </span>
        <CardTitle className="text-xl">{SITE.name}</CardTitle>
        <CardDescription>{SITE.tagline}. Enter the password to continue.</CardDescription>
      </CardHeader>
      <CardContent>
        {checking ? (
          <div className="text-muted-foreground flex justify-center py-6"><Loader2 className="size-5 animate-spin" /></div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" autoComplete="current-password" autoFocus required maxLength={200}
                     value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={Boolean(error)} />
            </div>
            {error && <p className="text-sm" role="alert" style={{ color: "var(--status-critical)" }}>{error}</p>}
            <Button type="submit" className="w-full" disabled={busy || !password}>
              {busy ? <Loader2 className="animate-spin" /> : <LockKeyhole />} Sign in
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  )
}
