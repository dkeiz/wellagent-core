// @ts-nocheck
async function getCompanionUiState(db, options = {}) {
  const readSetting = async (key, fallback = null) => {
    if (db?.getScopedSetting && (options?.requestContext || options?.userId)) {
      const value = await db.getScopedSetting(key, options);
      return value == null || value === '' ? fallback : value;
    }
    const value = await db.getSetting(key);
    return value == null || value === '' ? fallback : value;
  };

  const theme = String(await readSetting('ui.theme', 'light')).trim() || 'light';
  const skinEnabled = (await readSetting('ui.skin.enabled', 'false')) === 'true';
  const skinId = String(await readSetting('ui.skin.id', 'default')).trim() || 'default';
  const skinTheme = String(await readSetting('ui.skin.theme', theme)).trim() || theme;
  const typeSize = Math.min(18, Math.max(11, Number.parseInt(await readSetting('ui.typeSize', '13'), 10) || 13));

  return {
    theme,
    typeSize,
    skin: {
      enabled: skinEnabled,
      id: skinEnabled ? skinId : 'default',
      theme: skinEnabled ? skinTheme : theme,
      skinHref: skinEnabled && skinId !== 'default' ? `/companion/skin-cast/${encodeURIComponent(skinId)}/skin.css` : '',
      themeHref: skinEnabled && skinId !== 'default' ? `/companion/skin-cast/${encodeURIComponent(skinId)}/themes/${encodeURIComponent(skinTheme)}.css` : ''
    }
  };
}

module.exports = {
  getCompanionUiState
};