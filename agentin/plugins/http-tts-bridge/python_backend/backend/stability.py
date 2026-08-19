"""
Stability and Reliability Module
=================================

This module provides stability enhancements for the TTS server including:
- Timeout protection
- Retry logic with exponential backoff
- Memory management
- Request validation
- Health monitoring
- Graceful error handling

Usage:
    from backend.stability import timeout_protection, retry_on_failure
    
    @timeout_protection(timeout_seconds=30)
    @retry_on_failure(max_retries=3)
    def generate_speech():
        # TTS generation logic
        pass
"""

import time
import logging
import functools
import threading
import psutil
import gc
from typing import Callable, Any, Optional, Dict, List
from datetime import datetime, timedelta
from collections import defaultdict
import asyncio

from backend.config import settings

logger = logging.getLogger(__name__)


class StabilityManager:
    """
    Central manager for stability features.
    
    Tracks system health, manages timeouts, and provides
    monitoring capabilities.
    """
    
    def __init__(self):
        self.request_count = 0
        self.error_count = 0
        self.start_time = datetime.now()
        self.request_times: List[float] = []
        self.error_history: List[Dict] = []
        self.memory_usage: List[float] = []
        self._lock = threading.Lock()
        
        # Configuration
        self.max_request_time = 300  # 5 minutes max
        self.max_memory_percent = 90  # Stop at 90% memory usage
        self.cleanup_interval = 60  # Cleanup every 60 seconds
        
        # Start background monitoring
        self._monitor_thread = threading.Thread(target=self._monitor_loop, daemon=True)
        self._monitor_thread.start()
        
        logger.info("Stability manager initialized")
    
    def _monitor_loop(self):
        """Background monitoring loop."""
        while True:
            try:
                self._check_memory()
                self._cleanup_old_data()
                time.sleep(self.cleanup_interval)
            except Exception as e:
                logger.error(f"Monitor loop error: {e}")
    
    def _check_memory(self):
        """Check memory usage and trigger cleanup if needed."""
        try:
            memory_percent = psutil.virtual_memory().percent
            self.memory_usage.append(memory_percent)
            
            if memory_percent > self.max_memory_percent:
                logger.warning(f"High memory usage: {memory_percent}%")
                self.force_cleanup()
        except Exception as e:
            logger.error(f"Memory check failed: {e}")
    
    def _cleanup_old_data(self):
        """Clean up old monitoring data."""
        with self._lock:
            # Keep only last 1000 entries
            if len(self.request_times) > 1000:
                self.request_times = self.request_times[-1000:]
            if len(self.error_history) > 100:
                self.error_history = self.error_history[-100:]
            if len(self.memory_usage) > 100:
                self.memory_usage = self.memory_usage[-100:]
    
    def force_cleanup(self):
        """Force garbage collection and cleanup."""
        logger.info("Forcing cleanup...")
        gc.collect()
        if hasattr(torch, 'cuda') and torch.cuda.is_available():
            torch.cuda.empty_cache()
    
    def record_request(self, duration: float, success: bool, error: Optional[str] = None):
        """Record request metrics."""
        with self._lock:
            self.request_count += 1
            self.request_times.append(duration)
            
            if not success:
                self.error_count += 1
                self.error_history.append({
                    'timestamp': datetime.now(),
                    'error': error,
                    'duration': duration
                })
    
    def get_health_status(self) -> Dict[str, Any]:
        """Get current health status."""
        with self._lock:
            uptime = (datetime.now() - self.start_time).total_seconds()
            avg_request_time = sum(self.request_times[-100:]) / max(len(self.request_times[-100:]), 1)
            error_rate = self.error_count / max(self.request_count, 1)
            
            return {
                'status': 'healthy' if error_rate < 0.1 else 'degraded',
                'uptime_seconds': uptime,
                'total_requests': self.request_count,
                'error_count': self.error_count,
                'error_rate': error_rate,
                'avg_request_time': avg_request_time,
                'memory_usage_percent': psutil.virtual_memory().percent,
                'cpu_usage_percent': psutil.cpu_percent(),
                'recent_errors': self.error_history[-5:] if self.error_history else []
            }


# Global stability manager
stability_manager = StabilityManager()


def timeout_protection(timeout_seconds: int = 300):
    """
    Decorator to add timeout protection to functions.
    
    Args:
        timeout_seconds: Maximum execution time in seconds
    
    Returns:
        Decorated function with timeout protection
    """
    def decorator(func: Callable) -> Callable:
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            result = [None]
            exception = [None]
            
            def target():
                try:
                    result[0] = func(*args, **kwargs)
                except Exception as e:
                    exception[0] = e
            
            thread = threading.Thread(target=target)
            thread.daemon = True
            thread.start()
            thread.join(timeout_seconds)
            
            if thread.is_alive():
                logger.error(f"Function {func.__name__} timed out after {timeout_seconds}s")
                raise TimeoutError(f"Operation timed out after {timeout_seconds} seconds")
            
            if exception[0]:
                raise exception[0]
            
            return result[0]
        
        return wrapper
    return decorator


