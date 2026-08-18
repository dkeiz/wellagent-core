// ---------------------------------------------------------------------------
// lib/inference/adapters/lmstudio.ts — LM Studio provider adapter
// ---------------------------------------------------------------------------

import { OpenAICompatibleAdapter } from './openai-compatible';
import type { SettingsStore, Logger } from '../../core/types';

/**
 * LM Studio adapter — wraps OpenAI-compatible with local LM Studio defaults.
 *
 * Usage:
 * ```typescript
 * const lms = new LMStudioAdapter(db);
 * const models = await lms.getModels();
 * ```
 */
export class LMStudioAdapter extends OpenAICompatibleAdapter {
  constructor(
    db: SettingsStore,
    options: { baseUrl?: string; model?: string; logger?: Logger } = {}
  ) {
    super(db, {
      name: 'lmstudio',
      baseUrl: options.baseUrl || 'http://127.0.0.1:1234/v1',
      model: options.model || 'default',
      apiKeySettingPath: 'provider.lmstudio.apiKey',
      logger: options.logger,
    });
  }

  /**
   * Check if LM Studio server is reachable.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const models = await this.getModels(true);
      return models.length > 0;
    } catch {
      return false;
    }
  }
}
