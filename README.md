# Fact Knowledge Layer

Extracts facts from PDFs, ties each one to the exact cell or sentence it came
from, and reports where facts agree, genuinely conflict, or only appear to
conflict until you read the context.

Next.js (parsing, extraction and orchestration all server-side) · Supabase
(Postgres + pgvector + Storage) · Inngest · deploys to Vercel with no separate
worker process.

| Doc | For |
|---|---|
| [EXPLAINER.md](EXPLAINER.md) | What it does, in plain language |
| [READING-THE-UI.md](READING-THE-UI.md) | What every label on the screens means |
| [SETUP.md](SETUP.md) | Credentials and deployment |

```bash
npm install
npm run demo -- starter-datasets/delhivery/*.pdf --pages 40
```

Runs the whole pipeline in memory — no credentials, no network, no model calls.
Deterministic, so every figure can be checked against the source PDF by hand.

---

## Approach

A number in a filing means nothing alone. `48,105.30` is a fact only once you
know it is revenue, in rupees millions, for the nine months to 31 December 2021,
consolidated, printed in a specific cell on page 17.

So the system carries that context with every number — and then uses it. **Most
figures that look like they disagree are measuring different things.** Revenue of
₹48,105m and ₹36,465m is not a contradiction when one covers nine months and the
other a full year.

That gives the governing rule:

> **Reconciliation is attempted before contradiction, always.**
> A false contradiction discredits every true finding beside it. A missed one
> costs a single finding.

The system therefore declines to conclude far more often than it concludes, and
says why each time.

---

## Architecture

```
PDF → geometry → lines → tables/blocks → chunks → facts → normalised → linked
```

| Stage | Code | What happens |
|---|---|---|
| **Extract geometry** | [`src/pdf/extract.ts`](src/pdf/extract.ts) | Positioned text runs via `unpdf`. Also validates the upload — scanned, encrypted and corrupt files are rejected with a reason. |
| **Rebuild lines** | [`src/pdf/lines.ts`](src/pdf/lines.ts) | Cluster runs onto baselines, split each line at structural gaps. |
| **Rebuild tables** | [`src/pdf/tables.ts`](src/pdf/tables.ts) | The hard part — see below. Also refuses charts. |
| **Columns & blocks** | [`src/pdf/columns.ts`](src/pdf/columns.ts), [`src/pdf/blocks.ts`](src/pdf/blocks.ts) | Reading order, headings, boilerplate removal |
| **Chunk** | [`src/pipeline/chunk.ts`](src/pipeline/chunk.ts) | Tables never split, never merged with prose. Every chunk carries its heading trail. |
| **Facts from tables** | [`src/pipeline/extract/table.ts`](src/pipeline/extract/table.ts) | Deterministic, cell by cell. No model involved. |
| **Facts from prose** | [`src/pipeline/extract/narrative.ts`](src/pipeline/extract/narrative.ts) | Model locates claims; quotes verified character-for-character. |
| **Normalise** | [`src/pipeline/normalize/`](src/pipeline/normalize/) | Units, periods, canonical text |
| **Find pairs** | [`src/pipeline/link/candidates.ts`](src/pipeline/link/candidates.ts) | Four channels, incl. the arithmetic self-audit |
| **Judge pairs** | [`src/pipeline/link/adjudicate.ts`](src/pipeline/link/adjudicate.ts) | The verdicts, and the reasoning behind each |
| **Orchestrate** | [`src/pipeline/run.ts`](src/pipeline/run.ts), [`src/inngest/functions.ts`](src/inngest/functions.ts) | Durable, resumable steps, sliced to fit a 60s function limit |

### Why table reconstruction is the hard part

`pdf.js` emits text in draw order — no rows, no columns, no cells. And financial
tables right-align their figures, so **adjacent columns overlap horizontally**.
In the Delhivery prospectus, `(17,833.04)` in the last column starts three points
to the *left* of where the previous column's figures end. No vertical whitespace
separates them anywhere on the page.

The signal that works: figures in a column share a **right edge**, and those
edges cluster cleanly even when the columns overlap. So label columns come from
whitespace, value columns come from right-edge clusters, and header cells map
onto the resulting grid where their width becomes a column span.

Verified on page 17 — a 30×6 restated P&L whose header is staggered across two
baseline sets. Every period binds to the right column, and the grid is
arithmetically self-consistent in all five.

---

## Key decisions

**No number is ever produced by a language model.** A model that reads
`49,114.06` as `49,141.06` has invented a contradiction indistinguishable from a
real one, and nothing downstream could tell them apart. Table figures are read
from the reconstructed cell. Prose figures are re-derived from a verbatim quote
by the same parser — and if the quote isn't found in the chunk
character-for-character, the fact is discarded.

