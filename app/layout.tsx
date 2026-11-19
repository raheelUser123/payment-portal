import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Payment Portal", template: "%s · Payment Portal" },
  robots: { index: false, follow: false },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Reading headers makes every page dynamic so Next.js can attach the
  // per-request CSP nonce (set in middleware) to its scripts.
  await headers();
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
