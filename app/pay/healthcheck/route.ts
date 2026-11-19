import { NextResponse } from "next/server";
import { portalMarker } from "@/lib/brands/service";

export const dynamic = "force-dynamic";

/** Used by the brand "Verify" button to confirm https://<brand site>/pay/* reaches this portal. */
export function GET() {
  return NextResponse.json({ app: "payment-portal", marker: portalMarker() }, { headers: { "Cache-Control": "no-store" } });
}
