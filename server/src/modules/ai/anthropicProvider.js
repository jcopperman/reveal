/**
 * ai/anthropicProvider.js
 * -----------------------------------------------------------------------------
 * Real Claude provider using the official Anthropic SDK.
 *
 * Design choices (per Anthropic's current guidance):
 *  - Model defaults to `claude-opus-4-8`.
 *  - Adaptive thinking (`thinking: { type: 'adaptive' }`) — good for the
 *    multi-step reasoning this task needs, and the correct shape for 4.6+.
 *  - Streaming with `.finalMessage()` so long investigations don't hit request
 *    timeouts; we don't need per-event handling here.
 *  - The API key is read from the environment, never hardcoded.
 *
 * We instruct the model (in promptBuilder's system prompt) to emit JSON only,
 * and parse defensively. This keeps the integration robust and dependency-light
 * for the MVP; structured-output constraints can be layered on later.
 */

import Anthropic from '@anthropic-ai/sdk';

export function createAnthropicProvider(env = process.env) {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const model = env.ANTHROPIC_MODEL || 'claude-opus-4-8';

  return {
    name: 'anthropic',
    async investigate({ system, user }) {
      const stream = client.messages.stream({
        model,
        max_tokens: 8000,
        thinking: { type: 'adaptive' },
        system,
        messages: [{ role: 'user', content: user }],
      });

      const message = await stream.finalMessage();

      const text = message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim();

      return parseReportJson(text);
    },
  };
}

/**
 * Extract a JSON object from the model's text response, tolerating code fences
 * or incidental prose around it.
 */
function parseReportJson(text) {
  let candidate = text;

  // Strip a ```json ... ``` fence if present.
  const fence = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidate = fence[1];

  // Otherwise, slice from the first { to the last }.
  if (!fence) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start !== -1 && end !== -1) candidate = candidate.slice(start, end + 1);
  }

  try {
    return JSON.parse(candidate);
  } catch (err) {
    const e = new Error(
      `Anthropic provider returned unparseable JSON: ${err.message}. Raw: ${text.slice(0, 400)}`,
    );
    e.cause = err;
    throw e;
  }
}
