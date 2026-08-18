// ---------------------------------------------------------------------------
// lib/ui/themes.ts — Theme token contract and resolver
// ---------------------------------------------------------------------------

/** Required theme tokens (from the skin contract). */
export interface ThemeTokenContract {
  requiredIds: string[];
  requiredThemeTokens: string[];
  requiredUiTokens: string[];
  requiredAliasTokens: string[];
}

/** Skin manifest entry. */
export interface SkinEntry {
  id: string;
  name: string;
  compatible: boolean;
  description?: string;
  source?: string;
  supportedThemes: string[];
  defaultTheme?: string;
  themeLabels?: Record<string, string>;
  preview?: { base?: string; sidebar?: string; accent?: string };
}

/** Skin manifest. */
export interface SkinManifest {
  version: number;
  defaultSkinId: string;
  skins: SkinEntry[];
}

/** A resolved theme — maps token names to CSS values. */
export interface ResolvedTheme {
  skinId: string;
  themeId: string;
  tokens: Record<string, string>;
}

/** Default theme token contract. */
export const DEFAULT_CONTRACT: ThemeTokenContract = {
  requiredIds: [
    'left-sidebar', 'right-panel', 'chat-tab', 'settings-tab',
    'mcp-tab', 'workflows-tab', 'llm-tab', 'api-tab', 'tools-tab',
    'messages-container', 'message-input', 'send-btn', 'stop-btn',
    'theme-picker', 'skin-picker',
  ],
  requiredThemeTokens: [
    '--main-bg', '--sidebar-bg', '--chat-bg', '--card-bg',
    '--bg-secondary', '--bg-tertiary',
    '--text-primary', '--text-secondary', '--text-muted', '--text-color',
    '--border-color', '--hover-bg', '--active-bg', '--primary-color',
    '--user-msg-bg', '--user-msg-text', '--input-bg',
  ],
  requiredUiTokens: [
    '--space-1', '--space-2', '--space-3', '--space-4', '--space-6',
    '--control-h-sm', '--control-h-md', '--control-h-lg',
    '--radius-sm', '--radius-md', '--radius-lg',
    '--text-xs', '--text-sm', '--text-md', '--text-lg',
  ],
  requiredAliasTokens: [
    '--accent-color', '--accent-hover', '--accent-rgb',
    '--bg-primary', '--background-color', '--background-color-light',
    '--text-tertiary',
  ],
};

/**
 * Validate a CSS string or token map against the theme contract.
 * Returns missing tokens.
 */
export function validateThemeTokens(
  css: string | Record<string, string>,
  contract: ThemeTokenContract = DEFAULT_CONTRACT
): { valid: boolean; missing: string[] } {
  const allRequired = [
    ...contract.requiredThemeTokens,
    ...contract.requiredUiTokens,
    ...contract.requiredAliasTokens,
  ];

  const missing: string[] = [];

  if (typeof css === 'string') {
    for (const token of allRequired) {
      if (!css.includes(token)) missing.push(token);
    }
  } else {
    for (const token of allRequired) {
      if (!(token in css)) missing.push(token);
    }
  }

  return { valid: missing.length === 0, missing };
}

/**
 * Parse CSS custom properties from a CSS string.
 */
export function parseCssTokens(css: string): Record<string, string> {
  const tokens: Record<string, string> = {};
  const regex = /(--[a-zA-Z0-9_-]+)\s*:\s*([^;]+)/g;
  let match;
  while ((match = regex.exec(css)) !== null) {
    tokens[match[1].trim()] = match[2].trim();
  }
  return tokens;
}

/**
 * Generate a CSS :root block from a token map.
 */
export function tokensToCss(tokens: Record<string, string>): string {
  const lines = Object.entries(tokens)
    .map(([key, value]) => `  ${key}: ${value};`)
    .join('\n');
  return `:root {\n${lines}\n}`;
}
