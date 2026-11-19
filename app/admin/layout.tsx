import { requireUser } from "@/lib/auth/guard";
import { sql } from "@/lib/db";
import { Nav } from "./nav";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const s = await requireUser();
  const [{ n }] = s.user.role === "admin"
    ? await sql<{ n: number }[]>`select count(*)::int as n from alerts where acknowledged_at is null and severity <> 'info'`
    : [{ n: 0 }];
  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col overflow-y-auto bg-slate-900 px-3 py-5 lg:flex">
        <div className="mb-6 flex items-center gap-2 px-3 text-white">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-500 text-sm font-bold">P</span>
          <span className="font-semibold">Payment Portal</span>
        </div>
        <Nav role={s.user.role} openAlerts={n} />
        <div className="mt-auto border-t border-white/10 px-3 pt-4 text-xs text-slate-400">
          <p className="truncate font-medium text-slate-200">{s.user.name}</p>
          <p className="truncate">{s.user.email}</p>
          <p className="mt-1 capitalize">{s.user.role}</p>
          <form action="/logout" method="post" className="mt-3">
            <button className="text-slate-300 underline hover:text-white">Sign out</button>
          </form>
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3 lg:hidden">
          <span className="font-semibold">Payment Portal</span>
          <details className="relative">
            <summary className="btn-secondary cursor-pointer list-none">Menu</summary>
            <div className="absolute right-0 z-20 mt-2 w-64 rounded-xl bg-slate-900 p-3 shadow-xl"><Nav role={s.user.role} openAlerts={n} /></div>
          </details>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</main>
      </div>
    </div>
  );
}
