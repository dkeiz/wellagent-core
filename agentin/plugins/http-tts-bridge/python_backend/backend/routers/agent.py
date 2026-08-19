import asyncio
import base64
import io
import json
import re
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

import soundfile as sf
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse

from backend.config import settings
from backend.models import AgentSpeakRequest, AgentSpeakResponse
from backend.stability import stability_manager
from backend.state import backend_state
from backend.tts_engine import tts_engine
from backend.voice_cloner import voice_cloner

router = APIRouter(tags=["Agent"])

AUDIO_MIME_TYPES = {
    ".wav": "audio/wav",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
}

BASE_MODEL_HELP = (
    "Load a Base model ('Qwen/Qwen3-TTS-12Hz-1.7B-Base' or "
    "'Qwen/Qwen3-TTS-12Hz-0.6B-Base') and try again."
)


def _ensure_model_loaded() -> None:
    if tts_engine.is_loaded:
        return
    with backend_state.model_lock:
        if not tts_engine.is_loaded:
            tts_engine.load_model(
                model_name=settings.MODEL_NAME,
                model_source_policy=settings.MODEL_SOURCE_POLICY,
                tts_engine=settings.TTS_ENGINE,
            )


def _ensure_generation_ready() -> None:
    if tts_engine.is_piper_model:
        return
    if settings.REQUIRE_GPU and not (tts_engine.device or "").lower().startswith("cuda"):
        raise RuntimeError(
            "GPU generation is unavailable: active model is not running on CUDA."
        )


def _split_stream_chunks(text: str) -> list[str]:
    cleaned = (text or "").strip()
    if not cleaned:
        return []

    abbreviations = ("Mr.", "Mrs.", "Ms.", "Dr.", "Prof.", "Jr.", "Sr.", "U.S.", "U.K.", "e.g.", "i.e.")
    protected = cleaned
    replacements = {}
    for index, item in enumerate(abbreviations):
        placeholder = f"\x00ABBR{index}\x00"
        if item in protected:
            replacements[placeholder] = item
            protected = protected.replace(item, placeholder)

    segments = [part.strip() for part in re.split(r"(?<=[\.\!\?\。\！\？\；])\s+", protected) if part.strip()]
    if not segments:
        segments = [cleaned]

    for placeholder, item in replacements.items():
        segments = [segment.replace(placeholder, item) for segment in segments]

    target_chars = max(20, int(settings.STREAM_LOW_LATENCY_TARGET_CHARS))
    first_target = max(12, int(settings.STREAM_LOW_LATENCY_FIRST_CHUNK_CHARS))
    chunks = []
    current = ""

    for segment in segments:
        limit = first_target if not chunks else target_chars
        candidate = f"{current} {segment}".strip() if current else segment
        if current and len(candidate) > limit:
            chunks.append(current)
            current = segment
        else:
            current = candidate

    if current:
        chunks.append(current)
    return chunks


def _resolve_voice_context(voice: str) -> tuple[str, list[Path], Optional[str]]:
    requested_voice = (voice or settings.BUILTIN_SPEAKERS[0]).strip()
    if tts_engine.is_piper_model:
        return requested_voice, [], None

    available_speakers = set(settings.BUILTIN_SPEAKERS)
    available_speakers.update(item["name"] for item in voice_cloner.list_voices())
    if requested_voice not in available_speakers:
        raise ValueError(f"Unknown speaker '{requested_voice}'")

    reference_audio_paths = []
    reference_text = None
    if requested_voice not in settings.BUILTIN_SPEAKERS:
        reference_audio_paths = voice_cloner.get_voice_samples(requested_voice)
        reference_text = voice_cloner.get_voice_ref_text(requested_voice) if settings.VOICE_CLONE_USE_REF_TEXT else None

    model_type = tts_engine.get_model_tts_type()
    if requested_voice in settings.BUILTIN_SPEAKERS and model_type == "base":
        raise ValueError(
            "Loaded model is Base (voice cloning only). "
            "Built-in speakers are unavailable. Select a cloned custom voice or load CustomVoice model."
        )
    if requested_voice not in settings.BUILTIN_SPEAKERS and not reference_audio_paths:
        raise ValueError(f"Custom voice '{requested_voice}' has no samples. Re-upload samples and try again.")
    if requested_voice not in settings.BUILTIN_SPEAKERS and model_type and model_type != "base":
        raise ValueError("Custom voice cloning requires the Base model. " + BASE_MODEL_HELP)

    return requested_voice, reference_audio_paths, reference_text


def _generate_audio(text: str, voice: str, language: str, style: Optional[str]):
    _ensure_model_loaded()
    _ensure_generation_ready()

    normalized_language = (language or "auto").lower()
    if normalized_language not in settings.SUPPORTED_LANGUAGES:
        raise ValueError(
            f"Unsupported language '{language}'. Supported: {', '.join(settings.SUPPORTED_LANGUAGES)}"
        )

    with backend_state.model_lock:
        resolved_voice, reference_audio_paths, reference_text = _resolve_voice_context(voice)
        audio, sample_rate = tts_engine.generate(
            text=text,
            speaker=resolved_voice,
            language=normalized_language,
            instruct=style,
            reference_audio_paths=reference_audio_paths or None,
            reference_text=reference_text,
        )
    return resolved_voice, normalized_language, audio, sample_rate


