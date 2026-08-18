// --- LLM / Inference types ---

export type LlmProviderName =
  | 'ollama'
  | 'openai'
  | 'openai-compatible'
  | 'openrouter'
  | 'qwen'
  | 'lmstudio'
  | 'codex-cli'
  | 'local-codex'
  | 'opencode'
  | string;

export type ThinkingMode = 'disabled' | 'enabled' | 'auto' | 'budget' | string;

export type ThinkingVisibility = 'show' | 'hide' | 'collapse' | string;

export interface LlmSelection {
  provider: LlmProviderName;
  model: string;
  providerLabel?: string;
}

export interface LlmModelSpec {
  id: string;
  name: string;
  provider: LlmProviderName;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsStreaming?: boolean;
  supportsThinking?: boolean;
  supportsVision?: boolean;
  supportsTools?: boolean;
  supportsFunctions?: boolean;
  category?: string;
  description?: string;
}

export interface InferenceRequestOptions {
  provider?: LlmProviderName;
  model?: string;
  mode?: 'chat' | 'internal' | 'connector' | 'port-listener' | string;
  sessionId?: string;
  systemPrompt?: string;
  messages?: InferenceMessage[];
  tools?: any[];
  temperature?: number;
  maxTokens?: number;
  contextWindow?: number;
  stream?: boolean;
  thinkingMode?: ThinkingMode;
  thinkingBudget?: number;
  agentId?: number | null;
  agentContext?: any;
  runId?: string | null;
  requestContext?: any;
  onToken?: (token: string) => void;
  onThinking?: (text: string) => void;
  signal?: AbortSignal;
  [key: string]: any;
}

export interface InferenceMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: any[];
  thinking?: string;
}

export interface InferenceResponse {
  content: string;
  thinking?: string;
  toolCalls?: any[];
  model?: string;
  provider?: LlmProviderName;
  usage?: InferenceUsage;
  finishReason?: string;
  runId?: string;
}

export interface InferenceUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  thinkingTokens?: number;
}

export interface StreamChunk {
  type: 'token' | 'thinking' | 'tool_call' | 'done' | 'error';
  content?: string;
  toolCall?: any;
  error?: string;
  usage?: InferenceUsage;
}

export interface ProviderAdapterConfig {
  provider: LlmProviderName;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeout?: number;
  [key: string]: any;
}

export interface ProviderAdapter {
  provider: LlmProviderName;
  sendMessage(messages: InferenceMessage[], options?: InferenceRequestOptions): Promise<InferenceResponse>;
  streamMessage?(messages: InferenceMessage[], options?: InferenceRequestOptions): AsyncIterable<StreamChunk>;
  listModels?(): Promise<LlmModelSpec[]>;
  validateConnection?(): Promise<boolean>;
}
