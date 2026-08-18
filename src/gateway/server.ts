// ---------------------------------------------------------------------------
// lib/gateway/server.ts — HTTP API server for remote access
// ---------------------------------------------------------------------------

import * as http from 'http';
import type { Runtime } from '../runtime';
import type { Logger } from '../core/types';

/** Route handler type. */
type RouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: any,
  params: Record<string, string>
) => Promise<void>;

/** Route definition. */
interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

/**
 * Lightweight HTTP API server that exposes a Runtime over the network.
 *
 * No Express dependency — uses raw `http.createServer` with a micro-router.
 * Designed for companion apps, mobile clients, remote dashboards.
 *
 * Usage:
 * ```typescript
 * const server = new GatewayServer(runtime, { port: 3000 });
 * server.route('POST', '/api/chat', async (req, res, body) => {
 *   const response = await runtime.chat(body.message);
 *   server.json(res, 200, response);
 * });
 * await server.start();
 * ```
 */
export class GatewayServer {
  private _runtime: Runtime;
  private _server: http.Server | null;
  private _port: number;
  private _host: string;
  private _routes: Route[];
  private _authToken: string | null;
  private _authorize: ((req: http.IncomingMessage) => boolean | Promise<boolean>) | null;
  private _maxBodyBytes: number;
  private _logger: Logger;
  private _corsOrigin: string | null;

  constructor(
    runtime: Runtime,
    options: {
      port?: number;
      host?: string;
      authToken?: string | null;
      authorize?: (req: http.IncomingMessage) => boolean | Promise<boolean>;
      corsOrigin?: string;
      maxBodyBytes?: number;
      logger?: Logger;
    } = {}
  ) {
    this._runtime = runtime;
    this._server = null;
    this._port = options.port ?? 3000;
    this._host = options.host ?? '127.0.0.1';
    this._routes = [];
    this._authToken = options.authToken ?? null;
    this._authorize = options.authorize ?? null;
    this._maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
    this._corsOrigin = options.corsOrigin ?? null;
    this._logger = options.logger ?? console;
    if (!isLoopbackHost(this._host) && !this._authToken && !this._authorize) {
      throw new Error('GatewayServer requires host authentication when bound beyond loopback');
    }

    // Register default routes
    this._registerDefaults();
  }

  /**
   * Register a route.
   */
  route(method: string, path: string, handler: RouteHandler): void {
    // Convert /api/agents/:id to regex
    const paramNames: string[] = [];
    const pattern = path.replace(/:([^/]+)/g, (_match, name) => {
      paramNames.push(name);
      return '([^/]+)';
    });
    this._routes.push({
      method: method.toUpperCase(),
      pattern: new RegExp(`^${pattern}$`),
      paramNames,
      handler,
    });
  }

  /**
   * Start the server.
   */
  async start(): Promise<void> {
    if (this._server) return;

    this._server = http.createServer((req, res) => {
      this._handleRequest(req, res).catch(() => {
        this.json(res, 500, { error: 'Internal server error' });
      });
    });

    return new Promise((resolve, reject) => {
      this._server!.listen(this._port, this._host, () => {
        this._logger.log?.(`[GatewayServer] Listening on ${this._host}:${this._port}`);
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
    return new Promise(resolve => {
      this._server!.close(() => {
        this._server = null;
        resolve();
      });
    });
  }

  /**
   * Send a JSON response.
   */
  json(res: http.ServerResponse, status: number, data: any): void {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this._corsOrigin) headers['Access-Control-Allow-Origin'] = this._corsOrigin;
    res.writeHead(status, headers);
    res.end(JSON.stringify(data));
  }

  get isRunning(): boolean {
    return this._server !== null;
  }

  private async _handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const method = (req.method || 'GET').toUpperCase();

    // CORS preflight
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': this._corsOrigin,
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      });
      res.end();
      return;
    }

    // Host authentication is mandatory for non-loopback bindings.
    if (this._authorize) {
      if (!(await this._authorize(req))) return this.json(res, 401, { error: 'Unauthorized' });
    } else if (this._authToken) {
      const auth = String(req.headers['authorization'] || '');
      if (auth !== 'Bearer ' + this._authToken) {
        return this.json(res, 401, { error: 'Unauthorized' });
      }
    }

    // Match route
    for (const route of this._routes) {
      if (route.method !== method && route.method !== '*') continue;
      const match = url.pathname.match(route.pattern);
      if (!match) continue;

      const params: Record<string, string> = {};
      for (let i = 0; i < route.paramNames.length; i++) {
        params[route.paramNames[i]] = decodeURIComponent(match[i + 1]);
      }

      try {
        const body = method === 'GET' ? {} : await this._readBody(req);
        return route.handler(req, res, body, params);
      } catch (error: any) {
        return this.json(res, error?.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: 'Invalid request body' });
      }
    }

    this.json(res, 404, { error: 'Not found' });
  }

  private _readBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', chunk => {
        size += Buffer.byteLength(chunk);
        if (size > this._maxBodyBytes) {
          const error: any = new Error('Request body too large');
          error.code = 'BODY_TOO_LARGE';
          reject(error);
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); }
        catch { resolve({}); }
      });
      req.on('error', () => resolve({}));
    });
  }

  private _registerDefaults(): void {
    // Health check
    this.route('GET', '/api/health', async (_req, res) => {
      this.json(res, 200, { status: 'ok', started: this._runtime.isStarted });
    });

    // Chat
    this.route('POST', '/api/chat', async (_req, res, body) => {
      const response = await this._runtime.chat(body.message || body.prompt || '', {
        history: body.history,
        sessionId: body.sessionId,
        userId: body.userId,
      });
      this.json(res, 200, response);
    });

    // Agent run (with tool execution)
    this.route('POST', '/api/run', async (_req, res, body) => {
      const result = await this._runtime.run(body.message || body.prompt || '', {
        history: body.history,
        maxSteps: body.maxSteps,
        sessionId: body.sessionId,
        userId: body.userId,
      });
      this.json(res, 200, result);
    });

    // Tool execution
    this.route('POST', '/api/tools/:name', async (_req, res, body, params) => {
      const result = await this._runtime.executeTool(params.name, body.params || body);
      this.json(res, 200, result);
    });

    // List tools
    this.route('GET', '/api/tools', async (_req, res) => {
      const tools = this._runtime.tools.list().map(t => ({
        name: t.name,
        description: t.description,
        group: t.group,
        safe: t.safe,
      }));
      this.json(res, 200, { tools });
    });

    // List agents
    this.route('GET', '/api/agents', async (_req, res) => {
      const agents = await this._runtime.agents.list();
      this.json(res, 200, { agents });
    });
  }
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}
