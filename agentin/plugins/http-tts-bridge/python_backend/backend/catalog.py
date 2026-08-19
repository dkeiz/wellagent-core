from typing import Optional

from backend.config import settings
from backend.models import ModelCatalogItem
from backend.tts_engine import tts_engine

SUPPORTED_TTS_ENGINES = ("auto", "faster_qwen3_tts")

MODEL_CATALOG = [
    {
        "id": "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
        "label": "CustomVoice 1.7B",
        "description": "Built-in Qwen speakers with the fast backend.",
    },
    {
        "id": "Qwen/Qwen3-TTS-12Hz-1.7B-Base",
        "label": "Base 1.7B",
        "description": "Qwen clone model for prepared custom voices.",
    },
    {
        "id": "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
        "label": "CustomVoice 0.6B",
        "description": "Smaller built-in Qwen model for lower latency.",
    },
    {
        "id": "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
        "label": "Base 0.6B",
        "description": "Smaller clone model for lower latency.",
    },
    {
        "id": "piper:en_US-lessac-medium",
        "label": "Piper EN Lessac",
        "description": "Fast local Piper voice.",
    },
]


def normalize_tts_engine(value: Optional[str]) -> str:
    normalized = str(value or "").strip().lower()
    if normalized in SUPPORTED_TTS_ENGINES:
        return normalized
    return "auto"


def canonical_model_id(model_name: Optional[str]) -> Optional[str]:
    if not model_name:
        return None

    normalized = str(model_name).strip()
    if not normalized:
        return None
    if normalized.lower().startswith("piper:"):
        return normalized

    for item in MODEL_CATALOG:
        if normalized == item["id"]:
            return item["id"]

    slug = normalized.replace("\\", "/").rstrip("/").rsplit("/", 1)[-1].lower()
    for item in MODEL_CATALOG:
        probe_slug = item["id"].replace("\\", "/").rstrip("/").rsplit("/", 1)[-1].lower()
        if slug == probe_slug:
            return item["id"]

    return None


def build_model_catalog() -> list[ModelCatalogItem]:
    loaded_id = canonical_model_id(tts_engine.model_name) if tts_engine.is_loaded else None
    catalog_items = list(MODEL_CATALOG)
    seen_ids = {item["id"] for item in catalog_items}

    for model_id in tts_engine.list_local_piper_model_ids():
        if model_id in seen_ids:
            continue
        voice_name = model_id.split(":", 1)[1]
        catalog_items.append(
            {
                "id": model_id,
                "label": f"Piper {voice_name}",
                "description": "Local Piper voice copied into plugin runtime.",
            }
        )
        seen_ids.add(model_id)

    items = []
    for item in catalog_items:
        probe = tts_engine.get_local_model_probe(item["id"])
        items.append(
            ModelCatalogItem(
                id=item["id"],
                label=item["label"],
                description=item["description"],
                local_available=bool(probe.get("available")),
                local_usable=bool(probe.get("usable")),
                loaded=loaded_id == item["id"],
                status=str(probe.get("status") or "missing"),
                local_path=probe.get("local_path"),
                detail=probe.get("detail"),
                incomplete_download=bool(probe.get("incomplete_download")),
            )
        )

    return items


def active_model_id() -> str:
    return canonical_model_id(settings.MODEL_NAME) or settings.MODEL_NAME
