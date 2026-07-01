/**
 * ai/index.js
 * -----------------------------------------------------------------------------
 * Provider abstraction so the model backend is swappable. A provider exposes:
 *
 *   async investigate({ system, user, availableIds }) -> report object
 *
 * The returned object must match REPORT_SCHEMA (see promptBuilder.js).
 *
 * Selection is driven by env:
 *   AI_PROVIDER=mock       (default) — deterministic, no API key required
 *   AI_PROVIDER=anthropic            — real Claude via @anthropic-ai/sdk
 */

import { createMockProvider } from './mockProvider.js';
import { createAnthropicProvider } from './anthropicProvider.js';

export function createProvider(env = process.env) {
  const choice = (env.AI_PROVIDER || 'mock').toLowerCase();

  if (choice === 'anthropic') {
    if (!env.ANTHROPIC_API_KEY) {
      console.warn(
        '[ai] AI_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set — falling back to mock provider.',
      );
      return createMockProvider();
    }
    return createAnthropicProvider(env);
  }

  if (choice !== 'mock') {
    console.warn(`[ai] Unknown AI_PROVIDER "${choice}" — using mock provider.`);
  }
  return createMockProvider();
}