def _save_generation(text: str, voice: str, language: str, style: Optional[str], output_format: str, include_base64: bool):
    generation_started = time.perf_counter()
    resolved_voice, normalized_language, audio, sample_rate = _generate_audio(text, voice, language, style)
    generation_time = time.perf_counter() - generation_started

    request_id = uuid.uuid4().hex[:16]
    filename = f"agent_{request_id}.{output_format}"
    filepath = tts_engine.save_audio(audio, sample_rate, filename, audio_format=output_format)
    duration = round(len(audio) / sample_rate, 3)

    history_item = {
        "text": text[:140],
        "speaker": resolved_voice,
        "duration": duration,
        "generation_time": round(generation_time, 3),
        "audio_url": f"/api/audio/{filename}",
        "created_at": datetime.now().isoformat(),
    }
    backend_state.append_history(history_item)
    stability_manager.record_request(generation_time, True)

    audio_base64 = None
    if include_base64:
        audio_base64 = base64.b64encode(filepath.read_bytes()).decode("ascii")

    return {
        "request_id": request_id,
        "voice": resolved_voice,
        "language": normalized_language,
        "audio_url": f"/api/audio/{filename}",
        "audio_base64": audio_base64,
        "mime_type": AUDIO_MIME_TYPES.get(filepath.suffix.lower(), "application/octet-stream"),
        "duration": duration,
        "sample_rate": sample_rate,
        "created_at": datetime.now().isoformat(),
        "message": "Agent speech generated successfully",
        "audio_path": str(filepath),
        "generation_time": round(generation_time, 3),
    }


@router.get("/api/audio/{filename}")
async def get_audio(filename: str):
    file_path = settings.OUTPUT_DIR / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Audio file not found")
    return FileResponse(
        path=str(file_path),
        media_type=AUDIO_MIME_TYPES.get(file_path.suffix.lower(), "application/octet-stream"),
        filename=file_path.name,
    )


@router.post("/api/agent/speak", response_model=AgentSpeakResponse)
async def agent_speak(request: AgentSpeakRequest):
    try:
        result = _save_generation(
            text=request.text,
            voice=request.voice,
            language=request.language,
            style=request.style,
            output_format=request.output_format,
            include_base64=request.include_base64,
        )
        return AgentSpeakResponse(
            success=True,
            request_id=request.request_id or result["request_id"],
            text=request.text,
            voice=result["voice"],
            language=result["language"],
            model_name=tts_engine.model_name or settings.MODEL_NAME,
            audio_url=result["audio_url"],
            audio_base64=result["audio_base64"],
            mime_type=result["mime_type"],
            duration=result["duration"],
            sample_rate=result["sample_rate"],
            created_at=result["created_at"],
            message=result["message"],
            metadata=request.metadata,
        )
    except ValueError as err:
        stability_manager.record_request(0.0, False, str(err))
        raise HTTPException(status_code=400, detail=str(err)) from err
    except RuntimeError as err:
        stability_manager.record_request(0.0, False, str(err))
        raise HTTPException(status_code=503, detail=str(err)) from err
    except Exception as err:
        stability_manager.record_request(0.0, False, str(err))
        raise HTTPException(status_code=500, detail=str(err)) from err


@router.post("/api/agent/speak/stream")
async def agent_speak_stream(request: AgentSpeakRequest, raw_request: Request):
    chunks = _split_stream_chunks(request.text)
    if not chunks:
        raise HTTPException(status_code=400, detail="Text cannot be empty")

    async def event_stream():
        started = time.perf_counter()
        first_chunk_latency = None
        total_generation_time = 0.0
        yield f"event: start\ndata: {json.dumps({'total_chunks': len(chunks), 'voice': request.voice})}\n\n"

        for index, chunk_text in enumerate(chunks, start=1):
            if await raw_request.is_disconnected():
                return
            try:
                chunk_started = time.perf_counter()
                resolved_voice, normalized_language, audio, sample_rate = await asyncio.to_thread(
                    _generate_audio,
                    chunk_text,
                    request.voice,
                    request.language,
                    request.style,
                )
                generation_time = time.perf_counter() - chunk_started
                total_generation_time += generation_time

                wav_buffer = io.BytesIO()
                sf.write(wav_buffer, audio, sample_rate, format="WAV")
                payload = {
                    "chunk_index": index,
                    "total_chunks": len(chunks),
                    "voice": resolved_voice,
                    "language": normalized_language,
                    "duration": round(len(audio) / sample_rate, 3),
                    "generation_time": round(generation_time, 3),
                    "audio_base64": base64.b64encode(wav_buffer.getvalue()).decode("ascii"),
                    "sample_rate": sample_rate,
                    "mime_type": "audio/wav",
                }
                if first_chunk_latency is None:
                    first_chunk_latency = round(time.perf_counter() - started, 3)
                payload["first_chunk_latency"] = first_chunk_latency
                yield f"event: chunk\ndata: {json.dumps(payload)}\n\n"
            except Exception as err:
                stability_manager.record_request(0.0, False, str(err))
                yield f"event: error\ndata: {json.dumps({'message': str(err), 'chunk_index': index})}\n\n"
                return

        final_stats = {
            "first_chunk_latency": first_chunk_latency,
            "generation_time": round(total_generation_time, 3),
            "chunk_count": len(chunks),
            "voice": request.voice,
        }
        backend_state.set_last_stream_stats(final_stats)
        backend_state.append_history(
            {
                "text": request.text[:140],
                "speaker": request.voice,
                "generation_time": round(total_generation_time, 3),
                "first_chunk_latency": first_chunk_latency,
                "created_at": datetime.now().isoformat(),
                "streamed": True,
            }
        )
        stability_manager.record_request(total_generation_time, True)
        yield f"event: done\ndata: {json.dumps(final_stats)}\n\n"

    headers = {
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    }
    return StreamingResponse(event_stream(), media_type="text/event-stream", headers=headers)
