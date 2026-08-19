"""
Data Models Module
==================

This module defines Pydantic models for request/response validation.
These models ensure data integrity and provide automatic API documentation.

Usage:
    from backend.models import TTSRequest, TTSResponse
    
    request = TTSRequest(text="Hello world", speaker="vivian")
"""

from typing import Optional, List, Any, Literal
from pydantic import BaseModel, Field, field_validator, model_validator
from enum import Enum

from backend.config import settings


# =============================================================================
# Enums
# =============================================================================

class SpeakerEnum(str, Enum):
    """
    Available built-in speaker voices.
    
    Each speaker has a unique voice characteristics:
    - aiden: Male, English, neutral tone
    - dylan: Male, English, deeper voice
    - eric: Male, English, friendly tone
    - ono_anna: Female, Japanese, soft voice
    - ryan: Male, English, professional tone
    - serena: Female, English, warm voice
    - sohee: Female, Korean, cheerful tone
    - uncle_fu: Male, Chinese, mature voice
    - vivian: Female, Chinese, clear pronunciation
    """
    AIDEN = "aiden"
    DYLAN = "dylan"
    ERIC = "eric"
    ONO_ANNA = "ono_anna"
    RYAN = "ryan"
    SERENA = "serena"
    SOHEE = "sohee"
    UNCLE_FU = "uncle_fu"
    VIVIAN = "vivian"


class LanguageEnum(str, Enum):
    """
    Supported languages for text-to-speech.
    
    Use "auto" for automatic language detection, or specify
    the language explicitly for better accuracy.
    """
    AUTO = "auto"
    CHINESE = "chinese"
    ENGLISH = "english"
    FRENCH = "french"
    GERMAN = "german"
    ITALIAN = "italian"
    JAPANESE = "japanese"
    KOREAN = "korean"
    PORTUGUESE = "portuguese"
    RUSSIAN = "russian"
    SPANISH = "spanish"


# =============================================================================
# Request Models
# =============================================================================

class TTSRequest(BaseModel):
    """
    Request model for text-to-speech generation.
    
    Attributes:
        text: The text to convert to speech (required)
        speaker: Voice to use for generation (default: "vivian")
        language: Language of the text (default: "auto")
        instruct: Optional instruction for voice style/emotion
        output_format: Audio format for output (default: "wav")
    
    Example:
        {
            "text": "Hello, how are you today?",
            "speaker": "serena",
            "language": "english",
            "instruct": "Speak in a happy, cheerful tone"
        }
    """
    
    text: str = Field(
        ...,
        min_length=1,
        max_length=5000,
        description="Text to convert to speech",
        examples=["Hello, welcome to our application!"]
    )
    
    speaker: str = Field(
        default="vivian",
        description="Speaker voice to use (built-in or custom voice name)",
        examples=["vivian", "ryan", "my_custom_voice"]
    )
    
    language: str = Field(
        default="auto",
        description="Language of the input text",
        examples=["english", "chinese", "auto"]
    )
    
    instruct: Optional[str] = Field(
        default=None,
        max_length=500,
        description="Optional instruction for voice style, emotion, or tone",
        examples=["Speak in a happy tone", "用特别愤怒的语气说", "Whisper softly"]
    )
    
    output_format: str = Field(
        default="wav",
        description="Output audio format (wav, flac, ogg)",
        examples=["wav", "flac", "ogg"]
    )

    model_name: Optional[str] = Field(
        default=None,
        min_length=1,
        description="Optional model override (auto-loaded when needed)"
    )

    tts_engine: Optional[Literal["auto", "qwen_tts", "faster_qwen3_tts"]] = Field(
        default=None,
        description="Optional engine override for this request"
    )

    auto_download: bool = Field(
        default=False,
        description="Allow automatic model download when model is missing locally"
    )
    
    @field_validator("text")
    @classmethod
    def validate_text(cls, v: str) -> str:
        """Ensure text is not empty after stripping whitespace."""
        if not v.strip():
            raise ValueError("Text cannot be empty or whitespace only")
        return v.strip()
    
    @field_validator("output_format")
    @classmethod
    def validate_format(cls, v: str) -> str:
        """Ensure output format is supported."""
        allowed = settings.OUTPUT_FORMATS
        if v.lower() not in allowed:
            raise ValueError(f"Output format must be one of: {allowed}")
        return v.lower()


