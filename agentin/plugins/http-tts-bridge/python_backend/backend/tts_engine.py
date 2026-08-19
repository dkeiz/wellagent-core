"""
TTS Engine Module
=================

Core wrapper around Qwen3-TTS models.  Provides a single global
``tts_engine`` instance consumed by the rest of the backend.

The qwen-tts 0.1.1 package requires ``auto_docstring`` from
``transformers.utils`` which is absent in transformers ≤ 4.51.
We inject a lightweight shim at import time so the package loads
without modifying any installed files.
"""

import gc
import importlib
import io
import json
import logging
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import soundfile as sf


logger = logging.getLogger(__name__)


# Now safe to import the real package ------------------------------------------------
_QWEN_TTS_AVAILABLE = False
_QWEN_TTS_IMPORT_ERROR: Optional[str] = None
_FASTER_QWEN_TTS_AVAILABLE = False
_FASTER_QWEN_TTS_IMPORT_ERROR: Optional[str] = None

try:
    from qwen_tts import Qwen3TTSModel  # type: ignore[import-untyped]
    _QWEN_TTS_AVAILABLE = True
    logger.info("qwen-tts package loaded successfully")
except Exception as _import_err:
    _QWEN_TTS_IMPORT_ERROR = str(_import_err)
    logger.warning("qwen-tts import failed: %s", _import_err)

try:
    from faster_qwen3_tts import FasterQwen3TTS  # type: ignore[import-untyped]
    _FASTER_QWEN_TTS_AVAILABLE = True
    logger.info("faster-qwen3-tts package loaded successfully")
except Exception as _faster_import_err:
    _FASTER_QWEN_TTS_IMPORT_ERROR = str(_faster_import_err)
    logger.warning("faster-qwen3-tts import failed: %s", _faster_import_err)

# ---------------------------------------------------------------------------
#  Lazy torch import helper
# ---------------------------------------------------------------------------

_torch = None

def _get_torch():
    global _torch
    if _torch is None:
        import torch
        _torch = torch
    return _torch


# ---------------------------------------------------------------------------
#  Model type classification helpers
# ---------------------------------------------------------------------------

_MODEL_TYPE_MAP = {
    "customvoice": "custom_voice",
    "voicedesign": "voice_design",
    "base": "base",
}


def _classify_model_type(model_name: Optional[str]) -> Optional[str]:
    """Return 'custom_voice', 'voice_design', or 'base' from a model id."""
    if not model_name:
        return None
    slug = model_name.strip().rsplit("/", 1)[-1].lower().replace("-", "")
    for key, value in _MODEL_TYPE_MAP.items():
        if key in slug:
            return value
    return None


# ---------------------------------------------------------------------------
#  Required model files for usability probes
# ---------------------------------------------------------------------------

_REQUIRED_FILES = [
    "config.json",
    "generation_config.json",
]

_WEIGHT_PATTERNS = [
    "model.safetensors",
    "model.safetensors.index.json",
    "pytorch_model.bin",
    "pytorch_model.bin.index.json",
]

_PIPER_MODEL_PREFIX = "piper:"
_PIPER_DEFAULT_VOICE = "en_US-lessac-medium"


def _is_piper_model_name(model_name: Optional[str]) -> bool:
    value = str(model_name or "").strip().lower()
    return value.startswith(_PIPER_MODEL_PREFIX)


def _parse_piper_voice_id(model_name: Optional[str]) -> Optional[str]:
    value = str(model_name or "").strip()
    if not value:
        return None
    lowered = value.lower()
    if lowered == "piper":
        return _PIPER_DEFAULT_VOICE
    if lowered.startswith(_PIPER_MODEL_PREFIX):
        voice_id = value.split(":", 1)[1].strip().replace("\\", "/").strip("/")
        return voice_id or _PIPER_DEFAULT_VOICE
    return None


def _load_model_path_overrides() -> Dict[str, str]:
    raw = str(os.getenv("MODEL_PATH_OVERRIDES_JSON") or "").strip()
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except Exception:
        logger.warning("MODEL_PATH_OVERRIDES_JSON is invalid JSON")
        return {}
    if not isinstance(parsed, dict):
        return {}
    result: Dict[str, str] = {}
    for key, value in parsed.items():
        model_id = str(key or "").strip()
        model_path = str(value or "").strip()
        if model_id and model_path:
            result[model_id] = model_path
    return result


