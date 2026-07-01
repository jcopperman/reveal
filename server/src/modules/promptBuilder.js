/**
 * promptBuilder.js
 * -----------------------------------------------------------------------------
 * Builds the system + user prompt for the AI provider and owns the JSON schema
 * that every provider must return. This module is where the core product rule
 * is enforced at the instruction level:
 *
 *   Every conclusion must cite specific log evidence (by line ID).
 *   Unsupported conclusions must be explicitly marked as speculation.
 */

/**
 * JSON schema for the structured investigation report. Shared by:
 *  - the anthropic provider (output_config.format / messages.parse)
 *  - the mock provider (as the shape it fills in)
 *  - the report generator (as the shape it renders and validates)
 */
export const REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'summary',
    'timeline',
    'rootCause',
    'confidence',
    'unknowns',
    'bugReport',
    'reproductionSteps',
    'regressionTests',
    'loggingImprovements',
  ],
  properties: {
    summary: {
      type: 'string',
      description: 'Investigation summary in 2-4 sentences, citing evidence IDs.',
    },
    timeline: {
      type: 'array',
      description: 'Ordered events reconstructed from the evidence.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['time', 'event', 'evidence'],
        properties: {
          time: { type: 'string', description: 'Timestamp or "unknown".' },
          event: { type: 'string' },
          evidence: {
            type: 'array',
            items: { type: 'string' },
            description: 'Line IDs supporting this event, e.g. ["L142"].',
          },
        },
      },
    },
    rootCause: {
      type: 'object',
      additionalProperties: false,
      required: ['statement', 'evidence', 'isSpeculation'],
      properties: {
        statement: { type: 'string' },
        evidence: { type: 'array', items: { type: 'string' } },
        isSpeculation: {
          type: 'boolean',
          description: 'true if not fully supported by cited evidence.',
        },
      },
    },
    confidence: {
      type: 'object',
      additionalProperties: false,
      required: ['level', 'rationale'],
      properties: {
        level: { type: 'string', enum: ['high', 'medium', 'low'] },
        rationale: { type: 'string' },
      },
    },
    unknowns: {
      type: 'array',
      description: 'Open questions / missing information needed to be certain.',
      items: { type: 'string' },
    },
    bugReport: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'severity', 'description', 'evidence'],
      properties: {
        title: { type: 'string' },
        severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
        description: {
          type: 'string',
          description: 'Developer-ready description with cited evidence IDs.',
        },
        evidence: { type: 'array', items: { type: 'string' } },
      },
    },
    reproductionSteps: {
      type: 'array',
      items: { type: 'string' },
      description: 'Suggested steps to reproduce; mark assumptions as speculation.',
    },
    regressionTests: {
      type: 'array',
      items: { type: 'string' },
      description: 'Suggested regression tests that would catch this.',
    },
    loggingImprovements: {
      type: 'array',
      items: { type: 'string' },
      description: 'Suggested logging/observability improvements.',
    },
  },
};

const SYSTEM_PROMPT = `You are Reveal, a meticulous QA log investigator. You help QA engineers turn
vague issue reports and raw logs into precise, evidence-backed investigations.

NON-NEGOTIABLE RULES:
1. EVERY factual conclusion MUST cite specific log evidence by its line ID
   (for example: L142, L512). The evidence line IDs available to you are listed
   in the EVIDENCE block. Never cite an ID that is not in that block.
2. If a statement is NOT fully supported by the provided evidence, you MUST mark
   it as speculation: set "isSpeculation": true where the schema allows it, and
   begin the relevant text with "SPECULATION:".
3. Never invent log lines, timestamps, stack traces, or IDs. If the evidence is
   insufficient to determine something, say so in "unknowns" rather than guessing.
4. Prefer "low" or "medium" confidence when evidence is thin. Only use "high"
   when the cited evidence directly and unambiguously supports the root cause.
5. Distinguish correlation from causation. If two things co-occur but causation
   is not proven by the evidence, treat the causal link as speculation.

You will receive: the user's issue prompt, summary signals extracted from the
logs, and a curated EVIDENCE block of the most relevant log lines (each prefixed
with its line ID). Base your entire investigation on that evidence.

Respond ONLY with a JSON object matching the provided schema. No prose outside JSON.`;

/** Render the curated evidence entries as an ID-prefixed block. */
function renderEvidence(selected) {
  return selected
    .map((e) => {
      const meta = [
        e.timestamp || 'no-ts',
        e.level,
        e.httpStatus ? `HTTP ${e.httpStatus}` : null,
        e.requestId ? `req=${e.requestId}` : null,
      ]
        .filter(Boolean)
        .join(' ');
      // Indent multi-line (stack trace) records under their ID.
      const body = e.raw.replace(/\n/g, '\n        ');
      return `[${e.id}] (${meta}) ${body}`;
    })
    .join('\n');
}

/** Render the derived signals as a compact summary the model can lean on. */
function renderSignals(signals) {
  const lines = [];
  lines.push(`total log records: ${signals.totalEntries}`);
  lines.push(
    `levels: ${Object.entries(signals.levelCounts)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')}`,
  );
  if (signals.timespan.start)
    lines.push(`timespan: ${signals.timespan.start} .. ${signals.timespan.end}`);
  if (signals.httpErrors.length)
    lines.push(
      `HTTP errors: ${signals.httpErrors.length} (${[
        ...new Set(signals.httpErrors.map((e) => e.httpStatus)),
      ].join(', ')})`,
    );
  if (signals.repeatedExceptions.length)
    lines.push(
      `repeated: ${signals.repeatedExceptions
        .slice(0, 6)
        .map((r) => `${r.signature} x${r.count} (${r.exampleLineId})`)
        .join('; ')}`,
    );
  if (signals.timeClusters.length)
    lines.push(
      `error bursts: ${signals.timeClusters
        .map((c) => `${c.start}..${c.end} (${c.count} events)`)
        .join('; ')}`,
    );
  return lines.join('\n');
}

/**
 * @param {string} prompt         - user's investigation prompt
 * @param {object} parsed         - parseLogs() output
 * @param {Entry[]} selected      - selectEvidence().selected
 * @returns {{ system: string, user: string, availableIds: string[] }}
 */
export function buildPrompt(prompt, parsed, selected) {
  const user = `ISSUE REPORTED BY QA:
"${prompt}"

SIGNALS (auto-extracted from the logs):
${renderSignals(parsed.signals)}

EVIDENCE (the only log lines you may cite; each line begins with its ID):
${renderEvidence(selected)}

Produce the investigation as JSON matching the schema. Remember: cite evidence
IDs for every conclusion, and mark anything unsupported as speculation.`;

  return {
    system: SYSTEM_PROMPT,
    user,
    availableIds: selected.map((e) => e.id),
  };
}
