// @ts-nocheck
(function bootstrapCompanionUiState(global) {
  function setLink(id, href) {
    let link = document.getElementById(id);
    if (!href) {
      if (link) link.remove();
      return;
    }
    if (!link) {
      link = document.createElement('link');
      link.id = id;
      link.rel = 'stylesheet';
      const parityLink = document.getElementById('companion-parity-link');
      if (parityLink) {
        document.head.insertBefore(link, parityLink);
      } else {
        document.head.appendChild(link);
      }
    }
    if (link.getAttribute('href') !== href) {
      link.setAttribute('href', href);
    }
  }

  function apply(ui = {}) {
    const skin = ui.skin || {};
    const skinId = String(skin.id || 'default').trim() || 'default';
    const skinEnabled = skin.enabled !== false && skinId !== 'default';
    const theme = String((skinEnabled ? (skin.theme || ui.theme) : (ui.theme || skin.theme)) || 'light').trim() || 'light';
    const skinTheme = String(skin.theme || theme).trim() || theme;
    const typeSize = Math.min(18, Math.max(11, Number.parseInt(ui.typeSize || 13, 10) || 13));

    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.setAttribute('data-active-skin', skinId);
    document.documentElement.setAttribute('data-skin-theme-token', skinTheme);
    document.documentElement.style.setProperty('--type-base', `${typeSize}px`);
    setLink('companion-active-skin-link', skin.skinHref || '');
    setLink('companion-active-skin-theme-link', skin.themeHref || '');
  }

  global.LocalAgentCompanionUiState = { apply };
})(window);
