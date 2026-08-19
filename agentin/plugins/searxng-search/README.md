# SearXNG Search Plugin

Toggle this plugin on to register:
- `plugin_searxng_search_discover`
- `plugin_searxng_search_search`
- `plugin_searxng_search_server_status`

Configure in Plugin Studio:
- `baseUrl`
- `enableLocalServer` (recommended: true)
- `localServerHost` (default: `127.0.0.1`)
- `localServerPort` (`0` = auto-assign)
- `discoveryUrls` (comma-separated base URLs)
- `backendMode` (`embedded` or `remote`)
- `backendAutoStart` (start embedded backend on plugin enable)
- `backendCommand` (e.g. python executable path)
- `backendArgs` (e.g. `-m searx.webapp`)
- `backendWorkingDir`
- `backendBaseUrl` (default: `http://127.0.0.1:8080`)
- `backendHealthPath` (default: `/search?q=healthcheck&format=json`)
- `backendStartupTimeoutMs`
- `timeoutMs`
- `retryCount`

When `enableLocalServer=true`, the plugin starts a local personal proxy server and routes searches through it.
When `backendMode=embedded`, plugin can also start/stop the search backend process silently.
