// ---------------------------------------------------------------------------
// lib/inference/engines/process-engine.ts — Base class for process-spawned inference
// ---------------------------------------------------------------------------

import { EventEmitter } from 'events';
import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import type { LLMResponse, Logger } from '../../core/types';

/** Process engine configuration. */
export interface ProcessEngineOptions {
  /** Display name. */
  name: string;
  /** Executable command. */
  command: string;
  /** Default arguments. */
  args?: string[];
  /** Working directory override. */
  cwd?: string;
  /** Environment variable overrides. */
  env?: Record<string, string>;
  /** Maximum request timeout (ms). */
  timeoutMs?: number;
  /** Logger instance. */
  logger?: Logger;
}

/** Status of the engine process. */
export type EngineStatus = 'stopped' | 'starting' | 'running' | 'error';

/**
 * Base class for inference engines that run as child processes.
 *
 * Subclasses implement `_buildArgs()` and `_parseOutput()` to adapt
 * to specific CLI tools (Codex CLI, OpenCode, etc.).
 *
 * Usage:
 * ```typescript
 * class MyEngine extends ProcessEngine {
 *   protected _buildArgs(prompt: string) { return ['--prompt', prompt]; }
 *   protected _parseOutput(stdout: string) {
 *     return { content: stdout, model: 'my-model', provider: 'my-engine' };
 *   }
 * }
 * const engine = new MyEngine({ name: 'my-engine', command: 'my-cli' });
 * const response = await engine.execute('What time is it?');
 * ```
 */
export abstract class ProcessEngine extends EventEmitter {
  readonly name: string;
  protected _command: string;
  protected _defaultArgs: string[];
  protected _cwd: string;
  protected _env: Record<string, string>;
  protected _timeoutMs: number;
  protected _status: EngineStatus;
  protected _process: ChildProcess | null;
  protected _logger: Logger;

  constructor(options: ProcessEngineOptions) {
    super();
    this.name = options.name;
    this._command = options.command;
    this._defaultArgs = options.args || [];
    this._cwd = options.cwd || process.cwd();
    this._env = options.env || {};
    this._timeoutMs = options.timeoutMs ?? 180000;
    this._status = 'stopped';
    this._process = null;
    this._logger = options.logger ?? console;
  }

  /**
   * Execute a prompt and return the response.
   */
  async execute(prompt: string, options: { sessionId?: string; cwd?: string; timeoutMs?: number } = {}): Promise<LLMResponse> {
    const args = this._buildArgs(prompt, options);
    const cwd = options.cwd || this._cwd;
    const timeout = options.timeoutMs || this._timeoutMs;

    this._status = 'starting';
    this.emit('engine:starting', { name: this.name });

    return new Promise<LLMResponse>((resolve, reject) => {
      const proc = spawn(this._command, args, {
        cwd,
        env: { ...process.env, ...this._env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this._process = proc;
      this._status = 'running';

      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];

      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new Error(`${this.name} timed out after ${timeout}ms`));
      }, timeout);

      proc.stdout?.on('data', (data) => {
        stdoutChunks.push(data.toString());
        this.emit('engine:output', { name: this.name, data: data.toString() });
      });

      proc.stderr?.on('data', (data) => {
        stderrChunks.push(data.toString());
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        this._process = null;
        this._status = 'stopped';

        const stdout = stdoutChunks.join('');
        const stderr = stderrChunks.join('');

        if (code !== 0) {
          this._status = 'error';
          reject(new Error(`${this.name} exited with code ${code}: ${stderr.slice(0, 500)}`));
          return;
        }

        try {
          const response = this._parseOutput(stdout, stderr);
          this.emit('engine:completed', { name: this.name, response });
          resolve(response);
        } catch (error: any) {
          reject(new Error(`${this.name} output parse error: ${error?.message}`));
        }
      });

      proc.on('error', (error) => {
        clearTimeout(timer);
        this._process = null;
        this._status = 'error';
        reject(new Error(`${this.name} process error: ${error.message}`));
      });

      // Send prompt to stdin if needed
      if (proc.stdin) {
        proc.stdin.write(prompt);
        proc.stdin.end();
      }
    });
  }

  /**
   * Stop the current process.
   */
  stop(): void {
    if (this._process) {
      this._process.kill('SIGTERM');
      this._process = null;
      this._status = 'stopped';
    }
  }

  get status(): EngineStatus {
    return this._status;
  }

  /**
   * Check if the engine's command is available on PATH.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const { spawnSync } = require('child_process');
      const result = spawnSync(this._command, ['--version'], {
        timeout: 5000,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return result.status === 0 || result.status === null;
    } catch {
      return false;
    }
  }

  /**
   * Build the CLI arguments for a prompt. Override in subclasses.
   */
  protected abstract _buildArgs(prompt: string, options: any): string[];

  /**
   * Parse the CLI output into an LLMResponse. Override in subclasses.
   */
  protected abstract _parseOutput(stdout: string, stderr: string): LLMResponse;
}
