# CLAUDE.md — Reveal

Guidance for working in this repo. Reveal is a **local-first, AI-assisted QA log
investigation tool**: a QA engineer uploads logs + a vague prompt and gets an
evidence-backed investigation and developer-ready bug report. It is an internal
MVP/demo — **prioritise clarity and demoability over production architecture.**

## The one rule that must never be broken

> **Every conclusion must cite specific log evidence (by line ID, e.g. `L142`).
> Anything not supported by the evidence must be marked `SPECULATION`.**

This is the product. It is enforced in two independent places — keep both:
1. `server/src/modules/promptBuilder.js` — instructs the model to cite IDs / flag speculation.
2. `server/src/modules/reportGenerator.js` → `validateReport()` — checks that every
   cited ID actually exists in the provided evidence and that no conclusion is
   left unsupported. Never let a change bypass this validation.

Line IDs (`L<startLine>`) are assigned by the parser and must stay stable through
selection, prompting, rendering, and the UI's clickable references.

## Run / verify

- Backend: `cd server && npm run dev` (http://localhost:8787)
- Frontend: `cd web && npm run dev` (http://localhost:5173, proxies `/api`)
- **Pipeline test (fast, offline, no key): `cd server && npm run smoke`** — asserts
  no fabricated evidence IDs and no unsupported conclusions across all three sample
  logs. It runs **automatically at the end of a turn** via the `Stop` hook in
  `.claude/settings.json` (`.claude/hooks/smoke-check.mjs`): if it fails, the turn
  is blocked and the failure is fed back to be fixed. Running once per turn (not
  per edit) means multi-file changes are checked in their finished state, not mid-refactor.

## Architecture (data flow)

```
parseLogs → selectEvidence → buildPrompt → provider.investigate → validateReport → toMarkdown
```

- `logParser.js` — heuristic, format-tolerant. Never throw on an unrecognised
  line; degrade to a low-signal entry. Emits `entries` + derived `signals`
  (errors/warns/fatals, stack traces, HTTP 4xx/5xx, repeated exceptions, time clusters).
- `evidenceSelector.js` — transparent, rule-based scoring within a **char budget**
  (`EVIDENCE_CHAR_BUDGET`, default 12000). Keep it explainable; a QA engineer must
  be able to see *why* a line was selected (`_reasons`). Only this slice goes to the AI.
- `ai/` — **swappable provider** behind `createProvider()`. The interface is
  `investigate({ system, user, availableIds, parsed, selected, prompt }) → report`.
  - `mockProvider.js` is the **default** and must stay fully offline + deterministic
    and derive a genuinely evidence-cited report from real signals — the demo runs
    with no API key.
  - `anthropicProvider.js` is the real Claude path; only used when
    `AI_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` is set.
- `reportGenerator.js` — renders Markdown + validates the citation rule.
- Report shape is defined once as `REPORT_SCHEMA` in `promptBuilder.js`; all
  providers fill it and the renderer/validator consume it. Change it in one place.

## Conventions & decisions (non-obvious)

- **Storage is `node:sqlite` (built-in), NOT `better-sqlite3`.** This machine has
  no Visual Studio, so native builds fail. Requires Node ≥ 24 (or 22.5–23.3 with
  `--experimental-sqlite`). Do not reintroduce a native-compiled DB dependency.
- **Claude usage** (when editing `anthropicProvider.js`): official `@anthropic-ai/sdk`,
  model `claude-opus-4-8`, adaptive thinking (`thinking: { type: 'adaptive' }`),
  streaming + `.finalMessage()`. **Never hardcode the API key** — read from env.
  Never mix the SDK with raw HTTP.
- ESM everywhere (`"type": "module"`), plain JS (no TypeScript, no build step for
  the backend), vanilla-JS frontend (only deps: `vite`, `marked`).
- Keep new sample logs in `samples/` realistic: real timestamps, levels, request/
  correlation IDs, HTTP statuses, stack traces, and a repeated signature or burst
  so the parser and selector have something to find. Update `scripts/smoke.js`
  cases when adding one.
- The DB lives in `server/data/` and is gitignored. Safe to delete to reset.

## When adding a feature

1. If it changes the report, update `REPORT_SCHEMA` first, then mock provider,
   renderer, and validator together.
2. Run `npm run smoke` and confirm it still passes with zero citation warnings.
3. Prefer clarity over cleverness — this is a demo people read to understand the idea.
