import base64
import os
import tempfile
from typing import Optional

import librosa
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from backend.voice_preparer import split_audio_on_silence, transcribe_segments


router = APIRouter(tags=["STT"])


class SttTranscribeRequest(BaseModel):
    audio_base64: str = Field(..., min_length=8)
    mime_type: str = Field(default="audio/webm")
    language: Optional[str] = None
    prompt: Optional[str] = None
    min_segment_sec: float = Field(default=0.5, ge=0.5, le=10.0)
    max_segment_sec: float = Field(default=20.0, ge=2.0, le=60.0)
    top_db: float = Field(default=30.0, ge=10.0, le=60.0)


def _suffix_for_mime(mime_type: str) -> str:
    normalized = (mime_type or "").split(";", 1)[0].strip().lower()
    if normalized in {"audio/wav", "audio/wave"}:
        return ".wav"
    if normalized == "audio/mpeg":
        return ".mp3"
    if normalized == "audio/mp4":
        return ".m4a"
    if normalized == "audio/aac":
        return ".aac"
    if normalized == "audio/ogg":
        return ".ogg"
    if normalized == "audio/webm":
        return ".webm"
    return ".bin"


def _load_audio(audio_bytes: bytes, mime_type: str):
    suffix = _suffix_for_mime(mime_type)
    temp_path = ""
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as handle:
            handle.write(audio_bytes)
            temp_path = handle.name
        audio, sample_rate = librosa.load(temp_path, sr=None, mono=True)
        if audio is None or len(audio) == 0:
            raise ValueError("Audio payload was empty")
        return audio, int(sample_rate or 16000)
    finally:
        if temp_path:
            try:
                os.unlink(temp_path)
            except OSError:
                pass


@router.post("/api/stt/transcribe")
async def stt_transcribe(request: SttTranscribeRequest):
    try:
        audio_bytes = base64.b64decode(request.audio_base64, validate=True)
    except Exception as err:
        raise HTTPException(status_code=400, detail=f"Invalid audio_base64: {err}") from err

    try:
        audio, sample_rate = _load_audio(audio_bytes, request.mime_type)
        segments = split_audio_on_silence(
            audio,
            sample_rate,
            min_segment_sec=request.min_segment_sec,
            max_segment_sec=request.max_segment_sec,
            top_db=request.top_db,
        )
        transcripts = transcribe_segments(segments, sample_rate)
        text = " ".join(chunk.strip() for chunk in transcripts if chunk and chunk.strip()).strip()
        return {
            "success": True,
            "text": text,
            "detected_language": request.language or "",
            "duration_seconds": round(len(audio) / max(1, sample_rate), 3),
            "segment_count": len(segments),
            "provider": "whisper-small",
        }
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err
    except RuntimeError as err:
        raise HTTPException(status_code=503, detail=str(err)) from err
    except Exception as err:
        raise HTTPException(status_code=500, detail=str(err)) from err
