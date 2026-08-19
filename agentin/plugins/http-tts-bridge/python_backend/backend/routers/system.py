from fastapi import APIRouter, HTTPException

from backend.catalog import SUPPORTED_TTS_ENGINES, active_model_id, build_model_catalog, normalize_tts_engine
from backend.config import settings
from backend.models import (
    HealthResponse,
    ModelDownloadRequest,
    ModelDownloadResponse,
    ModelDownloadStatusItem,
    ModelSelectRequest,
    ModelSelectResponse,
)
from backend.stability import stability_manager
from backend.state import backend_state
from backend.tts_engine import tts_engine

router = APIRouter(tags=["System"])


@router.get("/api/health", response_model=HealthResponse)
async def get_health():
    health = stability_manager.get_health_status()
    return HealthResponse(
        status=health.get("status") or "healthy",
        model_loaded=tts_engine.is_loaded,
        device=tts_engine.device or "not loaded",
        model_name=tts_engine.model_name or active_model_id(),
        uptime_seconds=health.get("uptime_seconds"),
        memory_percent=health.get("memory_usage_percent"),
        cpu_percent=health.get("cpu_usage_percent"),
    )


@router.get("/api/history")
async def get_history():
    return {"success": True, "items": backend_state.snapshot_history()}


@router.get("/api/performance")
async def get_performance():
    return {"success": True, "snapshot": backend_state.get_perf_snapshot()}


@router.get("/api/metrics")
async def get_metrics():
    return stability_manager.get_health_status()


@router.get("/api/models")
async def get_models():
    flash_probe = tts_engine.get_flash_attention_probe()
    return {
        "success": True,
        "active_model": active_model_id(),
        "loaded_model": tts_engine.model_name if tts_engine.is_loaded else None,
        "active_tts_engine": normalize_tts_engine(settings.TTS_ENGINE),
        "loaded_tts_engine": tts_engine.runtime_engine if tts_engine.is_loaded else None,
        "supported_tts_engines": list(SUPPORTED_TTS_ENGINES),
        "flash_attention_available": bool(flash_probe.get("available")),
        "flash_attn_detail": flash_probe.get("detail"),
        "flash_attn_version": flash_probe.get("module_version"),
        "active_attention_backend": tts_engine.attn_backend,
        "hf_cache_dir": str(settings.HF_CACHE_DIR),
        "items": [item.model_dump() for item in build_model_catalog()],
    }


@router.post("/api/models/select", response_model=ModelSelectResponse)
async def select_model(request: ModelSelectRequest):
    requested_model = request.model_name.strip()
    if not requested_model:
        raise HTTPException(status_code=400, detail="model_name cannot be empty")

    requested_engine = normalize_tts_engine(request.tts_engine)
    if request.tts_engine and requested_engine != str(request.tts_engine).strip().lower():
        raise HTTPException(status_code=400, detail="Only auto and faster_qwen3_tts are supported")

    source_policy = "auto_download" if request.auto_download else "offline_only"
    try:
        with backend_state.model_lock:
            tts_engine.unload_model()
            tts_engine.load_model(
                model_name=requested_model,
                use_flash_attention=request.use_flash_attention,
                model_source_policy=source_policy,
                tts_engine=requested_engine,
            )
        settings.MODEL_NAME = requested_model
        settings.MODEL_SOURCE_POLICY = source_policy
        settings.TTS_ENGINE = requested_engine
        return ModelSelectResponse(
            success=True,
            model_name=requested_model,
            loaded=tts_engine.is_loaded,
            device=tts_engine.device or "not loaded",
            message="Model is loaded and ready.",
        )
    except Exception as err:
        raise HTTPException(status_code=500, detail=f"Failed to load model '{requested_model}': {err}") from err


@router.post("/api/models/download", response_model=ModelDownloadResponse)
async def download_model(request: ModelDownloadRequest):
    model_name = request.model_name.strip()
    if not model_name:
        raise HTTPException(status_code=400, detail="model_name cannot be empty")
    if model_name.lower().startswith("piper:"):
        raise HTTPException(
            status_code=400,
            detail="Piper download is handled by the LocalAgent plugin runtime, not the backend download task.",
        )

    task = backend_state.start_model_download_task(model_name, requested_engine="faster_qwen3_tts")
    return ModelDownloadResponse(item=ModelDownloadStatusItem(**task))


@router.get("/api/models/download/{task_id}", response_model=ModelDownloadResponse)
async def get_model_download_status(task_id: str):
    task = backend_state.get_download_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Download task not found")
    return ModelDownloadResponse(item=ModelDownloadStatusItem(**task))
