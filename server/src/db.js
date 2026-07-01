/**
 * db.js
 * -----------------------------------------------------------------------------
 * SQLite persistence for saved investigations.
 *
 * Uses Node's built-in `node:sqlite` (real SQLite, no native build step, no
 * external dependency). The DB file lives in server/data/reveal.db.
 */

import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '..', 'data');
mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(join(dataDir, 'reveal.db'));
db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
  CREATE TABLE IF NOT EXISTS investigations (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at    TEXT    NOT NULL,
    prompt        TEXT    NOT NULL,
    files         TEXT    NOT NULL,   -- JSON array of filenames
    provider      TEXT    NOT NULL,
    report_json   TEXT    NOT NULL,   -- structured report
    report_md     TEXT    NOT NULL,   -- rendered markdown
    evidence_json TEXT    NOT NULL,   -- selected evidence + stats
    signals_json  TEXT    NOT NULL    -- derived signals summary
  );
`);

export function saveInvestigation(row) {
  const stmt = db.prepare(`
    INSERT INTO investigations
      (created_at, prompt, files, provider, report_json, report_md, evidence_json, signals_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    row.createdAt,
    row.prompt,
    JSON.stringify(row.files),
    row.provider,
    JSON.stringify(row.report),
    row.reportMd,
    JSON.stringify(row.evidence),
    JSON.stringify(row.signals),
  );
  return Number(info.lastInsertRowid);
}

export function listInvestigations() {
  const rows = db
    .prepare(
      `SELECT id, created_at, prompt, files, provider
         FROM investigations ORDER BY id DESC LIMIT 100`,
    )
    .all();
  return rows.map((r) => ({ ...r, files: JSON.parse(r.files) }));
}

export function getInvestigation(id) {
  const r = db.prepare(`SELECT * FROM investigations WHERE id = ?`).get(id);
  if (!r) return null;
  return {
    id: r.id,
    createdAt: r.created_at,
    prompt: r.prompt,
    files: JSON.parse(r.files),
    provider: r.provider,
    report: JSON.parse(r.report_json),
    reportMd: r.report_md,
    evidence: JSON.parse(r.evidence_json),
    signals: JSON.parse(r.signals_json),
  };
}

export default db;
