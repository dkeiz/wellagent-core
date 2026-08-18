// ---------------------------------------------------------------------------
// lib/inference/adapters/openrouter.ts — OpenRouter provider adapter
// ---------------------------------------------------------------------------

import { OpenAICompatibleAdapter } from './openai-compatible';
import type { SettingsStore, Logger } from '../../core/types';

/**
 * OpenRouter adapter — wraps OpenAI-compatible with OpenRouter-specific defaults.
 *
 * Usage:
 * ```typescript
 * const router = new OpenRouterAdapter(db, { apiKey: 'sk-or-...' });
 * ```
 */
export class OpenRouterAdapter extends OpenAICompatibleAdapter {
  constructor(
    db: SettingsStore,
    options: { apiKey?: string; model?: string; logger?: Logger } = {}
  ) {
    super(db, {
      name: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: options.apiKey,
      model: options.model || 'anthropic/claude-sonnet-4',
      apiKeySettingPath: 'provider.openrouter.apiKey',
      logger: options.logger,
    });
  }
}