class BatchTTSRequest(BaseModel):
    """
    Request model for batch text-to-speech generation.
    
    Generate multiple audio files in a single request.
    All arrays must have the same length.
    
    Example:
        {
            "texts": ["Hello", "Goodbye"],
            "speakers": ["vivian", "ryan"],
            "languages": ["english", "english"]
        }
    """
    
    texts: List[str] = Field(
        ...,
        min_length=1,
        max_length=100,
        description="List of texts to convert"
    )
    
    speakers: List[str] = Field(
        default=["vivian"],
        description="List of speakers (single value or matching texts length)"
    )
    
    languages: List[str] = Field(
        default=["auto"],
        description="List of languages (single value or matching texts length)"
    )

    instructs: Optional[List[Optional[str]]] = Field(
        default=None,
        description="Optional list of instructions"
    )

    output_format: str = Field(
        default="wav",
        description="Output audio format (wav, flac, ogg)",
        examples=["wav", "flac", "ogg"]
    )

    tts_engine: Optional[Literal["auto", "qwen_tts", "faster_qwen3_tts"]] = Field(
        default=None,
        description="Optional engine override for this request"
    )

    @model_validator(mode="after")
    def validate_lengths(self):
        """Allow single-item lists or lists matching texts length."""
        num_texts = len(self.texts)

        if self.speakers and len(self.speakers) not in (1, num_texts):
            raise ValueError("speakers must be a single value or match texts length")

        if self.languages and len(self.languages) not in (1, num_texts):
            raise ValueError("languages must be a single value or match texts length")

        if self.instructs and len(self.instructs) not in (1, num_texts):
            raise ValueError("instructs must be a single value or match texts length")

        allowed = settings.OUTPUT_FORMATS
        if self.output_format.lower() not in allowed:
            raise ValueError(f"Output format must be one of: {allowed}")
        self.output_format = self.output_format.lower()

        return self


class AgentSpeakRequest(BaseModel):
    """Stable request contract for external agent integrations."""

    text: str = Field(..., min_length=1, max_length=5000)
    voice: str = Field(default="vivian")
    language: str = Field(default="auto")
    style: Optional[str] = Field(default=None, max_length=500)
    output_format: str = Field(default="wav")
    request_id: Optional[str] = Field(default=None, max_length=120)
    include_base64: bool = Field(default=False)
    metadata: Optional[dict] = Field(default=None)
    tts_engine: Optional[Literal["auto", "qwen_tts", "faster_qwen3_tts"]] = Field(default=None)

    @field_validator("text")
    @classmethod
    def validate_agent_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("text cannot be empty")
        return value.strip()

    @field_validator("output_format")
    @classmethod
    def validate_agent_output_format(cls, value: str) -> str:
        allowed = settings.OUTPUT_FORMATS
        if value.lower() not in allowed:
            raise ValueError(f"output_format must be one of: {allowed}")
        return value.lower()


class VoiceUploadRequest(BaseModel):
    """
    Request model for uploading voice samples.
    
    This is used internally after file upload to process
    the voice samples and create a custom voice.
    """
    
    speaker_name: str = Field(
        ...,
        min_length=2,
        max_length=50,
        pattern="^[a-zA-Z0-9_]+$",
        description="Name for the custom voice (alphanumeric and underscore only)",
        examples=["my_game_character", "narrator_voice"]
    )
    
    description: Optional[str] = Field(
        default=None,
        max_length=200,
        description="Optional description of the voice",
        examples=["Main character from my indie game"]
    )


# =============================================================================
# Response Models
# =============================================================================

