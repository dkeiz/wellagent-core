// ---------------------------------------------------------------------------
// lib/inference/engines/codex.ts — Codex CLI engine adapter
// ---------------------------------------------------------------------------

import { ProcessEngine, type ProcessEngineOptions } from './process-engine';
import type { LLMResponse } from '../../core/types';

/** Codex CLI defaults. */
const DEFAULT_MODELS = [
  'gpt-5.2-codex',
  'gpt-5-codex',
  'gpt-5.2',
  'gpt-5.2-pro',
  'gpt-5-mini',
];

/**
 * Codex CLI inference engine.
 *
 * Wraps the `codex` CLI tool as a child process.
 *
 * Usage:
 * ```typescript
 * const codex = new CodexEngine({ model: 'gpt-5.2-codex' });
 * if (await codex.isAvailable()) {
 *   const response = await codex.execute('Explain how TCP works');
 *   console.log(response.content);
 * }
 * ```
 */
export class CodexEngine extends ProcessEngine {
  private _model: string;

  constructor(options: Partial<ProcessEngineOptions> & { model?: string } = {}) {
    super({
      name: 'codex',
      command: options.command || 'codex',
      args: options.args,
      cwd: options.cwd,
      env: options.env,
      timeoutMs: options.timeoutMs ?? 180000,
      logger: options.logger,
    });
    this._model = options.model || DEFAULT_MODELS[0];
  }

  protected _buildArgs(prompt: string, options: any): string[] {
    const args = [
      '--quiet',
      '--full-auto',
      '--model', this._model,
    ];

    if (options.cwd) {
      args.push('--cwd', options.cwd);
    }

    args.push(prompt);
    return args;
  }

  protected _parseOutput(stdout: string, stderr: string): LLMResponse {
    const content = stdout.trim();
    return {
      content: content || '(empty response)',
      reasoning: '',
      model: this._model,
      provider: 'codex',
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_tokens: 0, cache_write_tokens: 0 },
      stopped: true,
    };
  }

  /**
   * List available models.
   */
  static getDefaultModels(): string[] {
    return [...DEFAULT_MODELS];
  }

  /**
   * Get/set the active model.
   */
  get model(): string {
    return this._model;
  }

  set model(value: string) {
    this._model = value;
  }
}