# ---------------------------------------------------------------------------
#  TTSEngine
# ---------------------------------------------------------------------------

class TTSEngine:
    """Thread-safe singleton wrapper for a Qwen3-TTS model."""

    def __init__(self) -> None:
        self._model: Any = None
        self._model_name: Optional[str] = None
        self._device: Optional[str] = None
        self._attn_backend: Optional[str] = None
        self._runtime_engine: str = "none"
        self._flash_probe_cache: Optional[Dict[str, Any]] = None
        self._sample_rate: int = 24000
        self._lock = threading.Lock()

    # -- public properties -------------------------------------------------

    @property
    def is_loaded(self) -> bool:
        return self._model is not None

    @property
    def model(self) -> Any:
        return self._model

    @property
    def model_name(self) -> Optional[str]:
        return self._model_name

    @property
    def device(self) -> Optional[str]:
        return self._device

    @property
    def attn_backend(self) -> Optional[str]:
        return self._attn_backend

    @property
    def runtime_engine(self) -> str:
        return self._runtime_engine

    @property
    def is_piper_model(self) -> bool:
        return _is_piper_model_name(self._model_name)

    # -- model lifecycle ---------------------------------------------------

    def load_model(
        self,
        model_name: Optional[str] = None,
        use_flash_attention: Optional[bool] = None,
        model_source_policy: Optional[str] = None,
        tts_engine: Optional[str] = None,
    ) -> None:
        """Load a Qwen3-TTS model into GPU memory.

        Parameters
        ----------
        model_name : str, optional
            HuggingFace repo-id **or** local directory.  Falls back to
            the value in ``backend.config.settings.MODEL_NAME``.
        use_flash_attention : bool, optional
            If ``True``, request ``flash_attention_2``.  Defaults to the
            config value.
        model_source_policy : str, optional
            ``"auto_download"`` (default) allows fetching from the Hub.
            ``"offline_only"`` only loads local files.
        """
        from backend.config import settings, get_device, get_torch_dtype, huggingface_network_context

        requested = (model_name or settings.MODEL_NAME).strip()
        if not requested:
            raise ValueError("No model name specified and MODEL_NAME is empty.")
        source_policy = model_source_policy or settings.MODEL_SOURCE_POLICY

        if _is_piper_model_name(requested):
            self._load_piper_model(requested=requested, source_policy=source_policy)
            return

        device = get_device()
        dtype = get_torch_dtype()

        requested_engine = str(tts_engine or settings.TTS_ENGINE or "auto").strip().lower()
        if requested_engine not in {"auto", "qwen_tts", "faster_qwen3_tts"}:
            requested_engine = "auto"

        if requested_engine == "auto":
            runtime_engine = "faster_qwen3_tts" if (_FASTER_QWEN_TTS_AVAILABLE and device.startswith("cuda")) else "qwen_tts"
        else:
            runtime_engine = requested_engine

        if runtime_engine == "faster_qwen3_tts" and not _FASTER_QWEN_TTS_AVAILABLE:
            raise RuntimeError(
                "Cannot load model with faster_qwen3_tts: package is not available. "
                f"Import error: {_FASTER_QWEN_TTS_IMPORT_ERROR}"
            )
        if runtime_engine == "qwen_tts" and not _QWEN_TTS_AVAILABLE:
            raise RuntimeError(
                "Cannot load model with qwen_tts: package is not available. "
                f"Import error: {_QWEN_TTS_IMPORT_ERROR}"
            )

        attn_impl = "sdpa"
        if runtime_engine == "qwen_tts":
            flash_probe = self.get_flash_attention_probe()
            flash_available = bool(flash_probe.get("available"))
            flash_detail = str(flash_probe.get("detail") or "unknown")

            if use_flash_attention is None:
                use_flash_attention = settings.USE_FLASH_ATTENTION

            attn_impl = settings.ATTN_IMPLEMENTATION
            if attn_impl == "auto":
                if use_flash_attention and flash_available:
                    attn_impl = "flash_attention_2"
                elif device.startswith("cuda"):
                    if use_flash_attention and not flash_available:
                        logger.warning(
                            "USE_FLASH_ATTENTION=true but flash-attn is unavailable (%s); using sdpa",
                            flash_detail,
                        )
                    attn_impl = "sdpa"
                else:
                    attn_impl = "eager"
            if attn_impl == "flash_attention_2" and not flash_available:
                raise RuntimeError(
                    f"flash_attention_2 requested but flash-attn is unavailable: {flash_detail}"
                )
        else:
            # faster_qwen3_tts currently relies on sdpa/eager paths; no FA2 backend.
            requested_attn = settings.ATTN_IMPLEMENTATION
            if requested_attn == "flash_attention_2":
                logger.warning(
                    "ATTN_IMPLEMENTATION=flash_attention_2 is not supported by faster_qwen3_tts; using sdpa"
                )
            attn_impl = "eager" if requested_attn == "eager" else "sdpa"

        # Determine model source path
        local_path = self._resolve_local_model_path(requested)

        if source_policy == "offline_only" and not local_path:
            raise RuntimeError(
                f"Model '{requested}' not found locally and source policy is offline_only."
            )

        load_id = local_path or requested
        logger.info(
            "Loading model '%s' with engine=%s on %s  dtype=%s  attn=%s",
            load_id, runtime_engine, device, dtype, attn_impl,
        )

        def _do_load(bypass_proxy: bool) -> Any:
            with huggingface_network_context(bypass_proxy=bypass_proxy):
                if runtime_engine == "faster_qwen3_tts":
                    return FasterQwen3TTS.from_pretrained(
                        load_id,
                        device=device,
                        dtype=dtype,
                        attn_implementation=attn_impl,
                        max_seq_len=int(settings.FASTER_QWEN3_MAX_SEQ_LEN),
                    )
                return Qwen3TTSModel.from_pretrained(
                    load_id,
                    device_map=device,
                    dtype=dtype,
                    attn_implementation=attn_impl,
                )

        # Try loading — retry with opposite proxy mode on failure
        preferred_bypass = bool(settings.BYPASS_HF_PROXY)
        model_obj = None
        first_err = None
        for attempt, bypass in enumerate([preferred_bypass, not preferred_bypass]):
            try:
                model_obj = _do_load(bypass)
                break
            except Exception as err:
                if attempt == 0:
                    first_err = err
                    logger.warning("Load attempt %d failed: %s — retrying", attempt + 1, err)
                    continue
                raise RuntimeError(
                    f"Failed to load model '{requested}': {first_err} | retry: {err}"
                ) from err

        if model_obj is None:
            raise RuntimeError(f"Model load returned None for '{requested}'")

        self._model = model_obj
        self._model_name = requested
        self._device = device
        self._attn_backend = self._resolve_active_attn_backend(model_obj, fallback=attn_impl)
        self._runtime_engine = runtime_engine
        logger.info("Model '%s' loaded on %s with engine=%s", requested, device, runtime_engine)

    def unload_model(self) -> None:
        """Release the current model and free GPU memory."""
        if self._model is not None:
            logger.info("Unloading model '%s'", self._model_name)
            del self._model
            self._model = None
            gc.collect()
            try:
                torch = _get_torch()
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:
                pass
        self._model_name = None
        self._device = None
        self._attn_backend = None
        self._runtime_engine = "none"

    def _piper_models_root(self) -> Path:
        from backend.config import settings
        return settings.BASE_DIR / "models" / "piper"

    def _find_piper_runtime(self) -> Optional[str]:
        try:
            from backend.config import settings
            settings_bin = str(settings.PIPER_BIN or "").strip()
        except Exception:
            settings_bin = ""
        candidates: List[Path] = []
        if settings_bin:
            candidates.append(Path(settings_bin))
        env_bin = str(os.getenv("PIPER_BIN") or "").strip()
        if env_bin:
            candidates.append(Path(env_bin))
        root = self._piper_models_root()
        candidates.append(root / "bin" / "piper.exe")
        candidates.append(root / "bin" / "piper")
        for candidate in candidates:
            if candidate.exists() and candidate.is_file():
                return str(candidate.absolute())
        which_hit = shutil.which("piper.exe") or shutil.which("piper")
        if which_hit:
            return which_hit
        return None

    def _piper_python_runtime_dir(self) -> Path:
        return self._piper_models_root() / "bin" / "piper_runtime"

    def _find_piper_wheels(self) -> List[Path]:
        root = self._piper_models_root() / "bin"
        if not root.is_dir():
            return []
        return sorted(
            [p for p in root.glob("piper_tts-*.whl") if p.is_file()],
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )

    def _ensure_piper_python_runtime(self) -> Optional[Path]:
        runtime_dir = self._piper_python_runtime_dir()
        piper_init = runtime_dir / "piper" / "__init__.py"
        if piper_init.exists():
            return runtime_dir

        wheels = self._find_piper_wheels()
        if not wheels:
            return None

        wheel = wheels[0]
        try:
            runtime_dir.mkdir(parents=True, exist_ok=True)
            with zipfile.ZipFile(wheel) as archive:
                archive.extractall(runtime_dir)
            if piper_init.exists():
                logger.info("Extracted Piper runtime wheel '%s' to '%s'", wheel, runtime_dir)
                return runtime_dir
        except Exception as err:
            logger.warning("Failed to extract Piper wheel '%s': %s", wheel, err)
        return None

    def _load_piper_python_voice(self, model_path: Path, config_path: Path) -> Tuple[Any, Path]:
        runtime_dir = self._ensure_piper_python_runtime()
        if runtime_dir is None:
            raise RuntimeError("Piper Python runtime is unavailable.")

        runtime_path = str(runtime_dir.absolute())
        if runtime_path not in sys.path:
            sys.path.insert(0, runtime_path)

        try:
            piper_module = importlib.import_module("piper")
            piper_voice = getattr(piper_module, "PiperVoice", None)
            if piper_voice is None:
                raise RuntimeError("PiperVoice class is missing in Piper runtime module.")
            voice = piper_voice.load(model_path, config_path=config_path, use_cuda=False)
            return voice, runtime_dir
        except Exception as err:
            raise RuntimeError(f"Piper Python runtime failed to initialize: {err}") from err

    def _normalize_piper_voice_id(self, voice_id: str) -> str:
        normalized = str(voice_id or "").strip().replace("\\", "/").strip("/")
        if not normalized:
            return _PIPER_DEFAULT_VOICE
        if normalized.lower().endswith(".onnx"):
            normalized = normalized[:-5]
        return normalized

    def _resolve_piper_voice_files(self, voice_id: str) -> Optional[Tuple[Path, Path]]:
        root = self._piper_models_root()
        normalized = self._normalize_piper_voice_id(voice_id)
        model_path = root / f"{normalized}.onnx"
        config_path = root / f"{normalized}.onnx.json"
        if model_path.exists() and config_path.exists():
            return model_path, config_path
        if model_path.exists() and not config_path.exists():
            return model_path, config_path
        return None

    def list_local_piper_voice_ids(self) -> List[str]:
        root = self._piper_models_root()
        if not root.is_dir():
            return []
        voices: List[str] = []
        for model_file in root.rglob("*.onnx"):
            rel = model_file.relative_to(root).as_posix()
            voice_id = rel[:-5] if rel.lower().endswith(".onnx") else rel
            config = root / f"{voice_id}.onnx.json"
            if config.exists():
                voices.append(voice_id)
        return sorted(set(voices))

    def list_local_piper_model_ids(self) -> List[str]:
        return [f"{_PIPER_MODEL_PREFIX}{voice_id}" for voice_id in self.list_local_piper_voice_ids()]

    def _load_piper_model(self, requested: str, source_policy: str) -> None:
        voice_id = self._normalize_piper_voice_id(_parse_piper_voice_id(requested) or _PIPER_DEFAULT_VOICE)
        resolved = self._resolve_piper_voice_files(voice_id)
        if not resolved:
            expected = self._piper_models_root() / f"{voice_id}.onnx"
            raise RuntimeError(
                f"Piper voice '{voice_id}' is not available locally. "
                f"Expected model at '{expected}'. "
                "Place '<voice>.onnx' and '<voice>.onnx.json' under models/piper."
            )
        model_path, config_path = resolved
        runtime = self._find_piper_runtime()
        model_state: Dict[str, Any] = {
            "voice_id": voice_id,
            "model_path": str(model_path),
            "config_path": str(config_path),
        }

        if runtime:
            model_state["provider"] = "piper_cli"
            model_state["runtime"] = runtime
            logger.info(
                "Piper voice '%s' loaded with runtime '%s' (source_policy=%s)",
                voice_id,
                runtime,
                source_policy,
            )
        else:
            voice, runtime_dir = self._load_piper_python_voice(model_path=model_path, config_path=config_path)
            model_state["provider"] = "piper_python"
            model_state["voice"] = voice
            model_state["runtime_dir"] = str(runtime_dir)
            logger.info(
                "Piper voice '%s' loaded via Python runtime '%s' (source_policy=%s)",
                voice_id,
                runtime_dir,
                source_policy,
            )

        self._model = model_state
        self._model_name = f"{_PIPER_MODEL_PREFIX}{voice_id}"
        self._device = "cpu"
        self._attn_backend = None
        self._runtime_engine = "piper"

    def _generate_with_piper(self, text: str) -> Tuple[np.ndarray, int]:
        if not isinstance(self._model, dict):
            raise RuntimeError("Piper runtime state is invalid.")
        voice_id = self._normalize_piper_voice_id(str(self._model.get("voice_id") or _PIPER_DEFAULT_VOICE))
        runtime = str(self._model.get("runtime") or "")
        resolved = self._resolve_piper_voice_files(voice_id)
        if not resolved:
            raise RuntimeError(f"Piper voice files are missing for '{voice_id}'.")
        model_path, config_path = resolved

        provider = str(self._model.get("provider") or "")
        if provider == "piper_python":
            voice = self._model.get("voice")
            if voice is None:
                voice, runtime_dir = self._load_piper_python_voice(model_path=model_path, config_path=config_path)
                self._model["voice"] = voice
                self._model["runtime_dir"] = str(runtime_dir)
            try:
                chunks = list(voice.synthesize(text))
            except Exception as err:
                raise RuntimeError(f"Piper generation failed (python runtime): {err}") from err

            if not chunks:
                raise RuntimeError("Piper generation produced no audio chunks.")

            sample_rate = int(getattr(chunks[0], "sample_rate", self._sample_rate))
            arrays: List[np.ndarray] = []
            for chunk in chunks:
                chunk_arr = getattr(chunk, "audio_float_array", None)
                if chunk_arr is None:
                    continue
                arrays.append(np.asarray(chunk_arr, dtype=np.float32).reshape(-1))
            if not arrays:
                raise RuntimeError("Piper generation produced empty audio arrays.")
            audio_np = np.concatenate(arrays, axis=0).astype(np.float32, copy=False)
            return audio_np.squeeze(), sample_rate

        if not runtime:
            runtime = self._find_piper_runtime() or ""
        if not runtime:
            raise RuntimeError(
                "Piper runtime is missing. "
                "Install piper.exe (PIPER_BIN) or place piper_tts-*.whl under models/piper/bin/."
            )

        tmp_path: Optional[Path] = None
        try:
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp_file:
                tmp_path = Path(tmp_file.name)

            proc = subprocess.run(
                [runtime, "--model", str(model_path), "--output_file", str(tmp_path)],
                input=text.encode("utf-8"),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
            )
            if proc.returncode != 0:
                stderr = (proc.stderr or b"").decode("utf-8", errors="replace").strip()
                raise RuntimeError(f"Piper generation failed (exit={proc.returncode}): {stderr}")

            audio, sr = sf.read(str(tmp_path), dtype="float32")
            audio_np = np.asarray(audio, dtype=np.float32)
            if audio_np.ndim > 1:
                audio_np = np.mean(audio_np, axis=1)
            return audio_np.squeeze(), int(sr)
        finally:
            if tmp_path and tmp_path.exists():
                try:
                    tmp_path.unlink()
                except Exception:
                    pass

    # -- generation --------------------------------------------------------

    def _generate_voice_clone_with_compat(self, clone_kwargs: Dict[str, Any]) -> Tuple[Any, int]:
        """Call voice-clone API while handling keyword differences across engines."""
        try:
            return self._model.generate_voice_clone(**clone_kwargs)
        except TypeError as err:
            if "x_vector_only_mode" not in clone_kwargs:
                raise
            fallback_kwargs = dict(clone_kwargs)
            fallback_kwargs["xvec_only"] = fallback_kwargs.pop("x_vector_only_mode")
            try:
                return self._model.generate_voice_clone(**fallback_kwargs)
            except Exception:
                raise err

    def generate(
        self,
        text: str,
        speaker: str,
        language: str = "auto",
        instruct: Optional[str] = None,
        reference_audio_paths: Optional[List[Path]] = None,
        reference_text: Optional[str] = None,
        simulate_streaming_input: Optional[bool] = None,
        max_new_tokens: Optional[int] = None,
        do_sample: Optional[bool] = None,
    ) -> Tuple[np.ndarray, int]:
        """Generate speech and return ``(audio_array, sample_rate)``."""
        if not self.is_loaded:
            raise RuntimeError("Model not loaded. Call load_model() first.")
        if self.is_piper_model:
            return self._generate_with_piper(text)

        from backend.config import settings

        model_type = self.get_model_tts_type()
        lang_display = (language or "auto").capitalize()

        if simulate_streaming_input is None:
            simulate_streaming_input = bool(settings.SIMULATE_STREAMING_INPUT)
        token_limit = int(max_new_tokens or settings.GENERATION_MAX_NEW_TOKENS)
        use_sampling = True if do_sample is None else bool(do_sample)

        gen_kwargs: Dict[str, Any] = dict(
            do_sample=use_sampling,
            max_new_tokens=token_limit,
        )
        if simulate_streaming_input:
            # qwen-tts currently treats this as "simulated streaming input".
            gen_kwargs["non_streaming_mode"] = False

        try:
            if model_type == "base" and reference_audio_paths:
                # Voice cloning path
                ref_audio = str(reference_audio_paths[0])
                use_xvec_only = not bool(reference_text)
                clone_kwargs: Dict[str, Any] = dict(
                    text=text,
                    language=lang_display,
                    ref_audio=ref_audio,
                    x_vector_only_mode=use_xvec_only,
                    **gen_kwargs,
                )
                if reference_text:
                    clone_kwargs["ref_text"] = reference_text
                wavs, sr = self._generate_voice_clone_with_compat(clone_kwargs)

            elif model_type == "voice_design":
                wavs, sr = self._model.generate_voice_design(
                    text=text,
                    language=lang_display,
                    instruct=instruct or "A natural, clear speaking voice.",
                    **gen_kwargs,
                )

            else:
                # CustomVoice (default)
                cv_kwargs: Dict[str, Any] = dict(
                    text=text,
                    language=lang_display,
                    speaker=speaker.capitalize() if speaker else "Vivian",
                    **gen_kwargs,
                )
                if instruct:
                    cv_kwargs["instruct"] = instruct
                wavs, sr = self._model.generate_custom_voice(**cv_kwargs)

        except Exception as err:
            logger.error("Generation failed: %s", err)
            raise RuntimeError(f"TTS generation failed: {err}") from err

        # wavs is a list of numpy arrays; take the first
        audio = wavs[0] if isinstance(wavs, (list, tuple)) else wavs
        if hasattr(audio, "cpu"):
            audio = audio.cpu().numpy()
        audio = np.asarray(audio, dtype=np.float32).squeeze()

        return audio, int(sr)

    def generate_batch(
        self,
        texts: List[str],
        speakers: List[str],
        languages: List[str],
        instructs: Optional[List[Optional[str]]] = None,
    ) -> List[Tuple[np.ndarray, int]]:
        """Generate speech for multiple texts sequentially."""
        n = len(texts)
        speakers_exp = speakers if len(speakers) > 1 else speakers * n
        languages_exp = languages if len(languages) > 1 else languages * n
        if instructs is None:
            instructs_exp: List[Optional[str]] = [None] * n
        else:
            instructs_exp = instructs if len(instructs) > 1 else instructs * n

        results: List[Tuple[np.ndarray, int]] = []
        for i in range(n):
            audio, sr = self.generate(
                text=texts[i],
                speaker=speakers_exp[i],
                language=languages_exp[i],
                instruct=instructs_exp[i],
            )
            results.append((audio, sr))
        return results

    # -- audio I/O ---------------------------------------------------------

    def save_audio(
        self,
        audio: np.ndarray,
        sample_rate: int,
        filename: str,
        audio_format: str = "wav",
    ) -> Path:
        """Save audio to the output directory and return the path."""
        from backend.config import settings

        output_dir = settings.OUTPUT_DIR
        output_dir.mkdir(parents=True, exist_ok=True)
        filepath = output_dir / filename

        sf.write(str(filepath), audio, sample_rate, format=audio_format.upper())
        return filepath

    # -- model introspection -----------------------------------------------

    def get_model_tts_type(self) -> Optional[str]:
        """Return ``'custom_voice'``, ``'voice_design'``, ``'base'``, or ``None``."""
        return _classify_model_type(self._model_name)

    def is_flash_attention_available(self) -> bool:
        """Return ``True`` only if flash-attn imports and kernels run on CUDA."""
        return bool(self.get_flash_attention_probe().get("available"))

    def get_flash_attention_probe(self, force_refresh: bool = False) -> Dict[str, Any]:
        """Probe flash-attn availability and return detailed status."""
        with self._lock:
            if self._flash_probe_cache is not None and not force_refresh:
                return dict(self._flash_probe_cache)

        probe: Dict[str, Any] = {
            "available": False,
            "module_version": None,
            "detail": "",
        }

        try:
            import flash_attn  # type: ignore[import-untyped]
        except Exception as err:
            msg = str(err).splitlines()[0] if str(err) else err.__class__.__name__
            probe["detail"] = f"flash-attn import failed: {msg}"
            with self._lock:
                self._flash_probe_cache = dict(probe)
            return probe

        # Version is informational and should not fail the probe.
        try:
            from importlib import metadata as importlib_metadata
            probe["module_version"] = importlib_metadata.version("flash-attn")
        except Exception:
            probe["module_version"] = getattr(flash_attn, "__version__", None)

        torch = _get_torch()
        if not torch.cuda.is_available():
            probe["detail"] = "CUDA is not available."
            with self._lock:
                self._flash_probe_cache = dict(probe)
            return probe

        # Runtime kernel probe: catches broken wheel/DLL situations.
        try:
            from flash_attn.flash_attn_interface import flash_attn_func  # type: ignore[import-untyped]

            q = torch.randn(1, 8, 4, 16, device="cuda", dtype=torch.float16)
            k = torch.randn(1, 8, 4, 16, device="cuda", dtype=torch.float16)
            v = torch.randn(1, 8, 4, 16, device="cuda", dtype=torch.float16)
            with torch.no_grad():
                _ = flash_attn_func(q, k, v, dropout_p=0.0, causal=False)
            probe["available"] = True
            probe["detail"] = "flash-attn import and kernel probe succeeded."
        except Exception as err:
            msg = str(err).splitlines()[0] if str(err) else err.__class__.__name__
            probe["detail"] = f"flash-attn kernel probe failed: {msg}"
            probe["available"] = False

        with self._lock:
            self._flash_probe_cache = dict(probe)
        return probe

    def _resolve_active_attn_backend(self, model_obj: Any, fallback: str) -> str:
        """Read the effective attention backend from model config if possible."""
        candidates = [
            getattr(model_obj, "config", None),
            getattr(getattr(model_obj, "model", None), "config", None),
            getattr(getattr(model_obj, "generator", None), "config", None),
        ]
        for cfg in candidates:
            if cfg is None:
                continue
            impl = getattr(cfg, "_attn_implementation", None) or getattr(cfg, "attn_implementation", None)
            if isinstance(impl, str) and impl:
                return impl
        return fallback

    def get_local_model_probe(self, model_id: str) -> Dict[str, Any]:
        """Probe local filesystem for a model and return availability info."""
        if _is_piper_model_name(model_id):
            voice_id = self._normalize_piper_voice_id(_parse_piper_voice_id(model_id) or _PIPER_DEFAULT_VOICE)
            resolved = self._resolve_piper_voice_files(voice_id)
            expected_model_path = self._piper_models_root() / f"{voice_id}.onnx"
            expected_cfg_path = self._piper_models_root() / f"{voice_id}.onnx.json"
            if not resolved:
                return {
                    "available": False,
                    "usable": False,
                    "status": "missing",
                    "local_path": str(expected_model_path),
                    "detail": (
                        f"Piper voice files are missing for '{voice_id}'. "
                        "Expected both .onnx and .onnx.json files under models/piper."
                    ),
                    "incomplete_download": False,
                }

            model_path, config_path = resolved
            has_cfg = config_path.exists()
            runtime = self._find_piper_runtime()
            python_runtime = self._ensure_piper_python_runtime()
            if has_cfg and (runtime or python_runtime):
                detail = f"Piper voice '{voice_id}' is available."
                if runtime:
                    detail = f"Piper voice '{voice_id}' is available (runtime: executable)."
                elif python_runtime:
                    detail = f"Piper voice '{voice_id}' is available (runtime: python wheel)."
                return {
                    "available": True,
                    "usable": True,
                    "status": "ready",
                    "local_path": str(model_path.absolute()),
                    "detail": detail,
                    "incomplete_download": False,
                }
            if has_cfg and not runtime and not python_runtime:
                return {
                    "available": True,
                    "usable": False,
                    "status": "runtime_missing",
                    "local_path": str(model_path.absolute()),
                    "detail": (
                        f"Piper voice '{voice_id}' files exist but runtime is missing. "
                        "Set PIPER_BIN, place piper.exe under models/piper/bin/, or put piper_tts-*.whl in models/piper/bin/."
                    ),
                    "incomplete_download": False,
                }
            return {
                "available": True,
                "usable": False,
                "status": "incomplete",
                "local_path": str(model_path.absolute()),
                "detail": f"Piper model '{voice_id}' found but config is missing ({expected_cfg_path.name}).",
                "incomplete_download": True,
            }

        local_path = self._resolve_local_model_path(model_id)

        if not local_path:
            return {
                "available": False,
                "usable": False,
                "status": "missing",
                "local_path": None,
                "detail": "Model not found locally.",
                "incomplete_download": False,
            }

        path = Path(local_path)
        has_config = (path / "config.json").exists()
        has_weights = any((path / wf).exists() for wf in _WEIGHT_PATTERNS)
        usable = has_config and has_weights
        incomplete = has_config and not has_weights

        if usable:
            status = "ready"
            detail = "Model files present and usable."
        elif incomplete:
            status = "incomplete"
            detail = "Config found but weight files are missing — download may be incomplete."
        else:
            status = "corrupt"
            detail = "Directory exists but essential files are missing."

        return {
            "available": True,
            "usable": usable,
            "status": status,
            "local_path": local_path,
            "detail": detail,
            "incomplete_download": incomplete,
        }

    def _resolve_local_model_path(self, model_name: str) -> Optional[str]:
        """Return an absolute path string if the model exists locally, else ``None``."""
        from backend.config import settings

        name = model_name.strip()
        if not name:
            return None

        overrides = _load_model_path_overrides()
        override_path = overrides.get(name) or overrides.get(name.rsplit("/", 1)[-1])
        if override_path:
            candidate = Path(override_path).expanduser()
            if candidate.is_dir():
                return str(candidate.resolve())

        # 1) Direct path
        direct = Path(name)
        if direct.is_dir() and (direct / "config.json").exists():
            return str(direct.absolute())

        # 2) Project-local ./models/<basename>
        basename = name.rsplit("/", 1)[-1]
        local_models = settings.BASE_DIR / "models" / basename
        if local_models.is_dir() and (local_models / "config.json").exists():
            # Keep project-local path visible even when it is a junction/symlink.
            return str(local_models.absolute())

        # 3) Search HF cache directories (project-local + system default)
        cache_dirs_to_check = [settings.HF_CACHE_DIR / "hub"]
        # Also check the system default HF cache
        system_hf_cache = Path.home() / ".cache" / "huggingface" / "hub"
        if system_hf_cache != cache_dirs_to_check[0] and system_hf_cache.is_dir():
            cache_dirs_to_check.append(system_hf_cache)

        cache_key = f"models--{name.replace('/', '--')}"
        for hf_hub in cache_dirs_to_check:
            if not hf_hub.is_dir():
                continue
            cache_dir = hf_hub / cache_key
            if cache_dir.is_dir():
                snapshots = cache_dir / "snapshots"
                if snapshots.is_dir():
                    candidates = sorted(snapshots.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True)
                    for snap in candidates:
                        if snap.is_dir() and (snap / "config.json").exists():
                            return str(snap.resolve())
                return str(cache_dir.resolve())

        return None


# ---------------------------------------------------------------------------
#  Global singleton
# ---------------------------------------------------------------------------

tts_engine = TTSEngine()
