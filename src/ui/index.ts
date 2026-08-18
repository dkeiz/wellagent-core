// ---------------------------------------------------------------------------
// lib/ui/index.ts — UI layer barrel export
// ---------------------------------------------------------------------------

export {
  DEFAULT_CONTRACT,
  validateThemeTokens, parseCssTokens, tokensToCss,
} from './themes';
export type {
  ThemeTokenContract, SkinEntry, SkinManifest, ResolvedTheme,
} from './themes';

export { SkinLoader } from './skin-loader';
export type { LoadedSkin } from './skin-loader';

export {
  formatMessage, escapeHtml, stripFormatting, detectContentType,
} from './message-formatter';
export type { FormatOptions } from './message-formatter';

export {
  detectByFilename, detectByContent, detectContent,
} from './content-viewer';
export type { ContentKind, ContentDetection } from './content-viewer';
