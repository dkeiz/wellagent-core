"""
Configuration Module
====================

This module contains all configuration settings for the Qwen3 TTS system.
Settings can be overridden via environment variables or a .env file.

Usage:
    from backend.config import settings
    
    print(settings.MODEL_NAME)
    print(settings.DEVICE)
"""

import os
import contextlib
from pathlib import Path
from typing import Literal, Optional
from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import Field, field_validator


class Settings(BaseSettings):
    """
    Application settings with environment variable support.
    
    All settings can be overridden by:
    1. Environment variables (uppercase, e.g., MODEL_NAME)
    2. .env file in the project root
    3. Default values defined here
    """
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )
    
    # =========================================================================
    # Model Configuration
    # =========================================================================
    
    # Which Qwen3 TTS model to use
    # Options:
    #   - "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice"  (predefined speakers)
    #   - "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign"  (natural language design)
    #   - "Qwen/Qwen3-TTS-12Hz-1.7B-Base"         (voice cloning)
    #   - "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice"  (smaller + faster)
    #   - "Qwen/Qwen3-TTS-12Hz-0.6B-Base"         (smaller + faster clone)
    MODEL_NAME: str = Field(
        default="Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
        description="HuggingFace model identifier"
    )

    TTS_ENGINE: Literal["auto", "qwen_tts", "faster_qwen3_tts"] = Field(
        default="auto",
        description="Engine backend selector: auto prefers faster_qwen3_tts on CUDA when available"
    )

    FASTER_QWEN3_MAX_SEQ_LEN: int = Field(
        default=2048,
        gt=512,
        description="Static cache sequence length for faster_qwen3_tts"
    )

    MODEL_SOURCE_POLICY: Literal["auto_download", "offline_only"] = Field(
        default="auto_download",
        description="Model source policy: auto download if missing or require local files only"
    )

    BYPASS_HF_PROXY: bool = Field(
        default=True,
        description="Temporarily ignore system HTTP(S) proxy for Hugging Face model downloads/loading"
    )
    
    # Device to run the model on
    # Options: "cuda:0", "cuda:1", "cpu", "auto"
    # "auto" will use CUDA if available, otherwise CPU
    DEVICE: str = Field(
        default="auto",
        description="Device for model inference"
    )

    # Require CUDA for inference; fail fast instead of silently using CPU
    REQUIRE_GPU: bool = Field(
        default=True,
        description="Require GPU for inference and fail if CUDA is unavailable"
    )

    # Limit concurrent generation jobs for predictable responsiveness on single-GPU setups
    MAX_CONCURRENT_GENERATIONS: int = Field(
        default=1,
        gt=0,
        description="Maximum number of concurrent generation jobs"
    )
    
    # Data type for model weights
    # Options: "float32", "float16", "bfloat16"
    # bfloat16 is recommended for modern GPUs (RTX 30xx+)
    DTYPE: str = Field(
        default="bfloat16",
        description="Model precision (bfloat16 recommended)"
    )
    
    # Use Flash Attention 2 for faster inference
    # Requires: CUDA GPU, flash-attn package installed
    USE_FLASH_ATTENTION: bool = Field(
        default=False,
        description="Enable Flash Attention 2 (faster but requires setup)"
    )

    # Attention backend policy.
    # auto: prefer flash-attn when available, otherwise SDPA on CUDA.
    ATTN_IMPLEMENTATION: Literal["auto", "flash_attention_2", "sdpa", "eager"] = Field(
        default="auto",
        description="Attention backend policy for model loading"
    )

    # Optional absolute path to Piper runtime executable (piper.exe / piper).
    PIPER_BIN: Optional[str] = Field(
        default=None,
        description="Path to Piper runtime executable for piper:* model ids"
    )

    # Keep model generation in default non-streaming mode unless explicitly enabled.
    # qwen-tts 0.1.1 does not expose true token-level streaming in this path.
    SIMULATE_STREAMING_INPUT: bool = Field(
        default=False,
        description="Enable qwen-tts simulated streaming input mode (non_streaming_mode=False)"
    )

    GENERATION_MAX_NEW_TOKENS: int = Field(
        default=1024,
        gt=128,
        description="Upper bound for generated codec tokens (lower can improve latency)"
    )

    # Stream chunking controls (SSE / chunked streaming endpoints)
    STREAM_TARGET_CHARS: int = Field(
        default=180,
        gt=20,
        description="Target characters per streaming chunk after the first chunk"
    )

    STREAM_FIRST_CHUNK_CHARS: int = Field(
        default=90,
        gt=20,
        description="Target characters for the first streaming chunk (lower improves time-to-first-audio)"
    )

    # Faster stream start for short/medium texts.
    STREAM_MIN_FIRST_CHUNK_CHARS: int = Field(
        default=45,
        gt=10,
        description="Lower bound for first streaming chunk target"
    )

    # Low-latency stream defaults used by /api/tts/stream.
    STREAM_LOW_LATENCY_TARGET_CHARS: int = Field(
        default=72,
        gt=10,
        description="Target characters per chunk for low-latency stream mode"
    )

    STREAM_LOW_LATENCY_FIRST_CHUNK_CHARS: int = Field(
        default=28,
        gt=6,
        description="First chunk target for low-latency stream mode"
    )

    STREAM_LOW_LATENCY_MIN_FIRST_CHARS: int = Field(
        default=18,
        gt=4,
        description="Minimum first chunk size for low-latency stream mode"
    )

    STREAM_USE_SIMULATED_MODEL_STREAMING: bool = Field(
        default=False,
        description="Use qwen-tts simulated streaming input mode for /api/tts/stream requests"
    )

    STREAM_DO_SAMPLE: bool = Field(
        default=False,
        description="Sampling mode for /api/tts/stream chunks (false can improve latency stability)"
    )

    STREAM_MAX_NEW_TOKENS: int = Field(
        default=320,
        gt=64,
        description="Max new tokens per stream chunk to reduce first-audio latency"
    )

    STREAM_FIRST_CHUNK_MAX_NEW_TOKENS: int = Field(
        default=128,
        gt=32,
        description="Lower token cap for first stream chunk to reduce time-to-first-audio"
    )

    # API request limiting (per client/IP).
    RATE_LIMIT_REQUESTS_PER_WINDOW: int = Field(
        default=100,
        gt=0,
        description="Maximum allowed requests in the configured rate-limit window"
    )

    RATE_LIMIT_WINDOW_SECONDS: int = Field(
        default=60,
        gt=0,
        description="Rate-limit window length in seconds"
    )

    # Startup behavior: when true, server starts immediately and model loads in background.
    DEFER_MODEL_LOAD_ON_STARTUP: bool = Field(
        default=True,
        description="Load model asynchronously during startup instead of blocking server boot"
    )

    # Voice cloning constraints for stable latency/quality.
    VOICE_CLONE_MAX_SAMPLE_SECONDS: float = Field(
        default=20.0,
        gt=1.0,
        description="Maximum duration of each processed clone sample in seconds"
    )

    VOICE_CLONE_MAX_REFERENCE_SAMPLES: int = Field(
        default=3,
        gt=0,
        description="Maximum number of reference samples used during clone inference"
    )

    VOICE_CLONE_USE_REF_TEXT: bool = Field(
        default=False,
        description="Enable ICL cloning with stored reference text (higher quality, slower)."
    )
    
    # =========================================================================
    # Server Configuration
    # =========================================================================
    
    # Host address for the API server
    HOST: str = Field(
        default="0.0.0.0",
        description="Server host address"
    )
    
    # Port for the API server
    PORT: int = Field(
        default=8000,
        description="Server port"
    )
    
    # Enable CORS for web frontend
    ENABLE_CORS: bool = Field(
        default=True,
        description="Enable Cross-Origin Resource Sharing"
    )
    
    # =========================================================================
    # File Paths
    # =========================================================================
    
    # Base directory for the project
    BASE_DIR: Path = Field(
        default=Path(__file__).parent.parent,
        description="Project root directory"
    )
    
    # Directory to store custom voice embeddings
    VOICES_DIR: Path = Field(
        default=Path("voices"),
        description="Directory for custom voice storage"
    )
    
    # Directory for generated audio output
    OUTPUT_DIR: Path = Field(
        default=Path("output"),
        description="Directory for generated audio files"
    )
    
    # Directory for uploaded voice samples
    UPLOAD_DIR: Path = Field(
        default=Path("uploads"),
        description="Directory for temporary uploads"
    )

    # Local Hugging Face cache directory (kept inside project by default).
    HF_CACHE_DIR: Path = Field(
        default=Path(".hf_cache"),
        description="Hugging Face cache root directory"
    )
    
    # =========================================================================
    # Voice Cloning Settings
    # =========================================================================
    
    # Minimum number of voice samples required for cloning
    MIN_SAMPLES: int = Field(
        default=1,
        description="Minimum voice samples for cloning"
    )
    
    # Maximum number of voice samples to use
    MAX_SAMPLES: int = Field(
        default=30,
        description="Maximum voice samples to process"
    )
    
    # Maximum file size for voice samples (in MB)
    MAX_SAMPLE_SIZE_MB: int = Field(
        default=50,
        description="Maximum upload file size in MB"
    )
    
    # Allowed audio file formats
    ALLOWED_AUDIO_FORMATS: list = Field(
        default=[".wav", ".mp3", ".flac", ".ogg", ".m4a"],
        description="Allowed audio file extensions"
    )
    
    # =========================================================================
    # Audio Processing Settings
    # =========================================================================
    
    # Target sample rate for audio processing
    SAMPLE_RATE: int = Field(
        default=24000,
        description="Audio sample rate in Hz"
    )
    
    # Maximum text length for TTS (characters)
    MAX_TEXT_LENGTH: int = Field(
        default=5000,
        description="Maximum text length for generation"
    )

    OUTPUT_FORMATS: list[str] = Field(
        default=["wav", "flac", "ogg"],
        description="Supported output audio formats"
    )
    
    # =========================================================================
    # Built-in Voices
    # =========================================================================
    
    # List of available built-in speakers
    BUILTIN_SPEAKERS: list = Field(
        default=[
            "aiden",      # Male, English
            "dylan",      # Male, English
            "eric",       # Male, English
            "ono_anna",   # Female, Japanese
            "ryan",       # Male, English
            "serena",     # Female, English
            "sohee",      # Female, Korean
            "uncle_fu",   # Male, Chinese
            "vivian",     # Female, Chinese
        ],
        description="Available built-in speaker voices"
    )
    
    # List of supported languages
    SUPPORTED_LANGUAGES: list = Field(
        default=[
            "auto",       # Automatic detection
            "chinese",
            "english",
            "french",
            "german",
            "italian",
            "japanese",
            "korean",
            "portuguese",
            "russian",
            "spanish",
        ],
        description="Supported languages for TTS"
    )
    
    @field_validator("BASE_DIR", mode="after")
    @classmethod
    def _resolve_base_dir(cls, value: Path) -> Path:
        """Ensure BASE_DIR is absolute."""
        return Path(value).resolve()

    @field_validator("DEVICE", mode="before")
    @classmethod
    def _normalize_device(cls, value: str) -> str:
        """Normalize and validate DEVICE values."""
        if value is None:
            return "auto"

        normalized = str(value).strip().lower()
        if normalized == "cuda":
            return "cuda:0"

        if normalized in {"auto", "cpu"}:
            return normalized

        if normalized.startswith("cuda:"):
            index = normalized.split(":", 1)[1]
            if index.isdigit():
                return normalized

        raise ValueError("DEVICE must be one of: auto, cpu, cuda, cuda:<index>")

    @field_validator("VOICES_DIR", "OUTPUT_DIR", "UPLOAD_DIR", "HF_CACHE_DIR", mode="after")
    @classmethod
    def _resolve_relative_dirs(cls, value: Path, info) -> Path:
        """Resolve relative directories against BASE_DIR for consistency."""
        base_dir = info.data.get("BASE_DIR") or Path(__file__).parent.parent
        value_path = Path(value)
        if not value_path.is_absolute():
            value_path = Path(base_dir) / value_path
        return value_path.resolve()


