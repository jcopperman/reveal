/**
 * index.js — Reveal backend
 * -----------------------------------------------------------------------------
 * Express server exposing the investigation pipeline:
 *
 *   parse logs -> select evidence -> build prompt -> AI provider -> report
 *
 * Endpoints:
 *   POST /api/investigate            multipart: files[] + prompt   -> full result
 *   GET  /api/investigations         list saved investigations
 *   GET  /api/investigations/:id     one saved investigation (full)
 *   GET  /api/investigations/:id/export   download the Markdown report
 *   GET  /api/health
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';

import { parseLogs } from './modules/logParser.js';
import { selectEvidence } from './modules/evidenceSelector.js';
import { buildPrompt } from './modules/promptBuilder.js';
import { createProvider } from './modules/ai/index.js';
import { toMarkdown, validateReport } from './modules/reportGenerator.js';
import { saveInvestigation, listInvestigations, getInvestigation } from './db.js';

const PORT = Number(process.env.PORT) || 8787;
const CHAR_BUDGET = Number(process.env.EVIDENCE_CHAR_BUDGET) || 12000;

const app = express();
app.use(cors());
app.use(express.json());

// In-memory uploads (local demo; files are small log text).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 10 },
});

const provider = createProvider();
console.log(`[reveal] AI provider: ${provider.name} · evidence budget: ${CHAR_BUDGET} chars`);

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, provider: provider.name });
});

app.post('/api/investigate', upload.array('files'), async (req, res) => {
  try {
    const prompt = (req.body.prompt || '').trim();
    const files = (req.files || []).map((f) => ({
      filename: f.originalname,
      content: f.buffer.toString('utf8'),
    }));

    if (!prompt) return res.status(400).json({ error: 'A prompt is required.' });
    if (files.length === 0) return res.status(400).json({ error: 'Upload at least one log file.' });

    // 1. Parse -> 2. Select evidence
    const parsed = parseLogs(files);
    const { selected, keywords, stats } = selectEvidence(parsed, prompt, {
      charBudget: CHAR_BUDGET,
    });

    // 3. Build prompt
    const promptBundle = buildPrompt(prompt, parsed, selected);

    // 4. AI provider (mock uses parsed/selected; anthropic uses system/user)
    const report = await provider.investigate({ ...promptBundle, parsed, selected, prompt });

    // 5. Validate + render
    const validation = validateReport(report, promptBundle.availableIds);
    const createdAt = new Date().toISOString();
    const reportMd = toMarkdown(report, {
      prompt,
      files: files.map((f) => f.filename),
      provider: provider.name,
      createdAt,
      validation,
    });

    // Persist
    const evidence = { selected, keywords, stats };
    const signalsSummary = summariseSignals(parsed.signals);
    const id = saveInvestigation({
      createdAt,
      prompt,
      files: files.map((f) => f.filename),
      provider: provider.name,
      report,
      reportMd,
      evidence,
      signals: signalsSummary,
    });

    res.json({
      id,
      createdAt,
      prompt,
      provider: provider.name,
      report,
      reportMd,
      evidence,
      validation,
      signals: signalsSummary,
    });
  } catch (err) {
    console.error('[investigate] error:', err);
    res.status(500).json({ error: err.message || 'Investigation failed.' });
  }
});

app.get('/api/investigations', (_req, res) => {
  res.json(listInvestigations());
});

app.get('/api/investigations/:id', (req, res) => {
  const row = getInvestigation(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Not found.' });
  res.json(row);
});

app.get('/api/investigations/:id/export', (req, res) => {
  const row = getInvestigation(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Not found.' });
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="investigation-${row.id}.md"`,
  );
  res.send(row.reportMd);
});

app.listen(PORT, () => {
  console.log(`[reveal] backend listening on http://localhost:${PORT}`);
});

/** Trim the full signals object down to a JSON-friendly summary for storage. */
function summariseSignals(signals) {
  return {
    totalEntries: signals.totalEntries,
    levelCounts: signals.levelCounts,
    timespan: signals.timespan,
    errorCount: signals.errors.length,
    warnCount: signals.warns.length,
    fatalCount: signals.fatals.length,
    httpErrorCount: signals.httpErrors.length,
    httpErrorCodes: [...new Set(signals.httpErrors.map((e) => e.httpStatus))],
    stackTraceCount: signals.stackTraces.length,
    repeatedExceptions: signals.repeatedExceptions.slice(0, 10),
    timeClusters: signals.timeClusters,
  };
}
