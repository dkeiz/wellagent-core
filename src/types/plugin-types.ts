// --- Plugin types ---

export interface PluginManifest {
  id: string;
  name: string;
  version?: string;
  description?: string;
  author?: string;
  entrypoint?: string;
  capabilities?: PluginCapability[];
  tools?: string[];
  settings?: PluginSettingDefinition[];
  dependencies?: string[];
  runtime?: PluginRuntimeHints;
}

export interface PluginCapability {
  type: string;
  name?: string;
  description?: string;
  config?: Record<string, any>;
}

export interface PluginSettingDefinition {
  key: string;
  label?: string;
  type: 'string' | 'number' | 'boolean' | 'select' | 'password' | string;
  default?: any;
  required?: boolean;
  options?: Array<{ label: string; value: any }>;
  description?: string;
}

export interface PluginRuntimeHints {
  needsProcess?: boolean;
  needsNetwork?: boolean;
  needsFilesystem?: boolean;
  needsTerminal?: boolean;
  processArgs?: string[];
  processEnv?: Record<string, string>;
}

export type PluginStatus = 'enabled' | 'disabled' | 'error' | 'loading' | 'unloaded';

export interface PluginInstance {
  id: string;
  manifest: PluginManifest;
  status: PluginStatus;
  enabled: boolean;
  error?: string | null;
  tools?: string[];
  process?: any;
  module?: any;
  config?: Record<string, any>;
}

export interface PluginState {
  pluginId: string;
  enabled: boolean;
  config?: Record<string, any>;
  lastError?: string | null;
  enabledAt?: string;
  disabledAt?: string;
}