def retry_on_failure(max_retries: int = 3, delay: float = 1.0, backoff: float = 2.0):
    """
    Decorator to retry failed operations with exponential backoff.
    
    Args:
        max_retries: Maximum number of retry attempts
        delay: Initial delay between retries in seconds
        backoff: Multiplier for delay after each retry
    
    Returns:
        Decorated function with retry logic
    """
    def decorator(func: Callable) -> Callable:
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            last_exception = None
            first_exception = None
            current_delay = delay
            
            for attempt in range(max_retries + 1):
                try:
                    start_time = time.time()
                    result = func(*args, **kwargs)
                    duration = time.time() - start_time
                    
                    # Record successful request
                    stability_manager.record_request(duration, True)
                    return result
                    
                except Exception as e:
                    last_exception = e
                    if first_exception is None:
                        first_exception = e
                    duration = time.time() - start_time
                    
                    # Record failed request
                    stability_manager.record_request(duration, False, str(e))

                    error_text = str(e)
                    non_retryable = (
                        "Model not loaded. Call load_model() first." in error_text
                        or "CUDA device-side assert triggered" in error_text
                    )
                    if non_retryable:
                        logger.error(f"Non-retryable failure in {func.__name__}: {e}")
                        raise
                    
                    if attempt < max_retries:
                        logger.warning(f"Attempt {attempt + 1} failed: {e}. Retrying in {current_delay}s...")
                        time.sleep(current_delay)
                        current_delay *= backoff
                    else:
                        logger.error(f"All {max_retries + 1} attempts failed. Last error: {e}")
            
            raise first_exception or last_exception
        
        return wrapper
    return decorator


def validate_request_data(data: Dict[str, Any], required_fields: List[str]) -> None:
    """
    Validate request data has required fields and valid values.
    
    Args:
        data: Request data dictionary
        required_fields: List of required field names
    
    Raises:
        ValueError: If validation fails
    """
    for field in required_fields:
        if field not in data:
            raise ValueError(f"Missing required field: {field}")
        
        value = data[field]
        if value is None or (isinstance(value, str) and not value.strip()):
            raise ValueError(f"Field '{field}' cannot be empty")
    
    # Validate text length
    if 'text' in data:
        text = data['text']
        if len(text) > settings.MAX_TEXT_LENGTH:
            raise ValueError(
                f"Text too long: {len(text)} characters (max {settings.MAX_TEXT_LENGTH})"
            )
        if len(text) < 1:
            raise ValueError("Text too short: minimum 1 character")


def sanitize_text(text: str) -> str:
    """
    Sanitize input text for TTS processing.
    
    Args:
        text: Input text
    
    Returns:
        Sanitized text
    """
    # Remove control characters
    text = ''.join(char for char in text if ord(char) >= 32 or char in '\n\t')
    
    # Normalize whitespace
    text = ' '.join(text.split())
    
    # Limit length
    if len(text) > settings.MAX_TEXT_LENGTH:
        text = text[:settings.MAX_TEXT_LENGTH]
        logger.warning("Text truncated to %s characters", settings.MAX_TEXT_LENGTH)
    
    return text.strip()


def check_system_resources() -> Dict[str, Any]:
    """
    Check if system has sufficient resources for TTS generation.
    
    Returns:
        Dictionary with resource status
    """
    try:
        memory = psutil.virtual_memory()
        cpu_percent = psutil.cpu_percent(interval=0.1)
        
        return {
            'memory_available_gb': memory.available / (1024**3),
            'memory_percent': memory.percent,
            'cpu_percent': cpu_percent,
            'can_process': memory.percent < 90 and cpu_percent < 90,
            'warnings': []
        }
    except Exception as e:
        logger.error(f"Resource check failed: {e}")
        return {
            'memory_available_gb': 0,
            'memory_percent': 100,
            'cpu_percent': 100,
            'can_process': False,
            'warnings': [f"Resource check failed: {e}"]
        }


class RequestLimiter:
    """
    Rate limiter for API requests.
    """
    
    def __init__(self, max_requests: int = 100, time_window: int = 60):
        self.max_requests = max_requests
        self.time_window = time_window
        self.requests: Dict[str, List[datetime]] = defaultdict(list)
        self._lock = threading.Lock()
    
    def is_allowed(self, client_id: str) -> bool:
        """Check if request is allowed for client."""
        with self._lock:
            now = datetime.now()
            cutoff = now - timedelta(seconds=self.time_window)
            
            # Clean old requests
            self.requests[client_id] = [
                req_time for req_time in self.requests[client_id]
                if req_time > cutoff
            ]
            
            # Check limit
            if len(self.requests[client_id]) >= self.max_requests:
                return False
            
            # Record new request
            self.requests[client_id].append(now)
            return True
    
    def get_remaining(self, client_id: str) -> int:
        """Get remaining requests for client."""
        with self._lock:
            now = datetime.now()
            cutoff = now - timedelta(seconds=self.time_window)
            
            recent_requests = [
                req_time for req_time in self.requests[client_id]
                if req_time > cutoff
            ]
            
            return max(0, self.max_requests - len(recent_requests))


# Global rate limiter
rate_limiter = RequestLimiter(
    max_requests=settings.RATE_LIMIT_REQUESTS_PER_WINDOW,
    time_window=settings.RATE_LIMIT_WINDOW_SECONDS,
)


def get_client_id(request) -> str:
    """Extract client ID from request."""
    # Use IP address as client ID
    return request.client.host if hasattr(request, 'client') else 'unknown'


# Import torch for cleanup
try:
    import torch
except ImportError:
    torch = None
