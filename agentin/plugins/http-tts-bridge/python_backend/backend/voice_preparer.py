"""
Voice Preparer Module
=====================

Splits a long audio file on silence boundaries, transcribes each segment
with Whisper, and bundles everything into a voice-clone-ready profile.

The output is a standard voice directory (samples/ + metadata.json) that
the existing VoiceCloner and TTS engine can consume directly.

Usage (backend-only):
    from backend.voice_preparer import voice_preparer

    task = voice_preparer.prepare(
        source_path="voices/my_audio.mp3",
        speaker_name="my_clone",
    )
"""

import logging
import json
import os
import uuid
import threading
import time
from pathlib import Path
from typing import Optional, List, Tuple
from datetime import datetime

os.environ.setdefault("USE_TF", "0")
os.environ.setdefault("TRANSFORMERS_NO_TF", "1")

import numpy as np
import librosa
import soundfile as sf
from huggingface_hub.errors import LocalEntryNotFoundError

from backend.config import settings

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# In-memory task tracking (mirrors model download pattern)
# ---------------------------------------------------------------------------
_prep_lock = threading.Lock()
_prep_tasks: dict[str, dict] = {}


def _task_snapshot(task: dict) -> dict:
    """Return a JSON-safe snapshot of a task."""
    return {
        "task_id": task["task_id"],
        "speaker_name": task["speaker_name"],
        "source_file": task["source_file"],
        "status": task["status"],
        "stage": task.get("stage", ""),
        "progress_percent": float(task.get("progress_percent") or 0.0),
        "segments_found": int(task.get("segments_found") or 0),
        "segments_transcribed": int(task.get("segments_transcribed") or 0),
        "message": task.get("message"),
        "error": task.get("error"),
        "created_at": task.get("created_at"),
        "finished_at": task.get("finished_at"),
    }


# ---------------------------------------------------------------------------
# Audio splitting
# ---------------------------------------------------------------------------

def split_audio_on_silence(
    audio: np.ndarray,
    sr: int,
    min_segment_sec: float = 3.0,
    max_segment_sec: float = 15.0,
    top_db: float = 30.0,
    min_silence_len_sec: float = 0.3,
) -> List[np.ndarray]:
    """
    Split an audio array on silence boundaries.

    Returns a list of numpy arrays, each containing one speech segment.
    Segments shorter than *min_segment_sec* are merged with the previous
    segment.  Segments longer than *max_segment_sec* are hard-cut.
    """
    # Use librosa's split (inverse of trim – returns non-silent intervals)
    intervals = librosa.effects.split(
        audio,
        top_db=top_db,
        frame_length=int(sr * 0.025),  # 25 ms frames
        hop_length=int(sr * 0.010),    # 10 ms hops
    )

    if len(intervals) == 0:
        logger.warning("No non-silent intervals found; returning full audio as one segment")
        return [audio]

    min_samples = int(min_segment_sec * sr)
    max_samples = int(max_segment_sec * sr)
    min_silence_samples = int(min_silence_len_sec * sr)

    # Merge intervals that are very close together
    merged: List[Tuple[int, int]] = []
    for start, end in intervals:
        if merged and (start - merged[-1][1]) < min_silence_samples:
            merged[-1] = (merged[-1][0], end)
        else:
            merged.append((start, end))

    # Merge very short segments with the previous one
    final_intervals: List[Tuple[int, int]] = []
    for start, end in merged:
        if final_intervals and (end - start) < min_samples:
            final_intervals[-1] = (final_intervals[-1][0], end)
        else:
            final_intervals.append((start, end))

    # Hard-cut segments that are too long
    segments: List[np.ndarray] = []
    for start, end in final_intervals:
        chunk = audio[start:end]
        while len(chunk) > max_samples:
            segments.append(chunk[:max_samples])
            chunk = chunk[max_samples:]
        if len(chunk) >= min_samples:
            segments.append(chunk)
        elif segments:
            # Append short tail to previous segment if it won't exceed max
            prev = segments[-1]
            if len(prev) + len(chunk) <= max_samples:
                segments[-1] = np.concatenate([prev, chunk])
            else:
                segments.append(chunk)
        else:
            segments.append(chunk)

    return segments


