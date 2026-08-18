// ---------------------------------------------------------------------------
// lib/inference/prompt-builder.ts — System prompt composition
// ---------------------------------------------------------------------------

import type { ToolDefinition, Logger } from '../core/types';

/** Options for building a system prompt. */
export interface PromptBuildOptions {
  agentName?: string;
  agentSystemPrompt?: string;
  tools?: ToolDefinition[];
  rules?: string[];
  environment?: Record<string, string>;
  memory?: string[];
  userProfile?: string;
  currentDate?: string;
  customSections?: Array<{ title: string; content: string }>;
}

/**
 * Composes a system prompt from multiple sources:
 * agent persona, tools, rules, environment, memory, and custom sections.
 *
 * Usage:
 * ```typescript
 * const prompt = buildSystemPrompt({
 *   agentName: 'Research Assistant',
 *   agentSystemPrompt: 'You are a helpful research assistant.',
 *   tools: registeredTools,
 *   rules: ['Always cite sources'],
 *   memory: ['User prefers bullet points'],
 * });
 * ```
 */
export function buildSystemPrompt(options: PromptBuildOptions = {}): string {
  const sections: string[] = [];

  // Agent persona
  if (options.agentSystemPrompt) {
    sections.push(options.agentSystemPrompt.trim());
  }

  // Environment
  if (options.environment && Object.keys(options.environment).length > 0) {
    const envLines = Object.entries(options.environment)
      .map(([k, v]) => `- ${k}: ${v}`)
      .join('\n');
    sections.push(`## Environment\n${envLines}`);
  }

  // Current date
  if (options.currentDate) {
    sections.push(`Current date: ${options.currentDate}`);
  }

  // Tools
  if (options.tools && options.tools.length > 0) {
    const toolDescriptions = options.tools
      .filter(t => !t.hidden && !t.disabled)
      .map(t => {
        const params = t.parameters?.properties
          ? Object.entries(t.parameters.properties)
              .map(([name, prop]) => `    - ${name} (${prop.type}): ${prop.description || ''}`)
              .join('\n')
          : '';
        return `- **${t.name}**: ${t.description}${params ? '\n' + params : ''}`;
      })
      .join('\n');

    if (toolDescriptions) {
      sections.push(`## Available Tools\n\nUse TOOL: tool_name followed by a JSON object with parameters.\n\n${toolDescriptions}`);
    }
  }

  // Rules
  if (options.rules && options.rules.length > 0) {
    const rulesList = options.rules.map(r => `- ${r.trim()}`).join('\n');
    sections.push(`## Rules\n${rulesList}`);
  }

  // Memory
  if (options.memory && options.memory.length > 0) {
    const memList = options.memory.map(m => `- ${m.trim()}`).join('\n');
    sections.push(`## Remembered Context\n${memList}`);
  }

  // User profile
  if (options.userProfile) {
    sections.push(`## User Profile\n${options.userProfile.trim()}`);
  }

  // Custom sections
  if (options.customSections) {
    for (const section of options.customSections) {
      sections.push(`## ${section.title}\n${section.content.trim()}`);
    }
  }

  return sections.join('\n\n');
}

/**
 * Generate tool descriptions string for system prompt injection.
 */
export function formatToolDescriptions(tools: ToolDefinition[]): string {
  return tools
    .filter(t => !t.hidden && !t.disabled)
    .map(t => {
      const paramStr = t.parameters?.properties
        ? ` Parameters: ${JSON.stringify(t.parameters.properties)}`
        : '';
      return `TOOL: ${t.name} - ${t.description}${paramStr}`;
    })
    .join('\n');
}
