# Skill: Lightweight Tool Replacements

Use this skill when a removed convenience tool is needed. Keep built-in MCP surface minimal and compose from core tools.

## Built-In Core Tools (expected)
- `search_web_bing`
- `fetch_url`
- `run_command`
- file/agent/workflow tools as needed

## Replacement Map

### `current_weather` -> `fetch_url`
Use:
```
TOOL:fetch_url{"url":"https://wttr.in/<CITY>?format=j1"}
```
Then summarize key fields from returned JSON.

### `search_web_insta` -> `search_web_bing`
Use `search_web_bing` with tighter query wording:
- add entity name
- add `site:wikipedia.org` when factual summary is needed

### `get_public_ip` -> `fetch_url`
Use:
```
TOOL:fetch_url{"url":"https://ipapi.co/json/"}
```

### `extract_text` / `search_fetched_text` -> `run_command`
If extraction/search is needed:
1. `fetch_url` target page
2. Use `run_command` with OS tools (`Select-String`, `rg`, etc.) against saved session files

### `download_file` -> `run_command`
Use shell-native downloader:
- PowerShell: `Invoke-WebRequest -Uri ... -OutFile ...`
- `curl` when available

### `clipboard_read` / `clipboard_write` -> `run_command`
Use shell-level clipboard commands only when explicitly requested.

### `get_memory_usage` / `get_disk_space` -> `get_stats` + `run_command`
- `get_stats` for app-level telemetry
- `run_command` for OS-level details

### `run_python` -> `run_command`
Call Python via shell:
```
TOOL:run_command{"command":"python script.py"}
```

## Search Policy
- Default search path: `search_web_bing` + `fetch_url`
- Optional advanced path: SearXNG plugin skill when plugin/server is available
- Fallback behavior: if plugin path is unavailable, always continue with Bing path