# ---------------------------------------------------------------------------
# Transcription
# ---------------------------------------------------------------------------

_whisper_pipeline = None
_whisper_lock = threading.Lock()


def _get_whisper_pipeline():
    """Lazy-load the Whisper pipeline (first call downloads the model)."""
    global _whisper_pipeline
    if _whisper_pipeline is not None:
        return _whisper_pipeline

    with _whisper_lock:
        if _whisper_pipeline is not None:
            return _whisper_pipeline

        os.environ.setdefault("USE_TF", "0")
        os.environ.setdefault("TRANSFORMERS_NO_TF", "1")

        import torch
        from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor, pipeline

        device_str = "cuda:0" if torch.cuda.is_available() else "cpu"
        torch_dtype = torch.float16 if device_str.startswith("cuda") else torch.float32
        model_id = os.environ.get("STT_WHISPER_MODEL", "openai/whisper-small")

        logger.info("Loading Whisper pipeline (%s) on %s ...", model_id, device_str)
        try:
            model = AutoModelForSpeechSeq2Seq.from_pretrained(
                model_id,
                torch_dtype=torch_dtype,
                low_cpu_mem_usage=True,
                local_files_only=True,
            )
            model.to(device_str)
            processor = AutoProcessor.from_pretrained(model_id, local_files_only=True)
        except LocalEntryNotFoundError as err:
            raise RuntimeError(
                f"Local STT model is missing: {model_id}. Download the model before using desktop STT."
            ) from err
        _whisper_pipeline = pipeline(
            "automatic-speech-recognition",
            model=model,
            tokenizer=processor.tokenizer,
            feature_extractor=processor.feature_extractor,
            device=device_str,
            torch_dtype=torch_dtype,
            framework="pt",
        )
        logger.info("Whisper pipeline ready.")
        return _whisper_pipeline


def transcribe_segments(
    segments: List[np.ndarray],
    sr: int,
    task_dict: Optional[dict] = None,
) -> List[str]:
    """
    Transcribe a list of audio segments using Whisper-small.

    Returns a list of transcription strings (one per segment).
    Optionally updates *task_dict* with progress.
    """
    pipe = _get_whisper_pipeline()
    transcripts: List[str] = []

    for idx, seg in enumerate(segments):
        # Whisper expects float32 numpy at 16 kHz
        if sr != 16000:
            seg_16k = librosa.resample(seg.astype(np.float32), orig_sr=sr, target_sr=16000)
        else:
            seg_16k = seg.astype(np.float32)

        try:
            result = pipe(
                seg_16k,
                generate_kwargs={"language": None, "task": "transcribe"},
                return_timestamps=False,
            )
            text = (result.get("text") or "").strip()
        except Exception as err:
            logger.warning("Whisper failed on segment %d: %s", idx, err)
            text = ""

        transcripts.append(text)

        if task_dict is not None:
            with _prep_lock:
                task_dict["segments_transcribed"] = idx + 1
                total = task_dict.get("segments_found") or len(segments)
                # Transcription is 40-90% of total progress
                pct = 40.0 + (idx + 1) / max(1, total) * 50.0
                task_dict["progress_percent"] = round(pct, 1)
                task_dict["message"] = f"Transcribing segment {idx + 1}/{total}..."

        logger.info(
            "Segment %d/%d transcribed: %s",
            idx + 1, len(segments),
            text[:60] + "..." if len(text) > 60 else text,
        )

    return transcripts


# ---------------------------------------------------------------------------
# Unload Whisper (free VRAM before TTS inference)
# ---------------------------------------------------------------------------

def unload_whisper():
    """Unload the Whisper pipeline to free GPU memory."""
    global _whisper_pipeline
    with _whisper_lock:
        if _whisper_pipeline is not None:
            del _whisper_pipeline
            _whisper_pipeline = None
            try:
                import torch
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:
                pass
            logger.info("Whisper pipeline unloaded (VRAM freed).")


# ---------------------------------------------------------------------------
# Full prepare pipeline
# ---------------------------------------------------------------------------

