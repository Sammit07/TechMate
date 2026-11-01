/** Where an article's original file is served (behind sign-in): uploads, or the standard KB's PDFs. */
export const kbPdfUrl = (fileName: string, fileUrl?: string | null) =>
  fileUrl || `/api/files/catalog/${encodeURIComponent(fileName)}`

export function formatHours(hours: number | null | undefined): string {
  if (hours == null) return "–"
  if (hours < 1) return `${Math.round(hours * 60)} min`
  if (hours < 48) return `${hours.toFixed(1)} h`
  return `${(hours / 24).toFixed(1)} d`
}

export function formatMinutes(minutes: number | null | undefined): string {
  return minutes == null ? "–" : formatHours(minutes / 60)
}

/** "2026-10-28 09:13:26" -> "28 Oct, 09:13" */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "–"
  const [d, t] = value.split(" ")
  const [y, m, day] = d.split("-").map(Number)
  const month = new Date(y, m - 1, day).toLocaleString("en-GB", { month: "short" })
  return `${day} ${month}${t ? `, ${t.slice(0, 5)}` : ""}`
}

/** "2026-10-28" -> "Wed 28 Oct" */
export function formatDay(value: string, withWeekday = true): string {
  const [y, m, d] = value.split("-").map(Number)
  return new Date(y, m - 1, d).toLocaleDateString("en-GB",
    withWeekday ? { weekday: "short", day: "numeric", month: "short" } : { day: "numeric", month: "short" })
}

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
