/**
 * Stop hook — runs the pipeline smoke test once, when Claude finishes a turn.
 *
 * Why a Stop hook (not PostToolUse): the smoke test guards the core "cite
 * evidence or mark speculation" invariant. Running it per-edit would flag the
 * intermediate broken states of a legitimate multi-file change (e.g. updating
 * REPORT_SCHEMA + mock provider + renderer together). Running it once at the
 * end of a turn checks the finished state instead — a reliable gate without the
 * mid-refactor false alarms.
 *
 * Wired up in .claude/settings.json. Pure Node, so it's cross-platform.
 *
 * Contract:
 *  - Reads the Stop payload as JSON on stdin.
 *  - If stop_hook_active is true (we're already inside a stop-hook-triggered
 *    continuation), exits 0 to avoid an infinite loop.
 *  - Runs `npm run smoke`. On failure it writes to stderr and exits 2, which
 *    blocks the stop and feeds the failure back to Claude to fix.
 *
 * To disable, remove the "Stop" block in .claude/settings.json.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Read the Stop payload from stdin.
let raw = '';
try {
  raw = readFileSync(0, 'utf8');
} catch {
  /* no stdin */
}

let payload = {};
try {
  payload = JSON.parse(raw || '{}');
} catch {
  /* malformed — proceed with defaults */
}

// Prevent loops: if this stop was itself triggered by a previous stop-hook
// block, don't run again.
if (payload.stop_hook_active) {
  process.exit(0);
}

const result = spawnSync('npm', ['run', 'smoke', '--silent'], {
  cwd: join(projectRoot, 'server'),
  encoding: 'utf8',
  shell: process.platform === 'win32', // npm is a .cmd shim on Windows
});

if (result.status !== 0) {
  process.stderr.write(
    'Smoke test FAILED — the evidence-citation pipeline may be broken. ' +
      'Fix it before finishing. Output:\n\n' +
      (result.stdout || '') +
      (result.stderr || ''),
  );
  process.exit(2); // exit 2 => block the stop and surface this back to Claude
}

process.exit(0);
