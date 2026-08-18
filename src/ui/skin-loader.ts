// ---------------------------------------------------------------------------
// lib/ui/skin-loader.ts — Skin discovery, validation, CSS injection
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';
import type { SkinManifest, SkinEntry, ThemeTokenContract } from './themes';
import { DEFAULT_CONTRACT, validateThemeTokens, parseCssTokens } from './themes';
import type { Logger } from '../core/types';

/** Loaded skin with its CSS content. */
export interface LoadedSkin {
  entry: SkinEntry;
  css: string;
  tokens: Record<string, string>;
  valid: boolean;
  missingTokens: string[];
}

/**
 * Discovers and loads skins from a directory.
 *
 * Expected directory structure:
 * ```
 * skins/
 * ├── manifest.json
 * ├── default/
 * │   └── theme.css
 * ├── design-a/
 * │   └── theme.css
 * ```
 *
 * Usage:
 * ```typescript
 * const loader = new SkinLoader('./skins');
 * const manifest = loader.loadManifest();
 * const skin = loader.loadSkin('design-a');
 * if (skin.valid) injectCss(skin.css);
 * ```
 */
export class SkinLoader {
  private _skinsDir: string;
  private _contract: ThemeTokenContract;
  private _manifest: SkinManifest | null;
  private _cache: Map<string, LoadedSkin>;
  private _logger: Logger;

  constructor(
    skinsDir: string,
    options: { contract?: ThemeTokenContract; logger?: Logger } = {}
  ) {
    this._skinsDir = skinsDir;
    this._contract = options.contract ?? DEFAULT_CONTRACT;
    this._manifest = null;
    this._cache = new Map();
    this._logger = options.logger ?? console;
  }

  /**
   * Load the skin manifest.
   */
  loadManifest(): SkinManifest | null {
    if (this._manifest) return this._manifest;

    const manifestPath = path.join(this._skinsDir, 'manifest.json');
    try {
      const raw = fs.readFileSync(manifestPath, 'utf-8');
      this._manifest = JSON.parse(raw) as SkinManifest;
      return this._manifest;
    } catch (error: any) {
      this._logger.warn?.(`[SkinLoader] Failed to load manifest:`, error?.message);
      return null;
    }
  }

  /**
   * List available skins.
   */
  listSkins(): SkinEntry[] {
    const manifest = this.loadManifest();
    return manifest?.skins || [];
  }

  /**
   * Load a specific skin by ID. Returns CSS content + validation result.
   */
  loadSkin(skinId: string, themeId?: string): LoadedSkin | null {
    const cacheKey = `${skinId}:${themeId || 'default'}`;
    const cached = this._cache.get(cacheKey);
    if (cached) return cached;

    const manifest = this.loadManifest();
    const entry = manifest?.skins.find(s => s.id === skinId);
    if (!entry) return null;

    // Find CSS file
    const skinDir = path.join(this._skinsDir, skinId);
    const cssPath = themeId
      ? path.join(skinDir, `${themeId}.css`)
      : path.join(skinDir, 'theme.css');

    let css = '';
    try {
      css = fs.readFileSync(
        fs.existsSync(cssPath) ? cssPath : path.join(skinDir, 'theme.css'),
        'utf-8'
      );
    } catch (error: any) {
      this._logger.warn?.(`[SkinLoader] Failed to load CSS for skin "${skinId}":`, error?.message);
      return null;
    }

    const tokens = parseCssTokens(css);
    const validation = validateThemeTokens(tokens, this._contract);

    const loaded: LoadedSkin = {
      entry,
      css,
      tokens,
      valid: validation.valid,
      missingTokens: validation.missing,
    };

    this._cache.set(cacheKey, loaded);
    return loaded;
  }

  /**
   * Validate all skins and return a report.
   */
  validateAll(): Array<{ skinId: string; valid: boolean; missing: string[] }> {
    const manifest = this.loadManifest();
    if (!manifest) return [];

    return manifest.skins.map(entry => {
      const loaded = this.loadSkin(entry.id);
      return {
        skinId: entry.id,
        valid: loaded?.valid ?? false,
        missing: loaded?.missingTokens ?? [],
      };
    });
  }

  /**
   * Clear the cache.
   */
  clearCache(): void {
    this._cache.clear();
  }
}
