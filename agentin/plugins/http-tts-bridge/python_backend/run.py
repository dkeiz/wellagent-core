#!/usr/bin/env python3
"""
Qwen3 TTS Server Launcher
==========================

This script starts the Qwen3 TTS API server.

Usage:
    python run.py                    # Start with default settings
    python run.py --no-ui            # Start server without opening browser
    python run.py --port 8080        # Custom port
    python run.py --host 127.0.0.1   # Localhost only
    python run.py --reload           # Auto-reload on code changes (development)

The server will be available at:
    - API: http://localhost:8000
    - Docs: http://localhost:8000/api/docs
    - Frontend: http://localhost:8000/static/index.html
"""

import argparse
import logging
import os
import sys
import threading
import time
import webbrowser
import urllib.request
import urllib.error
from pathlib import Path

os.environ.setdefault("USE_TF", "0")
os.environ.setdefault("TRANSFORMERS_NO_TF", "1")

import uvicorn
import psutil

from backend.config import settings

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)


def _enforce_electron_parent() -> None:
    """Reject standalone server starts outside the Electron application runtime."""
    if os.environ.get("LOCALAGENT_VOICE_BACKEND_PARENT") == "electron-app":
        return
    raise RuntimeError("Voice backend may only be started by the Electron application runtime.")


def _enforce_gpu_only_startup() -> None:
    """Fail fast unless backend is configured for strict CUDA execution."""
    if not settings.REQUIRE_GPU:
        return

    try:
        import torch
    except ImportError as err:
        raise RuntimeError("PyTorch is not installed in the active interpreter.") from err

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is not available in the active interpreter.")

    device = (settings.DEVICE or "auto").strip().lower()
    if device == "cuda":
        device = "cuda:0"
    
    if device == "auto":
        if torch.cuda.device_count() == 0:
            raise RuntimeError("DEVICE=auto but no CUDA devices are available.")
        return

    if device.startswith("cuda:"):
        try:
            index = int(device.split(":", 1)[1])
        except (ValueError, IndexError) as err:
            raise RuntimeError(f"Invalid CUDA device '{settings.DEVICE}'.") from err

        if index < 0 or index >= torch.cuda.device_count():
            raise RuntimeError(
                f"Configured {settings.DEVICE} but only {torch.cuda.device_count()} CUDA device(s) are available."
            )
        return

    if device == "cpu":
        raise RuntimeError("DEVICE=cpu but REQUIRE_GPU=true. GPU is required.")

    raise RuntimeError(f"Invalid DEVICE value: {settings.DEVICE}")


