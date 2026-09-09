# What this project is, in plain terms

A non-technical walkthrough of what the assignment asked for, what was built, and
exactly what happens when someone uploads a PDF.

Written to be read on its own — no prior knowledge assumed, and enough detail to
explain the project to someone else.

**Companion document:** [READING-THE-UI.md](READING-THE-UI.md) explains what
every label on the screens means.

---

# Part 1 — What was asked

## The problem

Imagine you have three documents about the same company: a stock-market filing, an
annual report, and a results presentation. Each contains hundreds of numbers.
Somewhere in there, two of them might **disagree** — and that disagreement matters
enormously, but no human is going to find it by reading 300 pages three times.

The assignment asked for a system that:

1. **Pulls meaningful facts out of PDFs** — not just text, but actual claims like
   "revenue was ₹48,105.30 million"
2. **Proves where each fact came from** — the exact page and the exact words
3. **Works out how facts relate** — do they agree, genuinely conflict, or only
   *look* like they conflict?

That third point is the whole assignment. Anyone can extract numbers. The hard
question is what two numbers *mean* when placed side by side.

## Why this is much harder than it sounds

### A PDF is a picture, not a spreadsheet

When a person looks at a financial table, they see rows and columns. A computer
opening that same PDF sees something like:

> *"the text `48,105.30` is at position x=204, y=654"*

That's it. No rows. No columns. No idea which heading belongs to which number. The
table has to be **rebuilt from scratch** using nothing but where things sit on the
page.

### A number alone means nothing

`48,105.30` — of what? Rupees? Dollars? Thousands or millions? For which year? The
whole company or one division?

Every one of those answers lives somewhere *else* on the page — in a heading
above, a caption to the side, a footnote below.

### Most disagreements aren't disagreements

This is the key insight.

If one document says revenue was ₹48,105 million and another says ₹36,465
million, that looks like a contradiction. It isn't. The first covers *nine
months*, the second covers *a full year*. Both are true.

> Think of two people saying "I earn ₹50,000" and "I earn ₹6,00,000."
> Not a contradiction — one means per month, one means per year.

This is why the system's most important rule is:

> **Always try to explain a difference before calling it a conflict.**

A false accusation is worse than a missed one, because it makes you distrust every
other finding on the screen.

---

# Part 2 — What happens when you upload a PDF

Nine stages. You click upload; everything else is automatic.

### Stage 1 — Your browser, before anything is sent

The file is **fingerprinted** (a hash — a short code unique to those exact bytes).

This is how re-uploading the same document is recognised as the same document
rather than processed twice.

### Stage 2 — Reserving a slot

The browser asks the server for permission to upload. The server creates a
database record and hands back a **temporary signed link** to the storage service.

> **Why not just send the file to the server?**
> The hosting platform rejects any upload over 4.5 MB, and the sample annual
> report is 6.7 MB. So the file goes **browser → storage directly**, never through
> the server.

### Stage 3 — Upload, then a starting gun

The browser uploads to that link, then tells the server "it's there, start work."
The server hands the job to **Inngest** — a service that runs long jobs as a
series of short, resumable steps.

> **Why?**
> The hosting platform kills anything running longer than about a minute. This job
> takes several. Inngest breaks it into steps that each finish quickly, and
> remembers where it got to — so if a step fails, it resumes rather than starting
> over.

### Stage 4 — Is this file even usable?

Before any real work: is it actually a PDF? Password-protected? A **scan** (a
photo of pages, with no real text)?

A scanned document is rejected with a clear message. This matters — otherwise a
scan would silently produce zero facts and look identical to a document that
simply had nothing to say.

### Stage 5 — Rebuilding the pages *(the hardest part)*

Every scrap of text is read with its position, then:

- **Text is grouped into lines** by which ones sit at the same height.
- **Repeated headers and footers are removed** — "Delhivery Limited | Annual
  Report | 42" on every page isn't a fact.
- **Tables are rebuilt.** Financial tables right-align their numbers, and columns
  often *overlap* — in the real filing, a number in the last column starts to the
  *left* of where the previous column's numbers end. There's no white gap to split
  on anywhere. The trick that works: numbers in a column share a **right edge**,
  and those edges cluster cleanly even when the columns overlap.
- **Charts are rejected.** A chart's y-axis labels (12, 10, 8, 6, 4, 2, 0) look
  exactly like a one-column table. They're caught by arithmetic — real
  measurements don't step down a page in perfectly equal amounts.
