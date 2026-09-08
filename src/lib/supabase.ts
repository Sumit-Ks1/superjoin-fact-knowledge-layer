/**
 * Supabase Storage — the only place raw PDF bytes live.
 *
 * Uploads go browser → Storage directly via a signed URL. That is not a
 * nicety: Vercel caps request bodies at 4.5 MB and the FY24 annual report in
 * the starter dataset is 6.7 MB, so routing bytes through an API route would
 * fail on the sample data itself.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { env } from "./env";
import { log } from "./logger";

let cached: SupabaseClient | undefined;

/** Service-role client. Server-only — never import this into a client component. */
export function supabaseAdmin(): SupabaseClient {
  if (!cached) {
    cached = createClient(env.supabaseUrl, env.supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return cached;
}

/** Creates the bucket on first use so a fresh project needs no manual setup. */
export async function ensureBucket(): Promise<void> {
  const client = supabaseAdmin();
  const { data } = await client.storage.getBucket(env.storageBucket);
  if (data) return;

  const options = { public: false, allowedMimeTypes: ["application/pdf"] };

  /*
   * Ask for the app's own ceiling rather than an invented one. A bucket limit
   * above `MAX_UPLOAD_BYTES` buys nothing, since the API route rejects the
   * upload first, and the two drifting apart is how you get a file that passes
   * validation and then fails at the storage layer.
   */
  let { error } = await client.storage.createBucket(env.storageBucket, {
    ...options,
    fileSizeLimit: env.maxUploadBytes,
  });

  /*
   * A project has a global upload cap of its own — 50 MB on Supabase's free
   * tier — and asking for a bucket limit above it fails the whole creation
   * with "The object exceeded the maximum allowed size". That reads like a
   * problem with the file being uploaded, which it is not: no bucket exists
   * yet. Fall back to the project's own default, which is exactly the cap we
   * were refused for exceeding.
   */
  if (error && /exceed|maximum allowed size/i.test(error.message)) {
    log.warn("bucket file-size limit refused by the project; using the project default", {
      bucket: env.storageBucket,
      requestedBytes: env.maxUploadBytes,
      detail: error.message,
    });
    ({ error } = await client.storage.createBucket(env.storageBucket, options));
  }

  // A concurrent invocation may have won the race; that is fine.
  if (error && !/already exists/i.test(error.message)) {
    throw new Error(
      `Could not create storage bucket "${env.storageBucket}": ${error.message}. ` +
        "Check Supabase → Storage → Settings for the project's upload limit, or create the bucket by hand.",
    );
  }
}

export async function createSignedUploadUrl(storagePath: string) {
  await ensureBucket();
  const { data, error } = await supabaseAdmin()
    .storage.from(env.storageBucket)
    .createSignedUploadUrl(storagePath, { upsert: true });

  if (error || !data) throw new Error(`Could not sign upload URL: ${error?.message ?? "unknown"}`);
  return { signedUrl: data.signedUrl, token: data.token, path: data.path };
}

/** Time-boxed read URL for the evidence viewer. */
export async function createSignedDownloadUrl(storagePath: string, expiresInSeconds = 3600) {
  const { data, error } = await supabaseAdmin()
    .storage.from(env.storageBucket)
    .createSignedUrl(storagePath, expiresInSeconds);

  if (error || !data) throw new Error(`Could not sign download URL: ${error?.message ?? "unknown"}`);
  return data.signedUrl;
}

/** Pulls the PDF into memory for parsing. Callers must stay inside the step budget. */
export async function downloadDocument(storagePath: string): Promise<Uint8Array> {
  const { data, error } = await supabaseAdmin().storage.from(env.storageBucket).download(storagePath);
  if (error || !data) throw new Error(`Could not download ${storagePath}: ${error?.message ?? "unknown"}`);
  return new Uint8Array(await data.arrayBuffer());
}

export async function removeDocument(storagePath: string): Promise<void> {
  await supabaseAdmin().storage.from(env.storageBucket).remove([storagePath]);
}
