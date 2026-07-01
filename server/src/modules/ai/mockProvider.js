/**
 * ai/mockProvider.js
 * -----------------------------------------------------------------------------
 * Deterministic, offline provider. It does NOT call any network. Instead it
 * derives a plausible, fully evidence-cited investigation directly from the
 * real parsed signals and the selected evidence. This makes the demo meaningful
 * out of the box (no API key) while honouring the product's core rule: every
 * conclusion cites a real line ID, and anything not directly supported is
 * marked as speculation.
 *
 * It receives the same prompt bundle as the real provider, plus the structured
 * `parsed` signals and `selected` evidence (which the real provider ignores).
 */

export function createMockProvider() {
  return {
    name: 'mock',
    async investigate({ parsed, selected, prompt }) {
      const { signals } = parsed;

      // Pick the "headline" evidence: prefer a 5xx, then a fatal/error with an
      // exception, then the highest-scored selected line.
      const http5xx = selected.filter((e) => e.httpStatus >= 500);
      const exc = selected.filter((e) => e.exceptionType);
      const headline =
        http5xx[0] || exc[0] || [...selected].sort((a, b) => b._score - a._score)[0] || null;

      const cite = (arr) => arr.filter(Boolean).map((e) => e.id);

      // ---- Timeline: chronological selected events with timestamps ----------
      const timeline = selected
        .filter((e) => e.timestamp)
        .slice(0, 12)
        .map((e) => ({
          time: e.timestamp,
          event: condense(e.raw),
          evidence: [e.id],
        }));
    if (signals.timeClusters.length) {
        const c = signals.timeClusters[0];
        timeline.push({
          time: c.start,
          event: `Burst of ${c.count} error-level events (auto-detected cluster).`,
          evidence: c.lineIds.slice(0, 4),
        });
      }

      // ---- Root cause -------------------------------------------------------
      const topRepeat = signals.repeatedExceptions[0];
      let rootCause;
      if (topRepeat) {
        const example = selected.find((e) => e.id === topRepeat.exampleLineId) || headline;
        rootCause = {
          statement: `The dominant failure signature is "${topRepeat.signature}", observed ${topRepeat.count} times. This repetition, concentrated ${
            signals.timeClusters.length ? 'within a short burst' : 'across the run'
          }, points to it as the primary driver of the incident.`,
          evidence: cite([example]).concat(
            signals.timeClusters[0]?.lineIds?.slice(0, 2) || [],
          ),
          isSpeculation: false,
        };
      } else if (headline) {
        rootCause = {
          statement: `SPECULATION: The most severe observed event is "${firstLine(
            headline.raw,
          )}". There is not enough repetition or correlation in the selected evidence to state a single root cause with certainty.`,
          evidence: cite([headline]),
          isSpeculation: true,
        };
      } else {
        rootCause = {
          statement:
            'SPECULATION: No error-level evidence was selected, so a root cause cannot be established from these logs.',
          evidence: [],
          isSpeculation: true,
        };
      }

      // ---- Confidence -------------------------------------------------------
      let level = 'low';
      if (topRepeat && signals.timeClusters.length && http5xx.length) level = 'high';
      else if (topRepeat || http5xx.length) level = 'medium';
      const confidence = {
        level,
        rationale: `Based on ${signals.errors.length} error(s), ${
          signals.fatals.length
        } fatal(s), ${signals.httpErrors.length} HTTP 4xx/5xx response(s), ${
          signals.repeatedExceptions.length
        } repeated signature(s), and ${
          signals.timeClusters.length
        } error burst(s) in the selected evidence.`,
      };

      // ---- Summary ----------------------------------------------------------
      const httpCodes = [...new Set(signals.httpErrors.map((e) => e.httpStatus))];
      const summary =
        headline
          ? `Investigation of "${truncate(prompt, 80)}" surfaced ${
              signals.errors.length + signals.fatals.length
            } error/fatal record(s)${
              httpCodes.length ? ` and HTTP ${httpCodes.join('/')} responses` : ''
            }. The leading signal is "${firstLine(headline.raw)}" (${headline.id})${
              topRepeat ? `, which recurs ${topRepeat.count} times` : ''
            }. See timeline and root cause below; all claims cite line IDs.`
          : `Investigation of "${truncate(
              prompt,
              80,
            )}" found no error- or fatal-level evidence in the selected lines. See unknowns.`;

      // ---- Bug report -------------------------------------------------------
      const severity = signals.fatals.length || http5xx.length ? 'critical' : signals.errors.length ? 'high' : 'low';
      const bugReport = {
        title: headline
          ? `${headline.exceptionType || `HTTP ${headline.httpStatus}` || 'Error'}: ${firstLine(
              stripException(headline.raw),
            ).slice(0, 80)}`
          : 'No error evidence found in provided logs',
        severity,
        description: headline
          ? `While investigating the reported issue, the logs show ${
              topRepeat ? `a recurring "${topRepeat.signature}" failure (${topRepeat.count}x)` : 'an error condition'
            }${httpCodes.length ? ` correlated with HTTP ${httpCodes.join('/')} responses` : ''}. Representative evidence: ${cite(
              [headline],
            ).join(', ')}${
              signals.stackTraces.length ? `; stack trace at ${signals.stackTraces[0].id}` : ''
            }. Expected behaviour: requests complete without server errors.`
          : 'No error-level log evidence was found in the selected lines for the reported time frame.',
        evidence: cite([headline]).concat(
          signals.stackTraces[0] ? [signals.stackTraces[0].id] : [],
        ),
      };

      // ---- Repro / tests / logging -----------------------------------------
      const reproductionSteps = headline
        ? [
            `Recreate the conditions around ${headline.timestamp || 'the failure window'} (${headline.id}).`,
            topRepeat
              ? `Drive the code path that emits "${topRepeat.signature}" until it recurs.`
              : 'SPECULATION: exact trigger is unclear from the evidence; reproduce the affected endpoint under load.',
            http5xx.length
              ? `Confirm the endpoint returns HTTP ${http5xx[0].httpStatus} (${http5xx[0].id}).`
              : 'Observe the error in application logs.',
          ]
        : ['SPECULATION: insufficient evidence to derive reproduction steps.'];

      const regressionTests = headline
        ? [
            topRepeat
              ? `Add a test asserting "${topRepeat.signature}" is handled gracefully (no unhandled failure).`
              : `Add a test covering the failing path shown in ${headline.id}.`,
            http5xx.length
              ? `Integration test asserting the endpoint returns 2xx (not ${http5xx[0].httpStatus}) under the reproduced conditions.`
              : 'Regression test asserting no ERROR/FATAL logs during the happy path.',
            signals.timeClusters.length
              ? 'Load/soak test to catch error bursts under sustained traffic.'
              : 'Add monitoring assertion for error-rate thresholds.',
          ]
        : ['Add smoke tests that fail loudly on any ERROR/FATAL log output.'];

      const loggingImprovements = dedupe([
        selected.some((e) => e.requestId)
          ? 'Good: correlation/request IDs are present — keep propagating them across services.'
          : 'Add a correlation/request ID to every log line to trace requests end-to-end.',
        signals.stackTraces.length
          ? 'Ensure stack traces include the originating request ID and input parameters.'
          : 'Log full stack traces (with context) on caught exceptions, not just messages.',
        'Emit structured (JSON) logs with explicit level, timestamp, and status fields for reliable parsing.',
        http5xx.length
          ? 'Log upstream/dependency latency and status on 5xx paths to distinguish local vs. downstream faults.'
          : 'Add latency/duration fields to request logs to spot slow dependencies early.',
      ]);

      // ---- Unknowns ---------------------------------------------------------
      const unknowns = [];
      if (!signals.timespan.start)
        unknowns.push('No parseable timestamps were found, so event ordering is uncertain.');
      if (!selected.some((e) => e.requestId))
        unknowns.push('No correlation/request IDs in evidence — cannot trace a single request end-to-end.');
      if (!topRepeat)
        unknowns.push('No repeated signature — unclear whether this is systemic or a one-off.');
      if (headline && !http5xx.length)
        unknowns.push('No HTTP status codes in evidence — user-facing impact is inferred, not confirmed.');
      unknowns.push('SPECULATION: deploy/config changes preceding the incident are not visible in these logs.');

      return {
        summary,
        timeline: timeline.length ? timeline : [
          { time: 'unknown', event: 'No timestamped events in selected evidence.', evidence: [] },
        ],
        rootCause,
        confidence,
        unknowns,
        bugReport,
        reproductionSteps,
        regressionTests,
        loggingImprovements,
      };
    },
  };
}

// --- small helpers -----------------------------------------------------------
function firstLine(s) {
  return s.split('\n')[0].trim();
}
/** First line with a leading ISO timestamp stripped (it's shown separately). */
function condense(s) {
  return firstLine(s).replace(
    /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?\s*/,
    '',
  );
}
function stripException(s) {
  return s.replace(/^[\d\-T:.,Z\s\[\]]+/, '');
}
function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
function dedupe(arr) {
  return [...new Set(arr)];
}
