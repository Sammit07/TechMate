import { AppSidebar, MobileHeader } from "@/components/app-sidebar"

/** Signed-in app: sidebar navigation (with workspace switcher) around every page. */
export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <>
      <AppSidebar />
      <div className="min-w-0 md:pl-60">
        <MobileHeader />
        <main className="mx-auto w-full max-w-7xl px-4 py-6 md:px-8">{children}</main>
      </div>
    </>
  )
}
