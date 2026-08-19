import threading
import time
import uuid
from datetime import datetime
from typing import Optional

from backend.catalog import normalize_tts_engine
from backend.config import settings
from backend.tts_engine import tts_engine


class BackendState:
    def __init__(self):
        self.started_at = time.time()
        self.history = []
        self.history_lock = threading.Lock()
        self.model_lock = threading.Lock()
        self.download_tasks = {}
        self.download_lock = threading.Lock()
        self.last_stream_stats = {}

    def append_history(self, item: dict) -> None:
        with self.history_lock:
            self.history.insert(0, item)
            if len(self.history) > 50:
                self.history.pop()

    def snapshot_history(self) -> list:
        with self.history_lock:
            return list(self.history)

    def set_last_stream_stats(self, stats: dict) -> None:
        with self.history_lock:
            self.last_stream_stats = dict(stats or {})

    def get_perf_snapshot(self) -> dict:
        with self.history_lock:
            history = list(self.history)
            last_stream = dict(self.last_stream_stats)

        recent = history[:5]
        warm_values = [
            float(item.get("generation_time") or 0)
            for item in recent
            if isinstance(item.get("generation_time"), (int, float))
        ]
        warm_average = round(sum(warm_values) / len(warm_values), 3) if warm_values else None

        return {
            "history_count": len(history),
            "last_generation": history[0] if history else None,
            "warm_generation_average": warm_average,
            "last_stream": last_stream or None,
        }

    def start_model_download_task(self, model_name: str, requested_engine: Optional[str] = None) -> dict:
        task_id = uuid.uuid4().hex
        task = {
            "task_id": task_id,
            "model_name": model_name,
            "status": "queued",
            "progress_percent": 0.0,
            "downloaded_bytes": 0,
            "total_bytes": 0,
            "local_path": None,
            "message": "Queued",
            "error": None,
            "created_at": datetime.now().isoformat(),
            "started_at": None,
            "finished_at": None,
        }

        with self.download_lock:
            self.download_tasks[task_id] = task

        def worker():
            task["status"] = "running"
            task["progress_percent"] = 5.0
            task["started_at"] = datetime.now().isoformat()
            task["message"] = "Downloading model files"
            try:
                with self.model_lock:
                    tts_engine.load_model(
                        model_name=model_name,
                        model_source_policy="auto_download",
                        tts_engine=normalize_tts_engine(requested_engine or settings.TTS_ENGINE),
                    )
                probe = tts_engine.get_local_model_probe(model_name)
                task["status"] = "completed"
                task["progress_percent"] = 100.0
                task["local_path"] = probe.get("local_path")
                task["message"] = "Model is available locally"
                task["error"] = None
            except Exception as err:
                task["status"] = "failed"
                task["progress_percent"] = 100.0
                task["error"] = str(err)
                task["message"] = "Model download failed"
            finally:
                task["finished_at"] = datetime.now().isoformat()

        threading.Thread(target=worker, daemon=True, name=f"model-download-{task_id[:8]}").start()
        return dict(task)

    def get_download_task(self, task_id: str) -> Optional[dict]:
        with self.download_lock:
            task = self.download_tasks.get(task_id)
            return dict(task) if task else None


backend_state = BackendState()
