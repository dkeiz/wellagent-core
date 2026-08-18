// ---------------------------------------------------------------------------
// lib/gateway/index.ts — Gateway layer barrel export
// ---------------------------------------------------------------------------

export { GatewayServer } from './server';
export { createTunnel } from './tunnel';
export type { TunnelProvider, TunnelConfig, TunnelHandle, TunnelProcess, TunnelRunner } from './tunnel';