# =============================================================================
# Global Settings Instance
# =============================================================================
# This is the main settings object used throughout the application.
# Import this in other modules: from backend.config import settings

settings = Settings()


@contextlib.contextmanager
def huggingface_network_context(bypass_proxy: bool | None = None):
    """
    Temporarily sanitize proxy env for Hugging Face operations.

    Some environments inject invalid global proxies (for example 127.0.0.1:9),
    which breaks model download/load from huggingface.co. When enabled, this
    context removes proxy vars only for the current process block.
    """
    use_proxy_bypass = settings.BYPASS_HF_PROXY if bypass_proxy is None else bool(bypass_proxy)

    proxy_keys = [
        "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
        "http_proxy", "https_proxy", "all_proxy",
        "GIT_HTTP_PROXY", "GIT_HTTPS_PROXY",
    ]
    saved = {k: os.environ.get(k) for k in proxy_keys}
    saved_no_proxy = os.environ.get("NO_PROXY")
    saved_no_proxy_lc = os.environ.get("no_proxy")
    saved_hf_home = os.environ.get("HF_HOME")
    saved_hf_hub_cache = os.environ.get("HUGGINGFACE_HUB_CACHE")
    saved_transformers_cache = os.environ.get("TRANSFORMERS_CACHE")
    saved_disable_xet = os.environ.get("HF_HUB_DISABLE_XET")

    hf_hosts = [
        "huggingface.co",
        "hf.co",
        "cdn-lfs.huggingface.co",
        "cdn-lfs-us-1.huggingface.co",
    ]

    try:
        if use_proxy_bypass:
            for key in proxy_keys:
                os.environ.pop(key, None)

        settings.HF_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        hf_home = str(settings.HF_CACHE_DIR)
        os.environ["HF_HOME"] = hf_home
        os.environ["HUGGINGFACE_HUB_CACHE"] = str(settings.HF_CACHE_DIR / "hub")
        os.environ["TRANSFORMERS_CACHE"] = str(settings.HF_CACHE_DIR / "transformers")
        # Xet CAS transport can fail on some Windows security stacks.
        os.environ["HF_HUB_DISABLE_XET"] = "1"

        if use_proxy_bypass:
            merged_no_proxy = ",".join(
                [value for value in [saved_no_proxy or "", *hf_hosts] if value]
            )
            os.environ["NO_PROXY"] = merged_no_proxy
            os.environ["no_proxy"] = merged_no_proxy
        yield
    finally:
        for key, value in saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

        if saved_no_proxy is None:
            os.environ.pop("NO_PROXY", None)
        else:
            os.environ["NO_PROXY"] = saved_no_proxy

        if saved_no_proxy_lc is None:
            os.environ.pop("no_proxy", None)
        else:
            os.environ["no_proxy"] = saved_no_proxy_lc

        if saved_hf_home is None:
            os.environ.pop("HF_HOME", None)
        else:
            os.environ["HF_HOME"] = saved_hf_home

        if saved_hf_hub_cache is None:
            os.environ.pop("HUGGINGFACE_HUB_CACHE", None)
        else:
            os.environ["HUGGINGFACE_HUB_CACHE"] = saved_hf_hub_cache

        if saved_transformers_cache is None:
            os.environ.pop("TRANSFORMERS_CACHE", None)
        else:
            os.environ["TRANSFORMERS_CACHE"] = saved_transformers_cache

        if saved_disable_xet is None:
            os.environ.pop("HF_HUB_DISABLE_XET", None)
        else:
            os.environ["HF_HUB_DISABLE_XET"] = saved_disable_xet


