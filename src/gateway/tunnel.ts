// ---------------------------------------------------------------------------
// lib/gateway/tunnel.ts — Opt-in tunnel process coordination
// ---------------------------------------------------------------------------

import type { Logger } from '../core/types';

export type TunnelProvider = 'cloudflare' | 'ngrok' | 'custom';

export interface TunnelProcess {
  stdout?: { on(event: 'data', listener: (data: Buffer) => void): unknown };
  stderr?: { on(event: 'data', listener: (data: Buffer) => void): unknown };
  on(event: 'error', listener: (error: Error) => void): unknown;
  kill(signal?: string): void;
}

export interface TunnelRunner {
  start(command: string, args: string[]): TunnelProcess;
}

export interface TunnelConfig {
  provider: TunnelProvider;
  localPort: number;
  token?: string;
  command?: string;
  args?: string[];
  runner: TunnelRunner;
}

export interface TunnelHandle {
  provider: TunnelProvider;
  url: string | null;
  stop: () => void;
}

/**
 * Starts no process by itself. The host supplies the runner so process policy,
 * executable discovery, and audit logging remain application-owned.
 */
export async function createTunnel(
  config: TunnelConfig,
  logger: Logger = console,
): Promise<TunnelHandle> {
  if (!config.runner) {
    throw new Error('Tunnel creation requires a host-supplied process runner');
  }
  const { command, args } = resolveCommand(config);
  const process = config.runner.start(command, args);

  return new Promise<TunnelHandle>((resolve) => {
    let resolved = false;
    const handle: TunnelHandle = {
      provider: config.provider,
      url: null,
      stop: () => process.kill('SIGTERM'),
    };
    const resolveUrl = (data: Buffer): void => {
      const output = data.toString();
      logger.log?.('[Tunnel:' + config.provider + '] ' + output.trim());
      if (resolved) return;
      const match = output.match(/(https?:\/\/[^\s]+\.(?:trycloudflare\.com|ngrok\.io|ngrok-free\.app)[^\s]*)/i);
      if (!match) return;
      handle.url = match[1];
      resolved = true;
      resolve(handle);
    };

    process.stdout?.on('data', resolveUrl);
    process.stderr?.on('data', resolveUrl);
    process.on('error', () => {
      if (!resolved) {
        resolved = true;
        resolve(handle);
      }
    });
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve(handle);
      }
    }, 15000);
  });
}

function resolveCommand(config: TunnelConfig): { command: string; args: string[] } {
  switch (config.provider) {
    case 'cloudflare':
      return {
        command: 'cloudflared',
        args: ['tunnel', '--url', 'http://127.0.0.1:' + config.localPort]
          .concat(config.token ? ['--token', config.token] : []),
      };
    case 'ngrok':
      return {
        command: 'ngrok',
        args: ['http', String(config.localPort)]
          .concat(config.token ? ['--authtoken', config.token] : []),
      };
    case 'custom':
      if (!config.command) throw new Error('Custom tunnel requires a command');
      return { command: config.command, args: config.args || [] };
    default:
      throw new Error('Unknown tunnel provider: ' + config.provider);
  }
}
