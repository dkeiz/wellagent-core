// ---------------------------------------------------------------------------
// lib/plugins/contracts.ts — Capability contract registry
// ---------------------------------------------------------------------------

import type { CapabilityContract } from '../core/types';

/** Built-in capability contracts. */
export const BUILTIN_CONTRACTS: Record<string, CapabilityContract> = {
  tts: {
    id: 'tts.v1',
    capability: 'tts',
    version: 1,
    actions: ['speak', 'stop', 'listVoices', 'previewVoice', 'healthCheck'],
  },
  stt: {
    id: 'stt.v1',
    capability: 'stt',
    version: 1,
    actions: ['transcribeAudio'],
  },
};

/**
 * Registry for versioned capability contracts.
 *
 * Contracts define what a plugin must implement for a given capability.
 * Developers can register custom contracts for new capability types.
 *
 * Usage:
 * ```typescript
 * const registry = new ContractRegistry();
 * registry.register({ id: 'search.v1', capability: 'search', version: 1, actions: ['query'] });
 * const contract = registry.get('search');
 * ```
 */
export class ContractRegistry {
  private _contracts: Map<string, CapabilityContract>;

  constructor() {
    this._contracts = new Map();
    // Load built-in contracts
    for (const [key, contract] of Object.entries(BUILTIN_CONTRACTS)) {
      this._contracts.set(key, contract);
    }
  }

  /**
   * Register a capability contract.
   */
  register(contract: CapabilityContract): void {
    this._contracts.set(contract.capability, contract);
  }

  /**
   * Get a contract by capability name.
   */
  get(capability: string): CapabilityContract | null {
    return this._contracts.get(String(capability || '').trim()) ?? null;
  }

  /**
   * Get a contract merged with a plugin manifest's declared contract.
   */
  getManifestContract(manifest: any, capability: string): CapabilityContract | null {
    const capName = String(capability || '').trim();
    const base = this.get(capName);
    if (!base) return null;

    const declared = manifest?.capabilityContracts?.[capName]
      || manifest?.contracts?.[capName]
      || {};

    return {
      ...base,
      ...declared,
      id: declared.id || base.id,
      capability: capName,
      version: Number(declared.version || base.version),
    };
  }

  /**
   * List all registered contracts.
   */
  list(): CapabilityContract[] {
    return Array.from(this._contracts.values());
  }
}
