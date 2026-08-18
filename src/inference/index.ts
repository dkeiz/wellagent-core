// ---------------------------------------------------------------------------
// lib/inference/index.ts — Inference layer barrel export
// ---------------------------------------------------------------------------

// Provider base
export { Provider } from './provider';
export type { ProviderCallOptions } from './provider';

// Built-in adapters
export { OllamaAdapter } from './adapters/ollama';
export { OpenAICompatibleAdapter } from './adapters/openai-compatible';
export { OpenRouterAdapter } from './adapters/openrouter';
export { QwenAdapter } from './adapters/qwen';
export { LMStudioAdapter } from './adapters/lmstudio';

// Dispatcher
export { Dispatcher } from './dispatcher';

// Scheduler
export { InferenceScheduler } from './scheduler';
export type { SchedulingDecision } from './scheduler';

// Context management
export {
  estimateTokens,
  estimateMessageTokens,
  normalizeMessage,
  normalizeMessages,
  buildContext,
  estimateUsage,
  ConversationContextCache,
} from './context';
export type { ContextResult, UsageEstimate, MessageCleaners } from './context';

// Prompt builder
export { buildSystemPrompt, formatToolDescriptions } from './prompt-builder';
export type { PromptBuildOptions } from './prompt-builder';

// External engines
export { ProcessEngine } from './engines/process-engine';
export type { ProcessEngineOptions, EngineStatus } from './engines/process-engine';
export { CodexEngine } from './engines/codex';
