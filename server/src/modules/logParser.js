/**
 * logParser.js
 * -----------------------------------------------------------------------------
 * Turns raw log text into structured entries and derived "signals".
 *
 * The parser is heuristic and format-tolerant on purpose: real QA logs come in
 * many shapes (JSON lines, Apache/nginx access logs, framework logs, plain
 * app logs). We extract what we can and never throw on a line we don't
 * understand — an unrecognised line simply becomes a low-signal entry.
 *
 * Output shape:
 *   {
 *     entries: Entry[],          // one per logical log record (multi-line grouped)
 *     signals: {
 *       errors, warns, fatals,   // Entry[] filtered by level
 *       stackTraces,             // Entry[] that carry a stack trace
 *       httpErrors,              // Entry[] with a 4xx/5xx status
 *       repeatedExceptions,      // [{ signature, count, exampleLineId }]
 *       timeClusters,            // [{ start, end, count, lineIds }]
 *       levelCounts,             // { ERROR: n, WARN: n, ... }
 *       timespan: { start, end } // ISO strings or null
 *     }
 *   }
 *
 * Every Entry has a stable `id` ("L142") derived from its starting line number
 * within its source file so conclusions can cite it.
 */

const LEVELS = ['FATAL', 'ERROR', 'WARN', 'WARNING', 'INFO', 'DEBUG', 'TRACE'];
const LEVEL_SEVERITY = {
  FATAL: 5,
  ERROR: 4,
  WARN: 3,
  WARNING: 3,
  INFO: 1,
  DEBUG: 0,
  TRACE: 0,
};

// Common timestamp shapes. We try each and use the first that hits.
const TIMESTAMP_PATTERNS = [
  // ISO 8601: 2026-07-01T08:14:22.123Z / 2026-07-01 08:14:22,123
  /(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})?)/,
  // Syslog-ish: Jul  1 08:14:22
  /([A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})/,
  // Apache/nginx: [01/Jul/2026:08:14:22 +0000]
  /\[(\d{2}\/[A-Z][a-z]{2}\/\d{4}:\d{2}:\d{2}:\d{2}\s*[+-]\d{4})\]/,
];

const LEVEL_PATTERN = new RegExp(`\\b(${LEVELS.join('|')})\\b`, 'i');

