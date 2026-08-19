// @ts-nocheck
(function bootstrapAndroidAppInstallPrompt(global) {
  const DISMISS_KEY = 'localagent.androidAppPrompt.dismissedAt';
  const DISMISS_MS = 7 * 24 * 60 * 60 * 1000;

  function shouldRun() {
    const ua = String(global.navigator.userAgent || '').toLowerCase();
    if (!ua.includes('android')) return false;
    if (global.ReactNativeWebView) return false;
    const dismissedAt = Number(global.localStorage.getItem(DISMISS_KEY) || 0);
    return !dismissedAt || Date.now() - dismissedAt > DISMISS_MS;
  }

  function buildPrompt(androidApp) {
    const prompt = document.createElement('section');
    prompt.className = 'app-install-prompt';
    prompt.innerHTML = `
      <div class="app-install-copy">
        <strong>Android app can use native microphone</strong>
        <span>Use it when browser mic or certificate setup gets in the way.</span>
      </div>
      <div class="app-install-actions">
        <a class="secondary-btn compact-btn" href="${androidApp.openUrl || '#'}">Open</a>
        ${androidApp.downloadUrl ? `<a class="primary-btn compact-btn" href="${androidApp.downloadUrl}">Download</a>` : ''}
        <button class="ghost-btn compact-btn" type="button">Later</button>
      </div>
    `;
    const dismissButton = prompt.querySelector('button');
    if (dismissButton) {
      dismissButton.addEventListener('click', () => {
        global.localStorage.setItem(DISMISS_KEY, String(Date.now()));
        prompt.remove();
      });
    }
    return prompt;
  }

  async function init() {
    if (!shouldRun()) return;
    const insecure = !global.isSecureContext;
    try {
      const response = await fetch(`/companion/app/android/status${global.location.search || ''}`);
      const payload = await response.json();
      const androidApp = (payload && payload.androidApp) || {};
      if (!insecure && !androidApp.available) return;
      document.body.appendChild(buildPrompt(androidApp));
    } catch (_) {
      if (!insecure) return;
      document.body.appendChild(buildPrompt({ openUrl: 'localagent-companion://companion' }));
    }
  }

  global.addEventListener('DOMContentLoaded', init);
})(window);
