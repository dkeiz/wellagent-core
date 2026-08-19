# Embedded TTS Backend

Bundled FastAPI backend used by the `http-tts-bridge` plugin.

Runtime data is stored outside this source folder:
- development: `agentin/plugins/http-tts-bridge/runtime`
- packaged app: `userData/plugins/http-tts-bridge`

The plugin starts this backend windowlessly with `run.py --no-ui`.
