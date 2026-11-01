import type { Metadata } from "next"

import { Forecast } from "@/components/forecast/forecast"

export const metadata: Metadata = { title: "Forecast" }

export default function ForecastPage() {
  return <Forecast />
}
