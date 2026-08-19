export type ShardStatus = 'unknown' | 'online' | 'degraded' | 'offline' | 'draining';

export interface ShardCapabilities {
  filesystem?: boolean;
  terminal?: boolean;
  knowledge?: boolean;
  audio?: boolean;
  network?: boolean;
  maxConcurrentAgents?: number;
  maxConcurrentTools?: number;
  supportedProviders?: string[];
  supportedModels?: string[];
  tags?: string[];
}

export interface ShardHealth {
  status: ShardStatus;
  lastHeartbeatAt?: string | null;
  heartbeatIntervalMs?: number | null;
  observedLatencyMs?: number | null;
  activeRuns?: number;
  deployedBundles?: number;
  load?: number | null;
  error?: string | null;
}

export interface ShardRecord {
  shardId: string;
  label: string;
  host: string;
  port: number;
  baseUrl?: string | null;
  authToken?: string | null;
  capabilities: ShardCapabilities;
  health: ShardHealth;
  runtime?: {
    version?: string;
    mode?: 'desktop' | 'headless' | 'shard-host';
    userId?: string | null;
  };
  metadata?: Record<string, any>;
  registeredAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ShardRoute {
  shardId: string;
  score: number;
  reasons: string[];
  requiredCapabilities: string[];
  missingCapabilities: string[];
  bundleId?: string | null;
}

export interface ShardDeploymentRecord {
  deploymentId: string;
  shardId: string;
  bundleId: string;
  bundleName: string;
  status: 'pending' | 'deployed' | 'failed' | 'removed';
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, any>;
}