**`valueBase` is the only field ever compared numerically.** ₹52,350 million and
₹5,235 crore reduce to the same number. Comparison happens at the *coarser of the
two printed precisions*, not a fixed percentage — `₹4,811 crore` claims precision
to the nearest crore, `48,105.30 million` to the nearest ten thousand rupees.

**Fiscal calendars are learned, never assumed.** FY24 ends in March for an Indian
issuer, September for the US federal government. And the year end is taken from
the *modal* "year ended" phrase, not the first one — a prospectus leads with
interim results, so the first date in the file is the wrong answer.

**A single table never contradicts itself.** Every cell in a grid measures
something different; that's what a grid is. Tables are audited internally by the
arithmetic channel instead. This one rule removed most of the false positives.

---

## Trade-offs

| Chosen | Over | Why |
|---|---|---|
| Deterministic table parsing | Vision model / OCR | Reproducible, free, auditable. Cost: months of edge cases, and it fails on scans (detected and reported). |
| Inngest | BullMQ | A queue needs a process that stays alive; Vercel has none. |
| pgvector in Postgres | Dedicated vector DB | One database, so a similarity search and a SQL filter are one query. |
| Browser → Storage upload | Upload via API | Vercel caps bodies at 4.5 MB; the sample annual report is 6.7 MB. |
| Batched stages | One pass per document | Free-tier functions stop at 60s. Slices cost seam effects at page boundaries; one pass cannot finish at all. |
| Embed slices sized to the quota window | Sized to the time limit | The free embedding quota counts input texts, not calls, at 100 a minute — so the binding constraint on that stage is the provider, not the clock. |
| Tables read back from Postgres | Re-parsing at extract time | Re-parsing put a second full parse on the critical path and was the main cause of timeouts. |
| Open `qualifiers` JSONB | Fixed columns | A document can introduce a new dimension without a migration. |
| Official SDKs | LangChain | Removed a HIGH SSRF advisory in a transitive dependency; smaller bundle; direct control over retry and fallback. |
| Refuse rather than guess | Best-effort answers | Guessing a missing scale invents a contradiction a million times too large. |

---

## AI tools used

| Where | Model | Doing what |
|---|---|---|
| Prose extraction | Gemini 2.5 Flash → Llama 3.3 70B (Groq) | Locating claims in sentences. Never producing a number. |
| Document profile | Same | Identifying the subject. Rejected if the name doesn't appear in the text. |
| Similarity | `gemini-embedding-001`, 768-dim | Matching the same measure worded differently across documents |
| Adjudication | **None** | Every verdict is deterministic and explains itself in checkable words |

All of it degrades cleanly. With no key configured, table extraction,
normalisation, and three of four linking channels still run —
[`src/ai/provider.ts`](src/ai/provider.ts) handles caching, retry with jitter,
cross-vendor fallback, and typed "unavailable" results instead of exceptions.

Development was assisted by Claude Code.

---

## The four required cases

Run the demo, or open **Findings**.

1. **Corroboration, expressed differently** — Findings → Corroborations
2. **Contradiction** — Findings → Contradictions
3. **Explained by context** — Findings → Reconciled (each names time, scope or unit)
4. **Failure found and handled** — Quality

**On (2): the system finds none in the supplied documents, and that is the
correct answer.** Earlier versions reported 32; every one was the system's own
error — a balance-sheet heading that wrapped mid-word inside a narrow column,
option counts compared against option prices, a share count compared with itself
in millions. Finding and removing them was most of the work.
[`adjudicate.test.ts`](src/pipeline/link/adjudicate.test.ts) asserts that a real
cross-document disagreement *is* reported while each artefact is not.

For (4) there are three mechanisms: **charts refused** (axis ticks caught
arithmetically — measurements don't step down a page in exactly equal amounts),
the **arithmetic self-audit** (9 of 11 printed totals confirmed by summing their
own rows), and **every refusal counted with its reason**.

---

## Known limitations

- **Prose beside an inset table** shares baselines and reconstructs badly. Bad
  cases are quarantined; partial contamination is not caught. The fix is
  re-cutting regions along column bands, noted in
  [`tables.ts`](src/pdf/tables.ts).
- **Subject inference without a model** requires an institutional word in the
  name and declines otherwise — conservative but imperfect.
- **Macro documents** state units in ways this rule set covers less well than
  corporate filings, so more of their pairs are declined for unresolved units.

---

## Testing

```bash
npm test        # 128 tests
npm run typecheck
```

Organised around failures that actually occurred, with real coordinates from real
pages: a row label emitted as one run 210 points from its first figure; a header
centred over a right-aligned column; a fiscal year end hidden behind an interim
period; a model returning a real quote beside an invented number.