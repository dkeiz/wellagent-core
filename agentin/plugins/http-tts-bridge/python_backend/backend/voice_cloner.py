"""
Voice Cloner Module
===================

This module handles custom voice creation from audio samples.
It allows users to upload voice samples and create custom voices
that can be used for text-to-speech generation.

Key Features:
- Upload and process voice samples
- Extract voice embeddings from audio
- Save and manage custom voices
- Support for few-shot voice cloning (1-10 samples)
- Store reference text for higher quality cloning

Usage:
    from backend.voice_cloner import VoiceCloner
    
    cloner = VoiceCloner()
    cloner.create_voice(
        speaker_name="my_character",
        audio_files=["sample1.wav", "sample2.wav"],
        ref_text="Hello, I am your character."
    )
"""

import os
import json
import shutil
import logging
import hashlib
from pathlib import Path
from typing import List, Optional, Dict, Any
from datetime import datetime
import numpy as np

import librosa
import soundfile as sf

from backend.config import settings

# Configure logging
logger = logging.getLogger(__name__)


class VoiceCloner:
    """
    Voice cloning system for creating custom voices from audio samples.
    
    This class manages the process of:
    1. Receiving voice sample uploads
    2. Preprocessing audio (normalization, trimming, etc.)
    3. Extracting voice characteristics
    4. Saving custom voice data
    5. Persisting reference text for the Qwen3-TTS voice cloning API
    
    Attributes:
        voices_dir: Directory where custom voices are stored
        upload_dir: Directory for temporary uploads
    
    Example:
        >>> cloner = VoiceCloner()
        >>> cloner.create_voice("game_hero", ["voice1.wav", "voice2.wav"])
        >>> voices = cloner.list_voices()
    """
    
    def __init__(
        self,
        voices_dir: Optional[Path] = None,
        upload_dir: Optional[Path] = None
    ):
        """
        Initialize the Voice Cloner.
        
        Args:
            voices_dir: Directory for storing custom voices.
                       Defaults to settings.VOICES_DIR
            upload_dir: Directory for temporary uploads.
                       Defaults to settings.UPLOAD_DIR
        """
        self.voices_dir = voices_dir or settings.VOICES_DIR
        self.upload_dir = upload_dir or settings.UPLOAD_DIR
        
        # Ensure directories exist
        self.voices_dir.mkdir(parents=True, exist_ok=True)
        self.upload_dir.mkdir(parents=True, exist_ok=True)
        
        logger.info(f"Voice Cloner initialized")
        logger.info(f"Voices directory: {self.voices_dir}")
        logger.info(f"Upload directory: {self.upload_dir}")
    
    def create_voice(
        self,
        speaker_name: str,
        audio_files: List[Path],
        description: Optional[str] = None,
        ref_text: Optional[str] = None,
        target_sample_rate: int = settings.SAMPLE_RATE
    ) -> Dict[str, Any]:
        """
        Create a custom voice from audio samples.
        
        This method processes uploaded audio files, extracts voice
        characteristics, and saves them as a custom voice that can
        be used for TTS generation.
        
        Args:
            speaker_name: Name for the custom voice (alphanumeric + underscore)
            audio_files: List of paths to audio sample files
            description: Optional description of the voice
            ref_text: Optional transcript of the reference audio (improves clone quality)
            target_sample_rate: Target sample rate for processing (Hz)
        
        Returns:
            Dict with voice creation results:
            - success: Whether creation was successful
            - voice_name: Name of created voice
            - samples_processed: Number of samples processed
            - total_duration: Total duration of samples in seconds
        
        Raises:
            ValueError: If speaker_name is invalid or no valid samples
            RuntimeError: If voice creation fails
        
        Example:
            >>> result = cloner.create_voice(
            ...     speaker_name="my_game_character",
            ...     audio_files=[Path("sample1.wav"), Path("sample2.wav")],
            ...     description="Main character voice",
            ...     ref_text="Hello, I am the main character."
            ... )
            >>> print(result["success"])
            True
        """
        # Validate speaker name
        if not speaker_name or not speaker_name.replace("_", "").isalnum():
            raise ValueError(
                "Speaker name must be alphanumeric (underscore allowed)"
            )
        
        # Check if voice already exists
        voice_dir = self.voices_dir / speaker_name
        if voice_dir.exists():
            raise ValueError(f"Voice '{speaker_name}' already exists")
        
        logger.info(f"Creating voice '{speaker_name}' from {len(audio_files)} samples")
        
        try:
            # Create voice directory structure
            samples_dir = voice_dir / "samples"
            samples_dir.mkdir(parents=True)
            
            # Process each audio file
            processed_samples = []
            total_duration = 0.0
            truncated_samples = 0
            
            for i, audio_file in enumerate(audio_files):
                try:
                    # Process and save the sample
                    processed_path, duration, was_truncated = self._process_sample(
                        audio_file,
                        samples_dir / f"sample_{i:03d}.wav",
                        target_sample_rate
                    )
                    processed_samples.append(processed_path)
                    total_duration += duration
                    if was_truncated:
                        truncated_samples += 1
                    
                    logger.info(f"Processed sample {i+1}/{len(audio_files)}: {duration:.2f}s")
                    
                except Exception as e:
                    logger.warning(f"Failed to process {audio_file}: {e}")
                    continue
            
            # Validate we have at least one valid sample
            if not processed_samples:
                shutil.rmtree(voice_dir)
                raise ValueError("No valid audio samples could be processed")
            
            # Persist reference text if provided
            has_ref_text = bool(ref_text and ref_text.strip())
            if has_ref_text:
                ref_text_path = voice_dir / "ref_text.txt"
                ref_text_path.write_text(ref_text.strip(), encoding="utf-8")
                logger.info("Saved reference text for voice '%s'", speaker_name)

            # Create voice metadata
            metadata = {
                "name": speaker_name,
                "description": description or f"Custom voice: {speaker_name}",
                "sample_count": len(processed_samples),
                "total_duration": round(total_duration, 2),
                "sample_rate": target_sample_rate,
                "created_at": self._get_timestamp(),
                "samples": [str(p.name) for p in processed_samples],
                "has_ref_text": has_ref_text,
                "truncated_samples": truncated_samples,
                "max_sample_seconds": settings.VOICE_CLONE_MAX_SAMPLE_SECONDS,
            }
            
            # Save metadata
            metadata_path = voice_dir / "metadata.json"
            with open(metadata_path, "w") as f:
                json.dump(metadata, f, indent=2)
            
            logger.info(f"Voice '{speaker_name}' created successfully")
            logger.info(f"Samples: {len(processed_samples)}, Duration: {total_duration:.2f}s")
            
            return {
                "success": True,
                "voice_name": speaker_name,
                "samples_processed": len(processed_samples),
                "total_duration": round(total_duration, 2),
                "message": (
                    f"Voice '{speaker_name}' created successfully"
                    + (f" ({truncated_samples} long sample(s) trimmed)." if truncated_samples else "")
                )
            }
            
        except Exception as e:
            # Clean up on failure
            if voice_dir.exists():
                shutil.rmtree(voice_dir)
            logger.error(f"Voice creation failed: {e}")
            raise RuntimeError(f"Failed to create voice: {e}")
    
    def _process_sample(
        self,
        input_path: Path,
        output_path: Path,
        target_sample_rate: int
    ) -> tuple:
        """
        Process a single audio sample.
        
        Steps:
        1. Load audio file
        2. Convert to mono if stereo
        3. Resample to target sample rate
        4. Normalize audio levels
        5. Trim silence
        6. Save processed audio
        
        Args:
            input_path: Path to input audio file
            output_path: Path to save processed audio
            target_sample_rate: Target sample rate in Hz
        
        Returns:
            Tuple of (output_path, duration_in_seconds)
        """
        # Load audio using librosa (handles various formats)
        audio, original_sr = librosa.load(
            str(input_path),
            sr=None,  # Keep original sample rate
            mono=True  # Convert to mono
        )
        
        # Resample if needed
        if original_sr != target_sample_rate:
            audio = librosa.resample(
                audio,
                orig_sr=original_sr,
                target_sr=target_sample_rate
            )
        
        # Normalize audio to [-1, 1] range
        audio = self._normalize_audio(audio)
        
        # Trim silence from beginning and end
        audio, _ = librosa.effects.trim(audio, top_db=30)
        
        # Ensure minimum length (at least 0.5 seconds)
        min_length = int(0.5 * target_sample_rate)
        if len(audio) < min_length:
            # Pad with zeros if too short
            padding = min_length - len(audio)
            audio = np.pad(audio, (0, padding), mode='constant')

        # Cap very long reference samples for faster, more stable clone inference.
        was_truncated = False
        max_length = int(settings.VOICE_CLONE_MAX_SAMPLE_SECONDS * target_sample_rate)
        if len(audio) > max_length:
            audio = audio[:max_length]
            was_truncated = True
        
        # Save processed audio
        sf.write(str(output_path), audio, target_sample_rate)
        
        duration = len(audio) / target_sample_rate
        
        return output_path, duration, was_truncated
    
    def _normalize_audio(self, audio: np.ndarray, target_level: float = -20.0) -> np.ndarray:
        """
        Normalize audio to a target dB level.
        
        Args:
            audio: Input audio array
            target_level: Target level in dB (default: -20 dB)
        
        Returns:
            Normalized audio array
        """
        # Calculate current RMS level
        rms = np.sqrt(np.mean(audio ** 2))
        
        if rms > 0:
            # Convert target level to linear scale
            target_rms = 10 ** (target_level / 20)
            
            # Calculate gain
            gain = target_rms / rms
            
            # Apply gain with clipping protection
            audio = audio * gain
            audio = np.clip(audio, -1.0, 1.0)
        
        return audio
    
    def list_voices(self) -> List[Dict[str, Any]]:
        """
        List all available custom voices.
        
        Returns:
            List of voice metadata dictionaries (includes has_ref_text)
        
        Example:
            >>> voices = cloner.list_voices()
            >>> for voice in voices:
            ...     print(f"{voice['name']}: {voice['sample_count']} samples")
        """
        voices = []
        
        if not self.voices_dir.exists():
            return voices
        
        for voice_dir in self.voices_dir.iterdir():
            if voice_dir.is_dir():
                metadata_path = voice_dir / "metadata.json"
                if metadata_path.exists():
                    try:
                        with open(metadata_path, "r", encoding="utf-8") as f:
                            metadata = json.load(f)
                        # Check for ref_text on disk even if metadata predates the feature
                        ref_text_path = voice_dir / "ref_text.txt"
                        metadata["has_ref_text"] = ref_text_path.exists()
                        voices.append(metadata)
                    except Exception as e:
                        logger.warning(f"Failed to read metadata for {voice_dir.name}: {e}")
        
        return voices
    
    def get_voice(self, speaker_name: str) -> Optional[Dict[str, Any]]:
        """
        Get metadata for a specific custom voice.
        
        Args:
            speaker_name: Name of the voice
        
        Returns:
            Voice metadata dictionary or None if not found
        
        Example:
            >>> voice = cloner.get_voice("my_character")
            >>> if voice:
            ...     print(f"Samples: {voice['sample_count']}")
        """
        voice_dir = self.voices_dir / speaker_name
        metadata_path = voice_dir / "metadata.json"
        
        if metadata_path.exists():
            try:
                with open(metadata_path, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception as e:
                logger.error(f"Failed to read metadata: {e}")
        
        return None
    
    def delete_voice(self, speaker_name: str) -> bool:
        """
        Delete a custom voice.
        
        Args:
            speaker_name: Name of the voice to delete
        
        Returns:
            True if deleted successfully, False otherwise
        
        Example:
            >>> cloner.delete_voice("old_voice")
            True
        """
        voice_dir = self.voices_dir / speaker_name
        
        if voice_dir.exists():
            try:
                shutil.rmtree(voice_dir)
                logger.info(f"Deleted voice: {speaker_name}")
                return True
            except Exception as e:
                logger.error(f"Failed to delete voice: {e}")
                return False
        
        return False
    
    def get_voice_samples(self, speaker_name: str) -> List[Path]:
        """
        Get paths to all samples for a custom voice.
        
        Args:
            speaker_name: Name of the voice
        
        Returns:
            List of paths to audio sample files
        
        Example:
            >>> samples = cloner.get_voice_samples("my_character")
            >>> print(f"Found {len(samples)} samples")
        """
        voice_dir = self.voices_dir / speaker_name
        samples_dir = voice_dir / "samples"
        
        if samples_dir.exists():
            return list(samples_dir.glob("*.wav"))
        
        return []
    
    def get_voice_ref_text(self, speaker_name: str) -> Optional[str]:
        """
        Get reference text for a custom voice (used in voice cloning API).
        
        The Qwen3-TTS generate_voice_clone API uses ref_text alongside
        ref_audio for higher quality cloning. If no ref_text is stored,
        x_vector_only_mode=True should be used instead.

        Checks (in order):
        1. ref_text.txt (combined / user-provided)
        2. Per-segment ref_text_NNN.txt files (picks the longest)
        
        Returns:
            Reference text string or None if not stored.
        """
        voice_dir = self.voices_dir / speaker_name

        # Try combined / user-provided ref_text first
        ref_text_path = voice_dir / "ref_text.txt"
        if ref_text_path.exists():
            try:
                text = ref_text_path.read_text(encoding="utf-8").strip()
                if text:
                    return text
            except Exception as e:
                logger.warning(f"Failed to read ref_text for {speaker_name}: {e}")

        # Fall back to per-segment ref_text files (pick the longest)
        best_text = None
        for ref_file in sorted(voice_dir.glob("ref_text_*.txt")):
            try:
                text = ref_file.read_text(encoding="utf-8").strip()
                if text and (best_text is None or len(text) > len(best_text)):
                    best_text = text
            except Exception:
                continue

        return best_text
    
    def _get_timestamp(self) -> str:
        """Get current timestamp as ISO format string."""
        return datetime.now().isoformat()


# =============================================================================
# Global Voice Cloner Instance
# =============================================================================

voice_cloner = VoiceCloner()
