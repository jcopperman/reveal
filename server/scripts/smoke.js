/**
 * Standalone pipeline smoke test (no server, no DB, mock provider).
 * Run: node scripts/smoke.js
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseLogs } from '../src/modules/logParser.js';
import { selectEvidence } from '../src/modules/evidenceSelector.js';
import { buildPrompt } from '../src/modules/promptBuilder.js';
import { createMockProvider } from '../src/modules/ai/mockProvider.js';
import { toMarkdown, validateReport } from '../src/modules/reportGenerator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const samples = join(__dirname, '..', '..', 'samples');

const cases = [
  ['web-crash-2026-07-01.log', 'My website crashed this morning but I am not sure why.'],
  ['payment-timeout.log', 'Customers report checkout payments failing this afternoon.'],
  ['mobile-api-auth.log', 'Mobile users keep getting logged out unexpectedly.'],
];

let failures = 0;

for (const [file, prompt] of cases) {
  const content = readFileSync(join(samples, file), 'utf8');
  const parsed = parseLogs([{ filename: file, content }]);
  const { selected, stats } = selectEvidence(parsed, prompt, { charBudget: 12000 });
  const bundle = buildPrompt(prompt, parsed, selected);

  const provider = createMockProvider();
  const report = await provider.investigate({ ...bundle, parsed, selected, prompt });
  const validation = validateReport(report, bundle.availableIds);

  console.log('\n' + '='.repeat(78));
  console.log(`FILE: ${file}`);
  console.log(`PROMPT: ${prompt}`);
  console.log(
    `signals: entries=${parsed.signals.totalEntries} errors=${parsed.signals.errors.length} ` +
      `fatals=${parsed.signals.fatals.length} httpErr=${parsed.signals.httpErrors.length} ` +
      `stacks=${parsed.signals.stackTraces.length} repeated=${parsed.signals.repeatedExceptions.length} ` +
      `clusters=${parsed.signals.timeClusters.length}`,
  );
  console.log(`selected: ${stats.selectedCount}/${stats.totalEntries} records, ${stats.usedChars} chars`);
  console.log(`root cause: ${report.rootCause.statement.slice(0, 120)}`);
  console.log(`confidence: ${report.confidence.level}`);
  console.log(`citations valid? ${validation.unknownIds.length === 0 ? 'YES' : 'NO -> ' + validation.unknownIds}`);
  console.log(`citation warnings: ${validation.warnings.length}`);

  // Assertions
  if (validation.unknownIds.length) {
    console.error('  !! FAIL: report cited evidence IDs not in the provided set');
    failures++;
  }
  if (!report.rootCause.evidence.length && !report.rootCause.isSpeculation) {
    console.error('  !! FAIL: root cause has no evidence and is not marked speculation');
    failures++;
  }
  if (!report.summary || !report.bugReport?.title) {
    console.error('  !! FAIL: report missing required sections');
    failures++;
  }
}

// Print one full markdown report for eyeballing.
{
  const content = readFileSync(join(samples, cases[0][0]), 'utf8');
  const parsed = parseLogs([{ filename: cases[0][0], content }]);
  const { selected } = selectEvidence(parsed, cases[0][1], { charBudget: 12000 });
  const bundle = buildPrompt(cases[0][1], parsed, selected);
  const report = await createMockProvider().investigate({ ...bundle, parsed, selected, prompt: cases[0][1] });
  const validation = validateReport(report, bundle.availableIds);
  const md = toMarkdown(report, {
    prompt: cases[0][1],
    files: [cases[0][0]],
    provider: 'mock',
    createdAt: new Date().toISOString(),
    validation,
  });
  console.log('\n' + '#'.repeat(78) + '\n# SAMPLE MARKDOWN REPORT\n' + '#'.repeat(78));
  console.log(md);
}

console.log('\n' + '='.repeat(78));
console.log(failures === 0 ? 'ALL CHECKS PASSED ✅' : `${failures} CHECK(S) FAILED ❌`);
process.exit(failures === 0 ? 0 : 1);
