/**
 * reportGenerator.js
 * -----------------------------------------------------------------------------
 * Takes the structured report object (from any AI provider) and:
 *   1. VALIDATES the core rule — every conclusion must cite evidence that
 *      actually exists; unsupported conclusions must be flagged as speculation.
 *   2. RENDERS a clean Markdown document suitable for pasting into a ticket.
 *
 * Validation never rejects a report; it annotates it with warnings so the UI
 * can surface where the model failed to cite evidence. This keeps the tool
 * honest without breaking the demo.
 */

/**
 * @param {object} report        - structured report (REPORT_SCHEMA shape)
 * @param {string[]} availableIds- evidence IDs that were actually provided
 * @returns {{ warnings: string[], citedIds: string[], unknownIds: string[] }}
 */
export function validateReport(report, availableIds) {
  const available = new Set(availableIds);
  const warnings = [];
  const cited = new Set();
  const unknown = new Set();

  const checkIds = (ids, where) => {
    for (const id of ids || []) {
      cited.add(id);
      if (!available.has(id)) {
        unknown.add(id);
        warnings.push(`${where} cites ${id}, which is not in the provided evidence.`);
      }
    }
  };

  // Root cause must either cite evidence or be marked speculation.
  if (report.rootCause) {
    checkIds(report.rootCause.evidence, 'Root cause');
    if (
      (!report.rootCause.evidence || report.rootCause.evidence.length === 0) &&
      !report.rootCause.isSpeculation
    ) {
      warnings.push('Root cause has no cited evidence but is not marked as speculation.');
    }
  }

  // Timeline events should cite evidence.
  (report.timeline || []).forEach((ev, i) => {
    checkIds(ev.evidence, `Timeline event #${i + 1}`);
    if (!ev.evidence || ev.evidence.length === 0) {
      warnings.push(`Timeline event #${i + 1} ("${truncate(ev.event, 50)}") cites no evidence.`);
    }
  });

  // Bug report should cite evidence.
  if (report.bugReport) {
    checkIds(report.bugReport.evidence, 'Bug report');
    if (!report.bugReport.evidence || report.bugReport.evidence.length === 0) {
      warnings.push('Bug report cites no evidence.');
    }
  }

  return {
    warnings,
    citedIds: [...cited],
    unknownIds: [...unknown],
  };
}

/** Render the structured report to Markdown. */
export function toMarkdown(report, meta = {}) {
  const L = [];
  const evi = (ids) => (ids && ids.length ? ` _(evidence: ${ids.join(', ')})_` : '');

  L.push(`# Investigation Report`);
  if (meta.prompt) L.push(`\n> **Reported issue:** ${meta.prompt}`);
  const bits = [];
  if (meta.files?.length) bits.push(`**Logs:** ${meta.files.join(', ')}`);
  if (meta.provider) bits.push(`**AI provider:** ${meta.provider}`);
  if (meta.createdAt) bits.push(`**Generated:** ${meta.createdAt}`);
  if (bits.length) L.push(`\n${bits.join(' · ')}`);

  L.push(`\n## Summary\n${report.summary || '_none_'}`);

  L.push(`\n## Confidence`);
  if (report.confidence) {
    L.push(`**${report.confidence.level?.toUpperCase() || 'UNKNOWN'}** — ${report.confidence.rationale || ''}`);
  }

  L.push(`\n## Likely Root Cause`);
  if (report.rootCause) {
    const flag = report.rootCause.isSpeculation ? '⚠️ **SPECULATION** — ' : '';
    L.push(`${flag}${report.rootCause.statement}${evi(report.rootCause.evidence)}`);
  }

  L.push(`\n## Event Timeline`);
  if (report.timeline?.length) {
    for (const ev of report.timeline) {
      L.push(`- \`${ev.time || 'unknown'}\` — ${ev.event}${evi(ev.evidence)}`);
    }
  } else {
    L.push('_No timeline reconstructed._');
  }

  L.push(`\n## Developer-Ready Bug Report`);
  if (report.bugReport) {
    L.push(`**${report.bugReport.title}**`);
    L.push(`\n- **Severity:** ${report.bugReport.severity}`);
    L.push(`- **Details:** ${report.bugReport.description}${evi(report.bugReport.evidence)}`);
  }

  L.push(`\n## Suggested Reproduction Steps`);
  L.push(numbered(report.reproductionSteps));

  L.push(`\n## Suggested Regression Tests`);
  L.push(bullets(report.regressionTests));

  L.push(`\n## Suggested Logging Improvements`);
  L.push(bullets(report.loggingImprovements));

  L.push(`\n## Unknowns / Missing Information`);
  L.push(bullets(report.unknowns));

  if (meta.validation?.warnings?.length) {
    L.push(`\n## ⚠️ Evidence-Citation Warnings`);
    L.push(
      '_These are places where the investigation did not fully satisfy the "cite evidence or mark as speculation" rule:_',
    );
    L.push(bullets(meta.validation.warnings));
  }

  return L.join('\n');
}

// --- helpers -----------------------------------------------------------------
function bullets(arr) {
  if (!arr || !arr.length) return '_none_';
  return arr.map((x) => `- ${x}`).join('\n');
}
function numbered(arr) {
  if (!arr || !arr.length) return '_none_';
  return arr.map((x, i) => `${i + 1}. ${x}`).join('\n');
}
function truncate(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
