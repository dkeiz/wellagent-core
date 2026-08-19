import threading

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.config import ensure_directories, settings
from backend.routers.agent import router as agent_router
from backend.routers.stt import router as stt_router
from backend.routers.system import router as system_router
from backend.routers.voices import router as voices_router
from backend.tts_engine import tts_engine


app = FastAPI(
    title="LocalAgent Embedded TTS Backend",
    version="1.0.0",
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
)


if settings.ENABLE_CORS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )


def _preload_initial_model() -> None:
    if settings.DEFER_MODEL_LOAD_ON_STARTUP:
        return
    try:
        tts_engine.load_model(
            model_name=settings.MODEL_NAME,
            model_source_policy=settings.MODEL_SOURCE_POLICY,
            tts_engine=settings.TTS_ENGINE,
        )
    except Exception:
        # Startup should stay resilient. Health/status endpoints surface the error later.
        pass


@app.on_event("startup")
async def on_startup():
    ensure_directories()
    threading.Thread(target=_preload_initial_model, daemon=True, name="tts-preload").start()


@app.get("/")
async def get_root():
    return {
        "success": True,
        "name": "LocalAgent Embedded TTS Backend",
        "health_url": "/api/health",
        "docs_url": "/api/docs",
    }


@app.get("/health")
async def get_health_alias():
    return {
        "success": True,
        "status": "ok",
        "redirect_hint": "/api/health",
    }


app.include_router(system_router)
app.include_router(voices_router)
app.include_router(agent_router)
app.include_router(stt_router)
