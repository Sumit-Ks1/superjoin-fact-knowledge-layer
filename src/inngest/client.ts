/**
 * Inngest client and event contract.
 *
 * Inngest is here because the work does not fit the request/response shape a
 * serverless platform gives you. Parsing a 300-page filing, extracting from
 * several hundred chunks and then linking a whole corpus takes minutes, while
 * a Vercel function is killed after seconds. Inngest turns that into a sequence
 * of short, individually retryable steps with durable state between them — and
 * it does so without a process to keep running, which a queue like BullMQ would
 * have required and which Vercel cannot host.
 */

import { EventSchemas, Inngest } from "inngest";

type Events = {
  /** A PDF has landed in storage and its row exists. */
  "document/uploaded": {
    data: { documentId: string; corpusId: string };
  };
  /**
   * Re-link a corpus without re-parsing anything.
   *
   * Linking is corpus-wide, so adding one document changes findings for all of
   * them; this is what lets the second upload discover a disagreement with the
   * first.
   */
  "corpus/link-requested": {
    data: { corpusId: string; documentIds: string[] };
  };
};

export const inngest = new Inngest({
  id: "fact-knowledge-layer",
  schemas: new EventSchemas().fromRecord<Events>(),
});

export type { Events };