class VoicePreparer:
    """Orchestrates the split → transcribe → save pipeline."""

    def prepare(
        self,
        source_path: str,
        speaker_name: str,
        description: Optional[str] = None,
        min_segment_sec: float = 3.0,
        max_segment_sec: float = 15.0,
        top_db: float = 30.0,
        target_sr: int = 24000,
    ) -> dict:
        """
        Start a voice preparation task (blocking).

        Returns the task snapshot dict on completion.
        """
        task_id = uuid.uuid4().hex[:16]
        task = {
            "task_id": task_id,
            "speaker_name": speaker_name,
            "source_file": str(source_path),
            "status": "running",
            "stage": "loading",
            "progress_percent": 0.0,
            "segments_found": 0,
            "segments_transcribed": 0,
            "message": "Loading audio file...",
            "error": None,
            "created_at": datetime.now().isoformat(),
            "finished_at": None,
        }
        with _prep_lock:
            _prep_tasks[task_id] = task

        try:
            self._run(task, source_path, speaker_name, description,
                      min_segment_sec, max_segment_sec, top_db, target_sr)
        except Exception as err:
            with _prep_lock:
                task["status"] = "failed"
                task["error"] = str(err)
                task["message"] = "Preparation failed."
                task["finished_at"] = datetime.now().isoformat()
            logger.error("Voice preparation failed for '%s': %s", speaker_name, err)

        return _task_snapshot(task)

    def start_async(
        self,
        source_path: str,
        speaker_name: str,
        description: Optional[str] = None,
        min_segment_sec: float = 3.0,
        max_segment_sec: float = 15.0,
        top_db: float = 30.0,
        target_sr: int = 24000,
    ) -> dict:
        """Start preparation in a background thread.  Returns task snapshot immediately."""
        task_id = uuid.uuid4().hex[:16]
        task = {
            "task_id": task_id,
            "speaker_name": speaker_name,
            "source_file": str(source_path),
            "status": "running",
            "stage": "queued",
            "progress_percent": 0.0,
            "segments_found": 0,
            "segments_transcribed": 0,
            "message": "Queued for preparation...",
            "error": None,
            "created_at": datetime.now().isoformat(),
            "finished_at": None,
        }
        with _prep_lock:
            _prep_tasks[task_id] = task

        worker = threading.Thread(
            target=self._safe_run,
            args=(task, source_path, speaker_name, description,
                  min_segment_sec, max_segment_sec, top_db, target_sr),
            daemon=True,
            name=f"voice-prep-{task_id[:8]}",
        )
        worker.start()
        return _task_snapshot(task)

    def _safe_run(self, task, *args, **kwargs):
        try:
            self._run(task, *args, **kwargs)
        except Exception as err:
            with _prep_lock:
                task["status"] = "failed"
                task["error"] = str(err)
                task["message"] = "Preparation failed."
                task["finished_at"] = datetime.now().isoformat()
            logger.error("Voice preparation failed: %s", err)

    def _run(
        self,
        task: dict,
        source_path: str,
        speaker_name: str,
        description: Optional[str],
        min_segment_sec: float,
        max_segment_sec: float,
        top_db: float,
        target_sr: int,
    ):
        voices_dir = settings.VOICES_DIR
        voice_dir = voices_dir / speaker_name
        samples_dir = voice_dir / "samples"

        if voice_dir.exists():
            raise ValueError(
                f"Voice '{speaker_name}' already exists. Pick a different name."
            )

        # Resolve source file
        src = Path(source_path)
        if not src.exists():
            # Try relative to voices directory
            src = voices_dir / src.name
        if not src.exists():
            raise FileNotFoundError(f"Source audio not found: {src}")

        # --- Stage 1: Load ---
        with _prep_lock:
            task["stage"] = "loading"
            task["progress_percent"] = 5.0
            task["message"] = f"Loading {src.name}..."

        audio, file_sr = librosa.load(str(src), sr=None, mono=True)
        duration_total = len(audio) / file_sr
        logger.info("Loaded %.1fs audio at %d Hz", duration_total, file_sr)

        # Resample to target SR
        if file_sr != target_sr:
            audio = librosa.resample(audio, orig_sr=file_sr, target_sr=target_sr)

        # --- Stage 2: Split ---
        with _prep_lock:
            task["stage"] = "splitting"
            task["progress_percent"] = 15.0
            task["message"] = "Splitting on silence boundaries..."

        segments = split_audio_on_silence(
            audio, target_sr,
            min_segment_sec=min_segment_sec,
            max_segment_sec=max_segment_sec,
            top_db=top_db,
        )

        with _prep_lock:
            task["segments_found"] = len(segments)
            task["progress_percent"] = 40.0
            task["message"] = f"Found {len(segments)} segments. Starting transcription..."

        logger.info("Split into %d segments", len(segments))

        # --- Stage 3: Transcribe ---
        with _prep_lock:
            task["stage"] = "transcribing"

        transcripts = transcribe_segments(segments, target_sr, task_dict=task)

        # Unload Whisper to free VRAM for TTS model
        unload_whisper()

        # --- Stage 4: Save ---
        with _prep_lock:
            task["stage"] = "saving"
            task["progress_percent"] = 92.0
            task["message"] = "Saving voice profile..."

        samples_dir.mkdir(parents=True, exist_ok=True)

        sample_entries = []
        total_duration = 0.0
        for idx, (seg, text) in enumerate(zip(segments, transcripts)):
            wav_name = f"sample_{idx:03d}.wav"
            wav_path = samples_dir / wav_name
            sf.write(str(wav_path), seg, target_sr)

            seg_dur = len(seg) / target_sr
            total_duration += seg_dur

            # Per-segment ref_text
            if text:
                ref_path = voice_dir / f"ref_text_{idx:03d}.txt"
                ref_path.write_text(text, encoding="utf-8")

            sample_entries.append({
                "file": wav_name,
                "duration": round(seg_dur, 2),
                "ref_text": text or None,
            })

        # Also write a combined ref_text.txt (first non-empty transcript)
        combined_ref = next((t for t in transcripts if t), None)
        if combined_ref:
            (voice_dir / "ref_text.txt").write_text(combined_ref, encoding="utf-8")

        metadata = {
            "name": speaker_name,
            "description": description or f"Prepared voice: {speaker_name}",
            "sample_count": len(segments),
            "total_duration": round(total_duration, 2),
            "sample_rate": target_sr,
            "created_at": datetime.now().isoformat(),
            "samples": [e["file"] for e in sample_entries],
            "segments": sample_entries,
            "has_ref_text": any(t for t in transcripts),
            "truncated_samples": 0,
            "max_sample_seconds": max_segment_sec,
            "source_file": src.name,
            "prepared": True,  # marks this as auto-prepared
        }
        with open(voice_dir / "metadata.json", "w", encoding="utf-8") as f:
            json.dump(metadata, f, indent=2, ensure_ascii=False)

        with _prep_lock:
            task["status"] = "completed"
            task["progress_percent"] = 100.0
            task["stage"] = "done"
            task["message"] = (
                f"Voice '{speaker_name}' ready — "
                f"{len(segments)} segments, {total_duration:.1f}s total."
            )
            task["finished_at"] = datetime.now().isoformat()

        logger.info(
            "Voice '%s' prepared: %d segments, %.1fs total",
            speaker_name, len(segments), total_duration,
        )

    @staticmethod
    def get_task(task_id: str) -> Optional[dict]:
        with _prep_lock:
            task = _prep_tasks.get(task_id)
            return _task_snapshot(task) if task else None

    @staticmethod
    def list_source_files() -> List[dict]:
        """List audio files in the voices/ directory that can be used as source."""
        voices_dir = settings.VOICES_DIR
        if not voices_dir.exists():
            return []

        audio_exts = {".wav", ".mp3", ".flac", ".ogg", ".m4a"}
        files = []
        for item in sorted(voices_dir.iterdir()):
            if item.is_file() and item.suffix.lower() in audio_exts:
                try:
                    size = item.stat().st_size
                except Exception:
                    size = 0
                files.append({
                    "name": item.name,
                    "size_bytes": size,
                })
        return files


# ---------------------------------------------------------------------------
# Global instance
# ---------------------------------------------------------------------------
voice_preparer = VoicePreparer()
