import type { Metadata } from "next"

import { DataPage } from "@/components/data/data-page"

export const metadata: Metadata = { title: "Data upload" }

export default function Data() {
  return <DataPage />
}
