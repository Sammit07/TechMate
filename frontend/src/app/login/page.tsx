import type { Metadata } from "next"
import { Suspense } from "react"

import { LoginForm } from "@/components/auth/login-form"

export const metadata: Metadata = { title: "Sign in" }

export default function LoginPage() {
  return (
    <div className="grid min-h-svh place-items-center px-4 py-10">
      {/* ?next= comes from the URL (useSearchParams): request-time data, needs Suspense. */}
      <Suspense>
        <LoginForm />
      </Suspense>
    </div>
  )
}
