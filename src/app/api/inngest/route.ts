/**
 * Inngest's HTTP endpoint.
 *
 * Inngest calls back into this route to run each step, which is what lets a
 * multi-minute pipeline execute as a series of short serverless invocations.
 */
import { serve } from "inngest/next";

import { inngest } from "@/inngest/client";
import { functions } from "@/inngest/functions";

export const { GET, POST, PUT } = serve({ client: inngest, functions });

// Steps do real work — parsing, extracting, embedding — so the route needs the
// Node runtime and the longest execution window the platform allows.
export const runtime = "nodejs";
export const maxDuration = 300;