class TTSResponse(BaseModel):
    """
    Response model for text-to-speech generation.
    
    Attributes:
        success: Whether the generation was successful
        audio_url: URL to download the generated audio
        audio_path: Local file path to the audio
        duration: Duration of the audio in seconds
        speaker: Speaker used for generation
        text: Original text that was converted
        message: Status message or error description
    
    Example:
        {
            "success": true,
            "audio_url": "/api/audio/output_123.wav",
            "duration": 2.5,
            "speaker": "vivian",
            "text": "Hello world"
        }
    """
    
    success: bool = Field(
        ...,
        description="Whether the generation was successful"
    )
    
    audio_url: Optional[str] = Field(
        default=None,
        description="URL to download the generated audio file"
    )
    
    audio_path: Optional[str] = Field(
        default=None,
        description="Local file path to the generated audio"
    )
    
    duration: Optional[float] = Field(
        default=None,
        description="Duration of the audio in seconds"
    )
    
    sample_rate: Optional[int] = Field(
        default=None,
        description="Audio sample rate in Hz"
    )

    generation_time: Optional[float] = Field(
        default=None,
        description="Server-side time spent generating the audio in seconds"
    )

    model_name: Optional[str] = Field(
        default=None,
        description="Model identifier used for generation"
    )
    
    speaker: str = Field(
        ...,
        description="Speaker voice used"
    )
    
    text: str = Field(
        ...,
        description="Original text that was converted"
    )
    
    message: str = Field(
        default="Success",
        description="Status message or error description"
    )


class VoiceInfo(BaseModel):
    """
    Information about an available voice.
    
    Attributes:
        name: Voice identifier
        type: Type of voice (builtin or custom)
        languages: Supported languages
        description: Voice description
    """
    
    name: str = Field(
        ...,
        description="Voice identifier"
    )
    
    type: str = Field(
        ...,
        description="Voice type: 'builtin' or 'custom'"
    )
    
    languages: List[str] = Field(
        default=["all"],
        description="Supported languages for this voice"
    )
    
    description: Optional[str] = Field(
        default=None,
        description="Voice description"
    )
    
    sample_count: Optional[int] = Field(
        default=None,
        description="Number of samples used (for custom voices)"
    )


class VoicesListResponse(BaseModel):
    """
    Response model for listing available voices.
    """
    
    success: bool = True
    
    builtin_voices: List[VoiceInfo] = Field(
        ...,
        description="List of built-in voices"
    )
    
    custom_voices: List[VoiceInfo] = Field(
        ...,
        description="List of custom voices"
    )
    
    total: int = Field(
        ...,
        description="Total number of available voices"
    )


class VoiceUploadResponse(BaseModel):
    """
    Response model for voice upload.
    """
    
    success: bool = Field(
        ...,
        description="Whether the upload was successful"
    )
    
    voice_name: str = Field(
        ...,
        description="Name of the created custom voice"
    )
    
    samples_processed: int = Field(
        ...,
        description="Number of voice samples processed"
    )
    
    message: str = Field(
        default="Voice created successfully",
        description="Status message"
    )


class HealthResponse(BaseModel):
    """
    Response model for health check endpoint.
    """
    
    status: str = "healthy"
    
    model_loaded: bool = Field(
        ...,
        description="Whether the TTS model is loaded"
    )
    
    device: str = Field(
        ...,
        description="Device being used for inference"
    )
    
    model_name: str = Field(
        ...,
        description="Name of the loaded model"
    )
    
    version: str = "1.0.0"
    
    uptime_seconds: Optional[float] = Field(
        default=None,
        description="Server uptime in seconds"
    )
    
    memory_percent: Optional[float] = Field(
        default=None,
        description="Memory usage percentage"
    )
    
    cpu_percent: Optional[float] = Field(
        default=None,
        description="CPU usage percentage"
    )


class ErrorResponse(BaseModel):
    """
    Response model for errors.
    """
    
    success: bool = False
    
    error: str = Field(
        ...,
        description="Error type"
    )
    
    message: str = Field(
        ...,
        description="Error description"
    )
    
    details: Optional[dict] = Field(
        default=None,
        description="Additional error details"
    )


class ConfigDefaults(BaseModel):
    speaker: str
    language: str
    output_format: str
    use_flash_attention: bool = False
    attn_implementation: str = "auto"
    tts_engine: str = "auto"


class ConfigLimits(BaseModel):
    max_text_length: int
    min_samples: int
    max_samples: int
    max_sample_size_mb: int
    rate_limit_requests_per_window: int
    rate_limit_window_seconds: int


class CapabilityPreset(BaseModel):
    id: str
    title: str
    description: str
    text: str
    language: str
    instruct: str


