"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard, FileText, CreditCard, Users, Building2, Store, Landmark, UserCog, KeyRound, Webhook,
  Inbox, Activity, ShieldAlert, Bell, Settings, UserCircle,
} from "lucide-react";

const NAV = [
  { section: "Payments", items: [
    { href: "/admin", label: "Dashboard", icon: LayoutDashboard, exact: true },
    { href: "/admin/invoices", label: "Invoices", icon: FileText },
    { href: "/admin/payments", label: "Payments", icon: CreditCard },
    { href: "/admin/customers", label: "Customers", icon: Users },
    { href: "/admin/inquiries", label: "Inquiries", icon: Inbox },
  ] },
  { section: "Configuration", admin: true, items: [
    { href: "/admin/brands", label: "Brands", icon: Store },
    { href: "/admin/merchants", label: "Merchants", icon: Landmark },
    { href: "/admin/users", label: "Users", icon: UserCog },
    { href: "/admin/departments", label: "Departments", icon: Building2 },
    { href: "/admin/api-keys", label: "API keys", icon: KeyRound },
    { href: "/admin/webhooks", label: "Webhooks", icon: Webhook },
    { href: "/admin/settings", label: "Settings", icon: Settings },
  ] },
  { section: "Security", items: [
    { href: "/admin/alerts", label: "Alerts", icon: Bell, admin: true },
    { href: "/admin/audit", label: "Audit log", icon: ShieldAlert, admin: true },
    { href: "/admin/activity", label: "Activity", icon: Activity },
    { href: "/admin/account", label: "My account", icon: UserCircle },
  ] },
];

export function Nav({ role, openAlerts }: { role: "admin" | "seller"; openAlerts: number }) {
  const path = usePathname();
  return (
    <nav className="space-y-6">
      {NAV.filter((s) => !s.admin || role === "admin").map((s) => (
        <div key={s.section}>
          <p className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">{s.section}</p>
          <ul className="space-y-0.5">
            {s.items.filter((i) => !("admin" in i && i.admin) || role === "admin").map((i) => {
              const active = "exact" in i && i.exact ? path === i.href : path === i.href || path.startsWith(i.href + "/");
              const Icon = i.icon;
              return (
                <li key={i.href}>
                  <Link href={i.href} className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition ${active ? "bg-white/10 font-medium text-white" : "text-slate-300 hover:bg-white/5 hover:text-white"}`}>
                    <Icon size={16} />
                    <span className="flex-1">{i.label}</span>
                    {i.href === "/admin/alerts" && openAlerts > 0 && (
                      <span className="rounded-full bg-rose-500 px-1.5 text-[11px] font-semibold text-white">{openAlerts > 99 ? "99+" : openAlerts}</span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
