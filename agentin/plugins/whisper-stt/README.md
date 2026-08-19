# Whisper STT plugin

This plugin owns the optional Whisper ONNX runtime. Core only calls the
stt.v1 capability contract.

Install the isolated runtime when needed with:

    npm install --omit=dev --prefix agentin/plugins/whisper-stt

The default model cache remains data/whisper-cache. The cacheDir setting can
point at another existing local cache.