def get_device(device: str | None = None, require_gpu: bool | None = None) -> str:
    """
    Determine the best available device for inference.
    
    Args:
        device: Optional override for DEVICE setting.
        require_gpu: Optional override for REQUIRE_GPU setting.

    Returns:
        str: Device string ("cuda:0" or "cpu")
    
    Example:
        >>> device = get_device()
        >>> print(f"Using device: {device}")
    """
    requested = (device or settings.DEVICE or "auto").strip().lower()
    if requested == "cuda":
        requested = "cuda:0"

    try:
        import torch
    except ImportError:
        raise RuntimeError("PyTorch is not installed.")

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is not available. GPU is required.")

    if requested == "auto":
        return "cuda:0"

    if requested.startswith("cuda"):
        if ":" in requested:
            idx = int(requested.split(":", 1)[1])
            if idx < 0 or idx >= torch.cuda.device_count():
                raise RuntimeError(
                    f"Requested '{requested}' but only {torch.cuda.device_count()} CUDA device(s) available."
                )
        return requested

    raise RuntimeError("CPU device not allowed. GPU is required.")


def get_torch_dtype(dtype_name: str | None = None):
    """
    Convert dtype string to PyTorch dtype object.
    
    Returns:
        torch.dtype: PyTorch data type
    
    Example:
        >>> dtype = get_torch_dtype()
        >>> model = Model().to(dtype=dtype)
    """
    import torch
    
    dtype_map = {
        "float32": torch.float32,
        "float16": torch.float16,
        "bfloat16": torch.bfloat16,
    }
    key = (dtype_name or settings.DTYPE).lower()
    return dtype_map.get(key, torch.bfloat16)


def ensure_directories():
    """
    Create necessary directories if they don't exist.
    
    This function is called at startup to ensure all required
    directories exist for storing voices, outputs, and uploads.
    """
    for directory in [settings.VOICES_DIR, settings.OUTPUT_DIR, settings.UPLOAD_DIR, settings.HF_CACHE_DIR]:
        directory.mkdir(parents=True, exist_ok=True)