// HTTP status: "HTTP/1.1" 500, status=500, status_code:404, " 502 "
const HTTP_STATUS_PATTERNS = [
  /\bstatus(?:_code)?["'=:\s]+(\d{3})\b/i,
  /"(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)[^"]*"\s+(\d{3})\b/,
  /\bHTTP\/\d\.\d"?\s+(\d{3})\b/,
  /\bresponse[_\s]?code["'=:\s]+(\d{3})\b/i,
];

// Correlation / request IDs. Try labelled first, then bare UUIDs.
const REQUEST_ID_PATTERNS = [
  /\b(?:request[_-]?id|req[_-]?id|correlation[_-]?id|corr[_-]?id|trace[_-]?id|traceId|x-request-id)["'=:\s]+["']?([A-Za-z0-9._-]{6,})/i,
  /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i,
];

// Exception class names: com.foo.BarException, ValueError, TypeError:
const EXCEPTION_PATTERN =
  /\b([A-Z][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*(?:Exception|Error|Fault|Timeout|Failure))\b/;

// Lines that look like a stack-trace frame.
const STACK_FRAME_PATTERNS = [
  /^\s+at\s+/, // Java / JS:  "    at com.foo.Bar(...)"
  /^\s+File ".*", line \d+/, // Python:   '  File "app.py", line 12'
  /^\s*Caused by:/i,
  /^\s*Traceback \(most recent call last\)/i,
  /^\s+\.\.\.\s+\d+ more/, // Java "... 3 more"
  /^\s{2,}[\w$.]+\(.*\)\s*$/, // generic indented "frame(...)"
];

function matchFirst(patterns, line) {
  for (const re of patterns) {
    const m = line.match(re);
    if (m) return m[1];
  }
  return null;
}

function detectTimestamp(line) {
  for (const re of TIMESTAMP_PATTERNS) {
    const m = line.match(re);
    if (m) return normaliseTimestamp(m[1]);
  }
  return null;
}

function normaliseTimestamp(raw) {
  // Return ISO string when parseable, else the raw token (still useful for order).
  let candidate = raw.replace(',', '.'); // "08:14:22,123" -> "08:14:22.123"
  // "2026-07-01 08:14:22" -> ISO
  if (/^\d{4}-\d{2}-\d{2} /.test(candidate)) candidate = candidate.replace(' ', 'T');
  const d = new Date(candidate);
  if (!Number.isNaN(d.getTime())) return d.toISOString();
  return raw;
}

function detectLevel(line) {
  const m = line.match(LEVEL_PATTERN);
  if (!m) return null;
  const lvl = m[1].toUpperCase();
  return lvl === 'WARNING' ? 'WARN' : lvl;
}

function isStackFrame(line) {
  return STACK_FRAME_PATTERNS.some((re) => re.test(line));
}

/**
 * Parse a single file's text into grouped entries.
 * @param {string} text
 * @param {string} filename
 * @param {number} idOffset - line-number offset so IDs stay unique across files
 */
export function parseLogFile(text, filename, idOffset = 0) {
  const lines = text.split(/\r?\n/);
  const entries = [];
  let current = null;

  const pushCurrent = () => {
    if (current) {
      current.raw = current.rawLines.join('\n');
      current.exceptionType =
        current.exceptionType || matchFirst([EXCEPTION_PATTERN], current.raw);
      entries.push(current);
      current = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1 + idOffset;

    if (line.trim() === '') {
      // blank line ends a multi-line record
      continue;
    }

    const looksLikeFrame = isStackFrame(line);

    // A stack frame (or continuation) attaches to the current entry.
    if (current && looksLikeFrame) {
      current.rawLines.push(line);
      current.lineEnd = lineNo;
      current.isStackTrace = true;
      continue;
    }

    const timestamp = detectTimestamp(line);
    const level = detectLevel(line);

    // Heuristic: a new record starts when we see a timestamp or a level marker,
    // otherwise treat as a continuation of the previous message (wrapped line).
    const startsNewRecord = timestamp !== null || level !== null || current === null;

    if (!startsNewRecord && current) {
      current.rawLines.push(line);
      current.lineEnd = lineNo;
      continue;
    }

    pushCurrent();

    current = {
      id: `L${lineNo}`,
      file: filename,
      lineStart: lineNo,
      lineEnd: lineNo,
      timestamp,
      level: level || inferLevelFromText(line),
      httpStatus: (() => {
        const s = matchFirst(HTTP_STATUS_PATTERNS, line);
        return s ? Number(s) : null;
      })(),
      requestId: matchFirst(REQUEST_ID_PATTERNS, line),
      exceptionType: matchFirst([EXCEPTION_PATTERN], line),
      isStackTrace: false,
      rawLines: [line],
      raw: line,
    };
  }
  pushCurrent();

  return entries;
}

/**
 * When there is no explicit level, infer a soft one from wording so obvious
 * problems ("failed", "exception", "timeout") still surface.
 */
function inferLevelFromText(line) {
  const l = line.toLowerCase();
  if (/\b(fatal|panic|crash)\b/.test(l)) return 'FATAL';
  if (/\b(error|exception|failed|failure|traceback|unhandled)\b/.test(l)) return 'ERROR';
  if (/\b(warn|deprecated|retry|retrying|slow)\b/.test(l)) return 'WARN';
  return 'INFO';
}

/** Normalise a message into a signature for grouping repeated exceptions. */
function signatureOf(entry) {
  if (entry.exceptionType) return entry.exceptionType;
  // Strip volatile tokens (numbers, UUIDs, hex) so "took 812ms" ~ "took 4ms".
  return entry.rawLines[0]
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\b\d+(\.\d+)?\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/** Bucket entries with timestamps into clusters of error activity. */
function findTimeClusters(entries, windowMs = 60_000) {
  const withTime = entries
    .filter((e) => e.timestamp && LEVEL_SEVERITY[e.level] >= 3)
    .map((e) => ({ e, t: Date.parse(e.timestamp) }))
    .filter((x) => !Number.isNaN(x.t))
    .sort((a, b) => a.t - b.t);

  const clusters = [];
  let bucket = null;
  for (const { e, t } of withTime) {
    if (bucket && t - bucket.lastT <= windowMs) {
      bucket.count++;
      bucket.lineIds.push(e.id);
      bucket.end = e.timestamp;
      bucket.lastT = t;
    } else {
      if (bucket && bucket.count >= 3) clusters.push(strip(bucket));
      bucket = { start: e.timestamp, end: e.timestamp, count: 1, lineIds: [e.id], lastT: t };
    }
  }
  if (bucket && bucket.count >= 3) clusters.push(strip(bucket));
  return clusters;

  function strip(b) {
    const { lastT, ...rest } = b;
    return rest;
  }
}

/**
 * Parse many files and compute derived signals.
 * @param {{filename: string, content: string}[]} files
 */
export function parseLogs(files) {
  let offset = 0;
  let entries = [];
  for (const f of files) {
    const parsed = parseLogFile(f.content, f.filename, offset);
    entries = entries.concat(parsed);
    offset += f.content.split(/\r?\n/).length;
  }

  const levelCounts = {};
  for (const e of entries) levelCounts[e.level] = (levelCounts[e.level] || 0) + 1;

  const errors = entries.filter((e) => e.level === 'ERROR');
  const warns = entries.filter((e) => e.level === 'WARN');
  const fatals = entries.filter((e) => e.level === 'FATAL');
  const stackTraces = entries.filter((e) => e.isStackTrace);
  const httpErrors = entries.filter((e) => e.httpStatus && e.httpStatus >= 400);

  // Repeated exceptions / error signatures.
  const sigMap = new Map();
  for (const e of entries) {
    if (LEVEL_SEVERITY[e.level] < 3) continue;
    const sig = signatureOf(e);
    if (!sigMap.has(sig)) sigMap.set(sig, { signature: sig, count: 0, exampleLineId: e.id });
    sigMap.get(sig).count++;
  }
  const repeatedExceptions = [...sigMap.values()]
    .filter((s) => s.count >= 2)
    .sort((a, b) => b.count - a.count);

  const timestamped = entries.map((e) => e.timestamp).filter(Boolean).sort();

  return {
    entries,
    signals: {
      errors,
      warns,
      fatals,
      stackTraces,
      httpErrors,
      repeatedExceptions,
      timeClusters: findTimeClusters(entries),
      levelCounts,
      timespan: {
        start: timestamped[0] || null,
        end: timestamped[timestamped.length - 1] || null,
      },
      totalEntries: entries.length,
    },
  };
}

export const _internals = { LEVEL_SEVERITY, signatureOf, detectTimestamp, detectLevel };
