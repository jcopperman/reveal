# Reveal — AI-Assisted QA Log Investigation

Reveal is a **local-first** tool that helps a QA engineer turn a vague complaint
("the site crashed this morning") plus a pile of log files into an
**evidence-backed investigation** and a **developer-ready bug report**.

It is an internal MVP / demo, not a SaaS product. It runs entirely on your
machine: logs never leave your laptop except for the small, relevant slice of
evidence that is sent to the AI model.

---

## Why it exists

QA engineers often have a strong signal that *something* is wrong but no easy way
to correlate it with what the logs actually say. Reading raw logs is slow and
error-prone. Reveal:

1. Parses logs and extracts the signals that matter.
2. Selects only the evidence relevant to the reported issue.
3. Asks an AI model to produce a structured investigation.
4. Enforces one hard rule: **every conclusion must cite specific log evidence,
   and anything unsupported is explicitly marked as speculation.**

---

## The core rule

> Every conclusion cites specific log evidence (by line reference).
> Unsupported conclusions are clearly labelled `SPECULATION`.

This is enforced in two places:

- The **prompt builder** instructs the model to cite evidence IDs (e.g. `L142`)
  for every claim and to label guesses.
- The **report generator** validates the model's output, highlights citations,
  and flags any conclusion that lacks a citation.

---

## Architecture

```
                ┌─────────────────────────────────────────────┐
   log files ──▶│  Log Parser        (structure raw lines)     │
                │  Evidence Selector (pick relevant signals)   │
   prompt ─────▶│  Prompt Builder    (evidence + citation rule)│
                │  AI Provider       (swappable: mock/anthropic)│
                │  Report Generator  (structured → Markdown)   │
                └─────────────────────────────────────────────┘
                        │                         │
                        ▼                         ▼
                   SQLite (saved            Markdown export
                   investigations)
```

- **Backend** — Node.js + Express (`server/`)
- **Frontend** — Vite + vanilla JS (`web/`)
- **Storage** — SQLite via `better-sqlite3` (saved investigations)
- **AI** — provider abstraction with two implementations:
  - `mock` — deterministic, no API key needed. **Default**, so the demo works
    offline and out of the box.
  - `anthropic` — real Claude API via the official `@anthropic-ai/sdk`.

---

## Project layout

```
reveal/
├── server/                 # Express backend
│   └── src/
│       ├── index.js               # server + API routes
│       ├── db.js                  # SQLite persistence
│       └── modules/
│           ├── logParser.js       # raw logs → structured entries + signals
│           ├── evidenceSelector.js# signals + prompt → relevant evidence
│           ├── promptBuilder.js   # evidence → AI prompt (citation rule)
│           ├── reportGenerator.js # structured report → Markdown + validation
│           └── ai/
│               ├── index.js       # provider factory (swappable)
│               ├── mockProvider.js
│               └── anthropicProvider.js
├── web/                    # Vite frontend
│   └── src/
├── samples/                # synthetic log files for the demo
├── .env.example
└── README.md
```

---

## Quick start

**Prerequisite:** Node.js **≥ 24** (recommended). Reveal uses the built-in
`node:sqlite` module, so there is no native build step and no `better-sqlite3`.
On Node 22.5–23.3 it also works but you must launch the backend with
`node --experimental-sqlite src/index.js`.

```bash
# 1. install backend deps
cd server
npm install

# 2. install frontend deps
cd ../web
npm install

# 3. (optional) enable the real AI provider
cd ..
cp .env.example .env
# edit .env: set AI_PROVIDER=anthropic and ANTHROPIC_API_KEY=sk-ant-...
# if you skip this, Reveal uses the built-in mock provider (no key required)

# 4. run both (two terminals)
cd server && npm run dev     # backend on http://localhost:8787
cd web    && npm run dev     # frontend on http://localhost:5173
```

Open http://localhost:5173.

---

## Demo flow

1. Open the app.
2. Drag in one of the sample logs from `samples/`, e.g.
   `samples/web-crash-2026-07-01.log`.
3. Type a vague prompt:
   > "My website crashed this morning but I'm not sure why."
4. Click **Investigate**.
5. Reveal shows:
   - Investigation summary
   - Event timeline
   - Likely root cause (with cited evidence)
   - Supporting log evidence (clickable line references)
   - Confidence level
   - Unknowns / missing information
   - Developer-ready bug report
   - Suggested reproduction steps
   - Suggested regression tests
   - Suggested logging improvements
6. Click **Export Markdown** to download the report for a ticket.
7. The investigation is saved to SQLite and appears in the **History** panel.

Try the other samples for different failure modes:

| Sample file | Scenario |
|---|---|
| `web-crash-2026-07-01.log` | DB connection pool exhaustion → 500s |
| `payment-timeout.log` | Upstream payment gateway timeouts → 504s |
| `mobile-api-auth.log` | Token refresh bug → cascade of 401s |

---

## How evidence selection works

Large logs never fit in a context window, so Reveal narrows them down:

1. **Parse** every line into a structured entry (timestamp, level, HTTP status,
   request/correlation ID, stack-trace grouping, exception type).
2. **Derive signals**: errors/warns/fatals, grouped stack traces, HTTP 4xx/5xx,
   repeated exceptions, and time clusters (bursts of errors).
3. **Score** each entry for relevance to the prompt using severity, HTTP status,
   membership in a stack trace or error burst, repetition, and keyword overlap
   with the user's prompt.
4. **Select** the top-scoring entries within a character budget, always keeping
   full stack traces intact and preserving stable line IDs (`L142`) so the model
   — and the reader — can cite them.

Only this selected slice is sent to the AI provider.

---

## Verify the pipeline (no browser, no API key)

```bash
cd server
npm run smoke
```

This runs the full parse → select → build-prompt → (mock) investigate → validate
→ render pipeline against all three sample logs and asserts that every cited
evidence ID actually exists and no conclusion is left unsupported. It prints one
full Markdown report so you can eyeball the output.

---

## Configuration

See `.env.example`. Key variables:

| Variable | Default | Meaning |
|---|---|---|
| `AI_PROVIDER` | `mock` | `mock` or `anthropic` |
| `ANTHROPIC_API_KEY` | — | required when `AI_PROVIDER=anthropic` |
| `ANTHROPIC_MODEL` | `claude-opus-4-8` | model id |
| `PORT` | `8787` | backend port |
| `EVIDENCE_CHAR_BUDGET` | `12000` | max characters of evidence sent to AI |

---

## Notes / non-goals

- This is optimised for **clarity and demoability**, not production hardening.
- No auth, no multi-tenant, no cloud storage. Everything is local.
- The mock provider produces a plausible, deterministic report derived from the
  actual parsed signals so the demo is meaningful without an API key.
