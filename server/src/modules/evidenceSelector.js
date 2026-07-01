/**
 * evidenceSelector.js
 * -----------------------------------------------------------------------------
 * Given parsed entries + signals and the user's natural-language prompt, choose
 * the slice of log evidence most relevant to the reported issue, within a
 * character budget. Only this slice is sent to the AI model.
 *
 * Selection is transparent and rule-based so a QA engineer can trust (and we
 * can explain) why a line was included:
 *
 *   score = severity weight
 *         + HTTP-error weight
 *         + stack-trace weight
 *         + repeated-signature weight
 *         + time-cluster membership weight
 *         + keyword overlap with the prompt
 *
 * We always keep full stack traces intact and preserve stable line IDs so the
 * model — and the reader — can cite them (e.g. "L142").
 */

import { _internals } from './logParser.js';

const { LEVEL_SEVERITY } = _internals;

// Words that carry no discriminating signal when matching a prompt to logs.
const STOPWORDS = new Set(
  `the a an and or but not is are was were be been being to of in on at for with my our your this
   that it its i im dont don't cant can't why what when how happened happening something anything
   morning today yesterday website site app application server`.split(/\s+/),
);

function promptKeywords(prompt) {
  return [
    ...new Set(
      prompt
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
    ),
  ];
}

/**
 * @param {object} parsed        - output of parseLogs()
 * @param {string} prompt        - user's investigation prompt
 * @param {object} [opts]
 * @param {number} [opts.charBudget=12000]
 * @returns {{ selected: Entry[], keywords: string[], stats: object }}
 */
export function selectEvidence(parsed, prompt, opts = {}) {
  const charBudget = opts.charBudget ?? 12000;
  const { entries, signals } = parsed;
  const keywords = promptKeywords(prompt);

  const clusterLineIds = new Set(signals.timeClusters.flatMap((c) => c.lineIds));
  const repeatedSigExamples = new Set(signals.repeatedExceptions.map((r) => r.exampleLineId));

  const scored = entries.map((e) => {
    let score = 0;
    const reasons = [];

    const sev = LEVEL_SEVERITY[e.level] ?? 0;
    if (sev >= 3) {
      score += sev * 3; // FATAL 15, ERROR 12, WARN 9
      reasons.push(`${e.level}`);
    }

    if (e.httpStatus >= 500) {
      score += 10;
      reasons.push(`HTTP ${e.httpStatus}`);
    } else if (e.httpStatus >= 400) {
      score += 6;
      reasons.push(`HTTP ${e.httpStatus}`);
    }

    if (e.isStackTrace) {
      score += 8;
      reasons.push('stack trace');
    }

    if (e.exceptionType) {
      score += 4;
      reasons.push(e.exceptionType);
    }

    if (clusterLineIds.has(e.id)) {
      score += 5;
      reasons.push('error burst');
    }

    if (repeatedSigExamples.has(e.id)) {
      score += 4;
      reasons.push('repeated');
    }

    // Keyword overlap with the prompt.
    const hay = e.raw.toLowerCase();
    let hits = 0;
    for (const kw of keywords) {
      if (hay.includes(kw)) hits++;
    }
    if (hits) {
      score += hits * 4;
      reasons.push(`prompt match x${hits}`);
    }

    return { entry: e, score, reasons };
  });

  // Highest score first; break ties by recency (later line first) so we favour
  // the tail of a run where crashes usually surface.
  scored.sort((a, b) => b.score - a.score || b.entry.lineStart - a.entry.lineStart);

  const selected = [];
  let usedChars = 0;
  for (const s of scored) {
    if (s.score <= 0) continue; // ignore pure noise (plain INFO/DEBUG, no match)
    const cost = s.entry.raw.length + 40; // + room for the ID/level annotation
    if (usedChars + cost > charBudget) continue;
    usedChars += cost;
    selected.push({ ...s.entry, _score: s.score, _reasons: s.reasons });
  }

  // If nothing scored (e.g. an all-INFO log with no prompt overlap), fall back
  // to the most severe / most recent lines so the model still has something.
  if (selected.length === 0) {
    const fallback = [...entries]
      .sort(
        (a, b) =>
          (LEVEL_SEVERITY[b.level] ?? 0) - (LEVEL_SEVERITY[a.level] ?? 0) ||
          b.lineStart - a.lineStart,
      )
      .slice(0, 25);
    for (const e of fallback) {
      const cost = e.raw.length + 40;
      if (usedChars + cost > charBudget) break;
      usedChars += cost;
      selected.push({ ...e, _score: 0, _reasons: ['fallback'] });
    }
  }

  // Present in chronological order (by line) so the timeline reads naturally.
  selected.sort((a, b) => a.lineStart - b.lineStart);

  return {
    selected,
    keywords,
    stats: {
      totalEntries: entries.length,
      selectedCount: selected.length,
      usedChars,
      charBudget,
      truncated: usedChars >= charBudget,
    },
  };
}
