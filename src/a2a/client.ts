// ---------------------------------------------------------------------------
// lib/a2a/client.ts — A2A protocol client (call remote agents)
// ---------------------------------------------------------------------------

import type { A2ATask, A2AAgentCard, A2AMessage, A2AStreamEvent } from './types';
import type { Logger } from '../core/types';

/**
 * HTTP client for the A2A protocol.
 *
 * Calls remote agents that expose A2A endpoints:
 * - GET /.well-known/agent.json → agent card
 * - POST /tasks/send → create/update task
 * - GET /tasks/:id → get task status
 *
 * Usage:
 * ```typescript
 * const client = new A2AClient('http://10.0.0.5:8789');
 * const card = await client.getAgentCard();
 * const task = await client.sendTask({ query: 'summarize this paper' });
 * ```
 */
export class A2AClient {
  private _baseUrl: string;
  private _authToken: string | null;
  private _logger: Logger;

  constructor(
    baseUrl: string,
    options: { authToken?: string | null; logger?: Logger } = {}
  ) {
    this._baseUrl = baseUrl.replace(/\/+$/, '');
    this._authToken = options.authToken ?? null;
    this._logger = options.logger ?? console;
  }

  private _headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this._authToken) h['Authorization'] = `Bearer ${this._authToken}`;
    return h;
  }

  /**
   * Fetch the remote agent's card.
   */
  async getAgentCard(): Promise<A2AAgentCard | null> {
    try {
      const response = await fetch(`${this._baseUrl}/.well-known/agent.json`, {
        headers: this._headers(),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) return null;
      return (await response.json()) as A2AAgentCard;
    } catch (error: any) {
      this._logger.warn?.(`[A2AClient] Failed to get agent card:`, error?.message);
      return null;
    }
  }

  /**
   * Send a task to the remote agent.
   */
  async sendTask(input: any, options: { sessionId?: string } = {}): Promise<A2ATask | null> {
    try {
      const body: any = { input };
      if (options.sessionId) body.sessionId = options.sessionId;

      const response = await fetch(`${this._baseUrl}/tasks/send`, {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => response.statusText);
        this._logger.warn?.(`[A2AClient] sendTask failed: ${response.status} ${text}`);
        return null;
      }

      return (await response.json()) as A2ATask;
    } catch (error: any) {
      this._logger.warn?.(`[A2AClient] sendTask error:`, error?.message);
      return null;
    }
  }

  /**
   * Get a task's current status.
   */
  async getTask(taskId: string): Promise<A2ATask | null> {
    try {
      const response = await fetch(`${this._baseUrl}/tasks/${encodeURIComponent(taskId)}`, {
        headers: this._headers(),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) return null;
      return (await response.json()) as A2ATask;
    } catch (error: any) {
      this._logger.warn?.(`[A2AClient] getTask error:`, error?.message);
      return null;
    }
  }

  /**
   * Cancel a task.
   */
  async cancelTask(taskId: string): Promise<boolean> {
    try {
      const response = await fetch(`${this._baseUrl}/tasks/${encodeURIComponent(taskId)}/cancel`, {
        method: 'POST',
        headers: this._headers(),
        signal: AbortSignal.timeout(10000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Check if the remote agent is reachable.
   */
  async ping(): Promise<boolean> {
    const card = await this.getAgentCard();
    return card !== null;
  }
}
