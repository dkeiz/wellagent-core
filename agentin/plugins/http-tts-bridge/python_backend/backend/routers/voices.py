from fastapi import APIRouter, HTTPException

from backend.config import settings
from backend.models import VoiceInfo, VoicePrepareRequest, VoicePrepareResponse, VoicePrepareStatusItem, VoicesListResponse
from backend.voice_cloner import voice_cloner
from backend.voice_preparer import voice_preparer

router = APIRouter(tags=["Voices"])


@router.get("/api/voices", response_model=VoicesListResponse)
async def list_voices():
    builtin = [
        VoiceInfo(
            name=speaker,
            type="builtin",
            languages=["all"],
            description=f"Built-in voice: {speaker}",
        )
        for speaker in settings.BUILTIN_SPEAKERS
    ]
    custom = [
        VoiceInfo(
            name=item["name"],
            type="custom",
            languages=["all"],
            description=item.get("description"),
            sample_count=item.get("sample_count"),
        )
        for item in voice_cloner.list_voices()
    ]
    return VoicesListResponse(
        success=True,
        builtin_voices=builtin,
        custom_voices=custom,
        total=len(builtin) + len(custom),
    )


@router.get("/api/voices/source-files")
async def list_source_files():
    return {"success": True, "files": voice_preparer.list_source_files()}


@router.post("/api/voices/prepare", response_model=VoicePrepareResponse)
async def prepare_voice(request: VoicePrepareRequest):
    speaker_name = request.speaker_name.strip()
    if not speaker_name or not speaker_name.replace("_", "").isalnum():
        raise HTTPException(status_code=400, detail="Speaker name must be alphanumeric (underscore allowed)")

    source_file = request.source_file.strip()
    if not source_file:
        raise HTTPException(status_code=400, detail="source_file cannot be empty")

    source_path = settings.VOICES_DIR / source_file
    if not source_path.exists():
        raise HTTPException(status_code=404, detail=f"Source file not found in voices directory: {source_file}")

    voice_dir = settings.VOICES_DIR / speaker_name
    if voice_dir.exists():
        raise HTTPException(status_code=409, detail=f"Voice '{speaker_name}' already exists")

    try:
        task = voice_preparer.start_async(
            source_path=str(source_path),
            speaker_name=speaker_name,
            description=request.description,
            min_segment_sec=request.min_segment_sec,
            max_segment_sec=request.max_segment_sec,
        )
        return VoicePrepareResponse(item=VoicePrepareStatusItem(**task))
    except Exception as err:
        raise HTTPException(status_code=500, detail=str(err)) from err


@router.get("/api/voices/prepare/{task_id}", response_model=VoicePrepareResponse)
async def get_voice_prepare_status(task_id: str):
    task = voice_preparer.get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Preparation task not found")
    return VoicePrepareResponse(item=VoicePrepareStatusItem(**task))
