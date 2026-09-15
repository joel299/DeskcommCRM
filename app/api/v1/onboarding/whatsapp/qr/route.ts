import { NextResponse } from "next/server";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";

/** QR de onboarding é provido pelo fluxo oficial Ryze; WAHA não participa. */
export async function GET() {
  const user = await loadAuthUser();
  if (!user) return new NextResponse(null, { status: 401 });
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) return new NextResponse(null, { status: 404 });
  return new NextResponse(null, { status: 503, headers: { "x-channel-provider": "ryze" } });
}
