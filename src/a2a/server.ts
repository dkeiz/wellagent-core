// ---------------------------------------------------------------------------
// lib/a2a/server.ts — A2A protocol HTTP server
// ---------------------------------------------------------------------------

import * as http from 'http';
import type { A2AManager } from './manager';
import type { A2AAgentCard } from './types';
import type { Logger } from '../core/types';

/**
 * Lightweight A2A HTTP server that exposes:
 * - GET  /.well-known/agent.json → agent card
 * - POST /tasks/send → create a task
 * - GET  /tasks/:id → get task status
 * - POST /tasks/:id/cancel → cancel a task
 *
 * Uses raw `http.createServer` — no Express dependency.
 *
 * Usage:
 * ```typescript
 * const server = new A2AServer(a2aManager, {
 *   port: 8789,
 *   onTask: async (task) => { ... execute the task ... },
 * });
 * await server.start();
 * ```
 */
export class A2AServer {
  private _manager: A2AManager;
  private _server: http.Server | null;
  private _port: number;
  private _host: string;
  private _onTask: ((task: any) => Promise<any>) | null;
  private _authorize: ((req: http.IncomingMessage) => boolean | Promise<boolean>) | null;
  private _logger: Logger;

  constructor(
    manager: A2AManager,
    options: {
      port?: number;
      host?: string;
      onTask?: (task: any) => Promise<any>;
      authorize?: (req: http.IncomingMessage) => boolean | Promise<boolean>;
      logger?: Logger;
    } = {}
  ) {
    this._manager = manager;
    this._server = null;
    this._port = options.port ?? 8789;
    this._host = options.host ?? '127.0.0.1';
    this._onTask = options.onTask ?? null;
    this._authorize = options.authorize ?? null;
    this._logger = options.logger ?? console;
    if (!isLoopbackHost(this._host) && !this._authorize) {
      throw new Error('A2AServer requires host authentication when bound beyond loopback');
    }
  }

  /**
   * Start the server.
   */
  async start(): Promise<void> {
    if (this._server) return;

    this._server = http.createServer((req, res) => {
      this._handleRequest(req, res).catch(error => {
        this._sendJson(res, 500, { error: 'Internal server error' });
      });
    });

    return new Promise((resolve, reject) => {
      this._server!.listen(this._port, this._host, () => {
        this._logger.log?.(`[A2AServer] Listening on ${this._host}:${this._port}`);
        resolve();
      });
      this._server!.on('error', reject);
    });
  }

  /**
   * Stop the server.
   */
  async stop(): Promise<void> {
    if (!this._server) return;
    return new Promise((resolve) => {
      this._server!.close(() => {
        this._server = null;
        this._logger.log?.('[A2AServer] Stopped');
        resolve();
      });
    });
  }

  get isRunning(): boolean {
    return this._server !== null;
  }

  private async _handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const method = (req.method || 'GET').toUpperCase();
    const pathname = url.pathname;
    if (this._authorize && !(await this._authorize(req))) {
      return this._sendJson(res, 401, { error: 'Unauthorized' });
    }

    // Agent card
    if (pathname === '/.well-known/agent.json' && method === 'GET') {
      return this._sendJson(res, 200, this._manager.getAgentCard());
    }

    // Create task
    if (pathname === '/tasks/send' && method === 'POST') {
      const body = await this._readBody(req);
      const task = await this._manager.createTask(
        'local',
        body.input ?? body,
        { sessionId: body.sessionId }
      );

      // Execute task asynchronously
      if (this._onTask) {
        this._onTask(task).then(result => {
          this._manager.updateTask(task.id, { status: 'completed', output: result });
        }).catch(error => {
          this._manager.updateTask(task.id, { status: 'failed', error: error?.message });
        });
      }

      return this._sendJson(res, 200, task);
    }

    // Get/cancel task by ID
    const taskMatch = pathname.match(/^\/tasks\/([^/]+)(\/cancel)?$/);
    if (taskMatch) {
      const taskId = decodeURIComponent(taskMatch[1]);
      const isCancel = taskMatch[2] === '/cancel';

      if (isCancel && method === 'POST') {
        const updated = this._manager.updateTask(taskId, { status: 'cancelled' });
        return this._sendJson(res, updated ? 200 : 404, updated || { error: 'Task not found' });
      }

      if (method === 'GET') {
        const task = this._manager.getTask(taskId);
        return this._sendJson(res, task ? 200 : 404, task || { error: 'Task not found' });
      }
    }

    this._sendJson(res, 404, { error: 'Not found' });
  }

  private _sendJson(res: http.ServerResponse, status: number, data: any): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  private _readBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
        } catch {
          resolve({});
        }
      });
      req.on('error', reject);
    });
  }
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}
