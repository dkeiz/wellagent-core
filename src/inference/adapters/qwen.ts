// ---------------------------------------------------------------------------
// lib/inference/adapters/qwen.ts — Qwen / DashScope provider adapter
// ---------------------------------------------------------------------------

import { OpenAICompatibleAdapter } from './openai-compatible';
import type { SettingsStore, Logger } from '../../core/types';

/**
 * Qwen adapter — wraps OpenAI-compatible with Qwen/DashScope defaults.
 *
 * Usage:
 * ```typescript
 * const qwen = new QwenAdapter(db, { apiKey: 'sk-...' });
 * ```
 */
export class QwenAdapter extends OpenAICompatibleAdapter {
  constructor(
    db: SettingsStore,
    options: { apiKey?: string; baseUrl?: string; model?: string; logger?: Logger } = {}
  ) {
    super(db, {
      name: 'qwen',
      baseUrl: options.baseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: options.apiKey,
      model: options.model || 'qwen-plus',
      apiKeySettingPath: 'provider.qwen.apiKey',
      logger: options.logger,
    });
  }
}