class ModelCatalogItem(BaseModel):
    id: str
    label: str
    description: str
    local_available: bool = False
    local_usable: bool = False
    loaded: bool = False
    status: str = "missing"
    local_path: Optional[str] = None
    detail: Optional[str] = None
    incomplete_download: bool = False


class ModelSelectRequest(BaseModel):
    model_name: str = Field(..., min_length=1)
    auto_download: bool = False
    use_flash_attention: Optional[bool] = None
    tts_engine: Optional[Literal["auto", "qwen_tts", "faster_qwen3_tts"]] = None


class ModelSelectResponse(BaseModel):
    success: bool = True
    model_name: str
    loaded: bool
    device: str
    message: str


class ModelDownloadRequest(BaseModel):
    model_name: str = Field(..., min_length=1)


class ModelDownloadStatusItem(BaseModel):
    task_id: str
    model_name: str
    status: str
    progress_percent: float = 0.0
    downloaded_bytes: int = 0
    total_bytes: int = 0
    local_path: Optional[str] = None
    message: Optional[str] = None
    error: Optional[str] = None
    created_at: Optional[str] = None
    started_at: Optional[str] = None
    finished_at: Optional[str] = None


class ModelDownloadResponse(BaseModel):
    success: bool = True
    item: ModelDownloadStatusItem


class QueueSubmitRequest(BaseModel):
    """Unified queue submit request supporting direct, batch, and agent jobs."""

    job_type: Literal["direct", "batch", "agent"] = "direct"
    model_name: Optional[str] = Field(default=None, min_length=1)
    tts_engine: Optional[Literal["auto", "qwen_tts", "faster_qwen3_tts"]] = None
    auto_download: bool = False

    # Direct payload
    text: Optional[str] = Field(default=None, max_length=5000)
    speaker: Optional[str] = None
    language: Optional[str] = "auto"
    instruct: Optional[str] = Field(default=None, max_length=500)
    output_format: Optional[str] = "wav"

    # Batch payload
    texts: Optional[List[str]] = None
    speakers: Optional[List[str]] = None
    languages: Optional[List[str]] = None
    instructs: Optional[List[Optional[str]]] = None

    # Agent payload
    voice: Optional[str] = None
    style: Optional[str] = Field(default=None, max_length=500)
    request_id: Optional[str] = Field(default=None, max_length=120)
    include_base64: Optional[bool] = False
    metadata: Optional[dict[str, Any]] = None


class ConfigResponse(BaseModel):
    success: bool = True
    supported_languages: List[str]
    supported_output_formats: List[str]
    builtin_speakers: List[str]
    defaults: ConfigDefaults
    limits: ConfigLimits
    model_source_policy: str
    tts_engine: str
    supported_tts_engines: List[str]
    loaded_tts_engine: Optional[str] = None
    instruction_suggestions: List[str]
    capability_presets: List[CapabilityPreset]
    model_catalog: List[ModelCatalogItem]


class AgentSpeakResponse(BaseModel):
    success: bool = True
    request_id: str
    text: str
    voice: str
    language: str
    model_name: str
    audio_url: Optional[str] = None
    audio_base64: Optional[str] = None
    mime_type: str
    duration: float
    sample_rate: int
    created_at: str
    message: str
    metadata: Optional[dict] = None


class VoicePrepareRequest(BaseModel):
    """Request to prepare a voice clone from a source audio file."""
    speaker_name: str = Field(..., min_length=2, max_length=50, pattern="^[a-zA-Z0-9_]+$")
    source_file: str = Field(..., min_length=1, description="Filename in the voices/ directory")
    description: Optional[str] = Field(None, max_length=200)
    auto_transcribe: bool = Field(default=True, description="Transcribe segments with Whisper")
    min_segment_sec: float = Field(default=3.0, gt=0.5, le=30.0)
    max_segment_sec: float = Field(default=15.0, gt=1.0, le=60.0)


class VoicePrepareStatusItem(BaseModel):
    task_id: str
    speaker_name: str
    source_file: str
    status: str
    stage: str = ""
    progress_percent: float = 0.0
    segments_found: int = 0
    segments_transcribed: int = 0
    message: Optional[str] = None
    error: Optional[str] = None
    created_at: Optional[str] = None
    finished_at: Optional[str] = None


class VoicePrepareResponse(BaseModel):
    success: bool = True
    item: VoicePrepareStatusItem