- **The document is asked who it's about** and when its financial year ends —
  *learned from the document*, never assumed.

### Stage 6 — Cutting it into readable pieces

Text is grouped into passages. A table is **never** split — half a table isn't a
smaller table, it's a broken one.

Every passage carries its heading trail, because "revenue grew 25%" is useless
alone but meaningful under *Our Business ▸ Express Parcel*.

### Stage 7 — Turning content into facts

Two different methods, deliberately:

**From tables — by pure calculation, no AI.** Each cell is read directly. The row
label says *what*, the column heading says *when*, the caption says *what units*.

> **No number in this system is ever produced by an AI.**
> If an AI misreads 49,114.06 as 49,141.06, it has invented a contradiction that
> looks *exactly* like a real one — and nothing downstream could ever tell them
> apart.

**From prose — AI, but on a very short leash.** For sentences, an AI finds the
claims. But it must return a **word-for-word quote**. If that quote isn't found in
the original text character-for-character, the fact is thrown away. And the number
is then re-read from the quote by the same calculator the tables use — never taken
from the AI's output.

### Stage 8 — Making numbers comparable

Every figure is converted to one common form:

| Written as | Becomes |
|---|---|
| ₹52,350 million | 52,350,000,000 rupees |
| ₹5,235 crore | 52,350,000,000 rupees |

Now they're visibly identical.

Periods get the same treatment — "nine months ended December 2021" becomes an
actual date range, so the system can tell it sits *inside* a financial year rather
than being equal to it.

Two things it deliberately **refuses**:

- **Converting currencies** — that needs an exchange rate for a specific date.
- **Guessing a missing scale** — guess wrong and you've invented a contradiction a
  million times too big.

### Stage 9 — Comparing everything

The system finds pairs worth comparing — same measure, or similar wording, or
components that should add up to a total — and asks a fixed sequence of questions:

1. Same thing being measured? Same units? Same time period?
2. Different periods? → **explained by time**
3. Different scope (consolidated vs standalone)? → **explained by scope**
4. One marked "restated" and the other "provisional"? → **one supersedes the other**
5. Only if *nothing* explains it → **genuine contradiction**

Reconciliation always comes before contradiction.

It also **audits itself**: every printed total is checked against the rows above
it. When "Total expenses" equals the sum of its 8 rows exactly, that confirms the
entire column was read correctly — the column detection, the minus signs, and the
units, all at once.

---

# The four things it had to demonstrate

| | Example from the real documents |
|---|---|
| **Agreement, worded differently** | ₹52,350 million and ₹5,235 crore recognised as the same amount |
| **A real contradiction** | **None found — and that's the correct answer.** See below. |
| **A false alarm explained** | Revenue of ₹74,540m vs ₹81,415m for the same year — one is the parent company alone, the other includes subsidiaries |
| **Failures found and handled** | Charts refused; 9 of 11 totals verified by addition; every refusal logged with its reason |

## On finding no contradictions

Earlier versions reported 32. **Every single one was a mistake by the system
itself**, and finding them was most of the work:

- A balance sheet listed "Investments" twice — once under current assets, once
  under non-current. The heading separating them was in a column so narrow the
  words wrapped mid-word.
- A stock-options table had option *counts* in one column and *prices* in the
  next. Comparing across them is meaningless.
- A share count appeared as `728,715,149` in one place and `728.72 million` in
  another — the same number. A stray `%` from a neighbouring column had been
  picked up.

The fix that removed most of them is a principle worth stating:

> **A single table never contradicts itself.**
> Every cell in a grid measures something different — that's what a grid *is*.
> Tables are checked internally by addition instead.

Three filings from one company agreeing with each other is the honest result. The
detector works; it's proven by tests that show a real cross-document disagreement
*is* caught while each of those artefacts is not.

---

# If you're challenged on it

**"Why not just use AI for everything?"**
Because an AI that misreads one digit fabricates a contradiction indistinguishable
from a real one. Numbers come from arithmetic; AI is used only to *locate* claims
in prose, and its quotes are verified word-for-word.

**"Why did it find no contradictions?"**
Because those documents genuinely agree. It found 32 and proved all 32 were its
own errors. Reporting zero honestly is worth more than reporting 32 falsely.

**"How do I know a fact is real?"**
Click it. You get the page, the exact words, and the table cell.

**"What if it gets something wrong?"**
There's a Quality screen listing everything it refused to do and why. A system
that only shows its successes can't be checked.
