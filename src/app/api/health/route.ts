/**
 * Configuration preflight.
 *
 * Reports every problem at once rather than failing on the first, so a
 * half-configured deployment can be fixed in one pass instead of five.
 */
import { NextResponse } from "next/server";

import { checkConfiguration } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const config = checkConfiguration();
  // 503 only when something *required* is missing. A deployment running without
  // a model key is degraded, not unhealthy, and `complete` says which it is.
  return NextResponse.json(config, { status: config.ok ? 200 : 503 });
}