def parse_args():
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(
        description="Qwen3 TTS API Server",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python run.py                      Start with default settings
  python run.py --no-ui              Start server only, no browser open
  python run.py --port 8080          Use custom port
  python run.py --host 127.0.0.1     Localhost only
  python run.py --reload             Development mode with auto-reload
  python run.py --model Qwen/Qwen3-TTS-12Hz-1.7B-Base   Use voice cloning model
        """
    )
    
    parser.add_argument(
        "--host",
        type=str,
        default=settings.HOST,
        help=f"Host address to bind to (default: {settings.HOST})"
    )
    
    parser.add_argument(
        "--port",
        type=int,
        default=settings.PORT,
        help=f"Port to listen on (default: {settings.PORT})"
    )
    
    parser.add_argument(
        "--reload",
        action="store_true",
        help="Enable auto-reload for development"
    )

    parser.add_argument(
        "--no-ui",
        action="store_true",
        help="Start server only (do not auto-open the web UI in a browser)"
    )
    
    parser.add_argument(
        "--model",
        type=str,
        default=None,
        help="Model name to use (default: from config)"
    )
    
    parser.add_argument(
        "--device",
        type=str,
        default=None,
        help="Device to use (cuda:0, cpu, auto)"
    )

    parser.add_argument(
        "--tts-engine",
        type=str,
        default=None,
        choices=["auto", "qwen_tts", "faster_qwen3_tts"],
        help="TTS engine backend (auto, qwen_tts, faster_qwen3_tts)"
    )
    
    parser.add_argument(
        "--log-level",
        type=str,
        default="info",
        choices=["debug", "info", "warning", "error"],
        help="Logging level (default: info)"
    )

    parser.add_argument(
        "--kill-port",
        action="store_true",
        help="If target port is busy, terminate the process using it before startup"
    )
    
    return parser.parse_args()


def _find_listening_pids(port: int) -> list[int]:
    """Return PIDs listening on a TCP port."""
    pids: set[int] = set()
    current_pid = os.getpid()

    try:
        for conn in psutil.net_connections(kind="inet"):
            if conn.status != psutil.CONN_LISTEN:
                continue
            if not conn.laddr:
                continue
            if conn.laddr.port != port:
                continue
            if conn.pid is None:
                continue
            if conn.pid == current_pid:
                continue
            pids.add(conn.pid)
    except Exception as err:
        logger.warning("Failed to inspect listening ports via psutil: %s", err)

    return sorted(pids)


def _terminate_pid(pid: int, timeout_s: float = 5.0) -> bool:
    """Terminate a PID and escalate to kill if needed."""
    try:
        proc = psutil.Process(pid)
    except psutil.NoSuchProcess:
        return True

    try:
        proc.terminate()
        proc.wait(timeout=timeout_s)
        return True
    except (psutil.TimeoutExpired, psutil.AccessDenied):
        pass
    except psutil.NoSuchProcess:
        return True

    try:
        proc.kill()
        proc.wait(timeout=timeout_s)
        return True
    except (psutil.NoSuchProcess, psutil.TimeoutExpired, psutil.AccessDenied):
        return False


def _port_preflight(port: int, kill_port: bool) -> None:
    """Ensure target port is free before uvicorn binds."""
    busy_pids = _find_listening_pids(port)
    if not busy_pids:
        return

    if kill_port:
        logger.warning("Port %s is busy. Attempting to terminate: %s", port, ", ".join(map(str, busy_pids)))
        failed: list[int] = []
        for pid in busy_pids:
            if not _terminate_pid(pid):
                failed.append(pid)

        remaining = _find_listening_pids(port)
        if remaining:
            raise RuntimeError(
                f"Port {port} is still busy after --kill-port. Remaining PID(s): {', '.join(map(str, remaining))}"
            )

        if failed:
            logger.warning("Some PID(s) could not be terminated cleanly: %s", ", ".join(map(str, failed)))
        logger.info("Port %s is now free.", port)
        return

    details = []
    for pid in busy_pids:
        try:
            name = psutil.Process(pid).name()
        except Exception:
            name = "unknown"
        details.append(f"{pid} ({name})")

    raise RuntimeError(
        f"Port {port} is already in use by: {', '.join(details)}. "
        "Stop those process(es) or restart with --kill-port."
    )


def main():
    """Main entry point."""
    _enforce_electron_parent()
    args = parse_args()
    
    # Set logging level
    logging.getLogger().setLevel(getattr(logging, args.log_level.upper()))
    
    # Override config if specified
    if args.model:
        settings.MODEL_NAME = args.model
        logger.info(f"Using model: {args.model}")
    
    if args.device:
        settings.DEVICE = args.device
        logger.info(f"Using device: {args.device}")

    if args.tts_engine:
        settings.TTS_ENGINE = args.tts_engine
        logger.info(f"Using TTS engine: {args.tts_engine}")

    _port_preflight(args.port, args.kill_port)

    # Strict GPU preflight can delay boot significantly on some Windows CUDA setups.
    # When startup model loading is deferred, allow server to bind quickly and enforce
    # GPU requirements at generation/model-load time instead.
    if settings.REQUIRE_GPU and not settings.DEFER_MODEL_LOAD_ON_STARTUP:
        _enforce_gpu_only_startup()
    elif settings.REQUIRE_GPU and settings.DEFER_MODEL_LOAD_ON_STARTUP:
        logger.info("Skipping blocking GPU preflight because DEFER_MODEL_LOAD_ON_STARTUP=true")
    
    # Print startup info
    logger.info("=" * 60)
    logger.info("Qwen3 TTS Server")
    logger.info("=" * 60)
    logger.info(f"Host: {args.host}")
    logger.info(f"Port: {args.port}")
    logger.info(f"Reload: {args.reload}")
    logger.info(f"Auto-open UI: {not args.no_ui}")
    logger.info("")
    logger.info("Access points:")
    logger.info(f"  - API:      http://localhost:{args.port}")
    logger.info(f"  - Docs:     http://localhost:{args.port}/api/docs")
    logger.info(f"  - Frontend: http://localhost:{args.port}/static/index.html")
    logger.info("=" * 60)

    def _resolve_browser_host(host: str) -> str:
        if not host:
            return "localhost"

        normalized = host.strip().lower()
        if normalized in {"0.0.0.0", "::", "[::]"}:
            return "localhost"
        return host

    def _open_browser_when_ready() -> None:
        def _wait_for_server(url: str, timeout_s: float = 180.0, poll_s: float = 0.75) -> bool:
            deadline = time.time() + timeout_s
            while time.time() < deadline:
                try:
                    with urllib.request.urlopen(url, timeout=2) as resp:
                        if 200 <= resp.status < 500:
                            return True
                except (urllib.error.URLError, TimeoutError):
                    pass
                except Exception:
                    pass
                time.sleep(poll_s)
            return False

        ui_host = _resolve_browser_host(args.host)
        base_url = f"http://{ui_host}:{args.port}"
        url = f"{base_url}/static/index.html"
        health_url = f"{base_url}/api/health"
        ready = _wait_for_server(health_url)
        try:
            webbrowser.open(url, new=2)
            if ready:
                logger.info(f"Opened web UI: {url}")
            else:
                logger.warning(
                    "Opened web UI, but server did not pass readiness probe in time: %s",
                    health_url,
                )
        except Exception as err:
            logger.warning(f"Failed to open browser automatically: {err}")

    if not args.no_ui:
        threading.Thread(target=_open_browser_when_ready, daemon=True, name="ui-autostart").start()
    
    # Start the server
    uvicorn.run(
        "backend.app:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
        log_level=args.log_level,
        access_log=True
    )


if __name__ == "__main__":
    main()
