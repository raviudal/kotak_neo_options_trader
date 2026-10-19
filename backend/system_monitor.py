import time
import os
import sys
import platform
import logging
from datetime import datetime, timezone, timedelta
from typing import Dict, Any

try:
    import psutil
    PSUTIL_AVAILABLE = True
except ImportError:
    PSUTIL_AVAILABLE = False

logger = logging.getLogger("system_monitor")

SERVER_START_TIME = time.time()
IST = timezone(timedelta(hours=5, minutes=30))

_cached_stats: Dict[str, Any] = {}
_last_fetch_time: float = 0.0
CACHE_TTL = 1.0  # 1 second cache to minimize CPU overhead on high-frequency calls


def format_uptime(seconds: float) -> str:
    secs = int(seconds)
    days, remainder = divmod(secs, 86400)
    hours, remainder = divmod(remainder, 3600)
    minutes, secs = divmod(remainder, 60)
    if days > 0:
        return f"{days}d {hours}h {minutes}m"
    if hours > 0:
        return f"{hours}h {minutes}m {secs}s"
    if minutes > 0:
        return f"{minutes}m {secs}s"
    return f"{secs}s"


def get_system_health(ws_clients_count: int = 0) -> Dict[str, Any]:
    global _cached_stats, _last_fetch_time

    now = time.time()
    if _cached_stats and (now - _last_fetch_time) < CACHE_TTL:
        # Refresh dynamic server time and connections
        now_ist = datetime.now(IST)
        _cached_stats["server_time"] = now_ist.strftime("%d %b %Y, %H:%M:%S IST")
        _cached_stats["uptime_seconds"] = int(now - SERVER_START_TIME)
        _cached_stats["uptime_formatted"] = format_uptime(now - SERVER_START_TIME)
        _cached_stats["active_clients"] = ws_clients_count
        return _cached_stats

    now_ist = datetime.now(IST)
    uptime_sec = now - SERVER_START_TIME

    if not PSUTIL_AVAILABLE:
        # Fallback if psutil is somehow missing
        _cached_stats = {
            "status": "HEALTHY",
            "cpu_percent": 0.0,
            "cpu_cores": os.cpu_count() or 1,
            "memory": {"total_gb": 0, "used_gb": 0, "free_gb": 0, "percent": 0.0},
            "disk": {"total_gb": 0, "used_gb": 0, "free_gb": 0, "percent": 0.0},
            "process": {"memory_mb": 0.0, "pid": os.getpid(), "threads": 1},
            "uptime_seconds": int(uptime_sec),
            "uptime_formatted": format_uptime(uptime_sec),
            "server_time": now_ist.strftime("%d %b %Y, %H:%M:%S IST"),
            "platform": platform.system(),
            "active_clients": ws_clients_count
        }
        _last_fetch_time = now
        return _cached_stats

    try:
        cpu_pct = psutil.cpu_percent(interval=None)
        cpu_cores = psutil.cpu_count(logical=True) or 1
        
        vmem = psutil.virtual_memory()
        mem_total_gb = round(vmem.total / (1024 ** 3), 2)
        mem_used_gb = round(vmem.used / (1024 ** 3), 2)
        mem_free_gb = round(vmem.available / (1024 ** 3), 2)
        mem_pct = vmem.percent

        root_path = os.path.abspath(os.sep)
        disk = psutil.disk_usage(root_path)
        disk_total_gb = round(disk.total / (1024 ** 3), 1)
        disk_used_gb = round(disk.used / (1024 ** 3), 1)
        disk_free_gb = round(disk.free / (1024 ** 3), 1)
        disk_pct = disk.percent

        proc = psutil.Process()
        proc_mem_mb = round(proc.memory_info().rss / (1024 ** 2), 1)
        proc_threads = proc.num_threads() if hasattr(proc, "num_threads") else 1

        # Health status evaluation
        health_status = "HEALTHY"
        if cpu_pct >= 95 or mem_pct >= 95 or disk_pct >= 98:
            health_status = "CRITICAL"
        elif cpu_pct >= 80 or mem_pct >= 85 or disk_pct >= 90:
            health_status = "WARNING"

        _cached_stats = {
            "status": health_status,
            "cpu_percent": round(cpu_pct, 1),
            "cpu_cores": cpu_cores,
            "memory": {
                "total_gb": mem_total_gb,
                "used_gb": mem_used_gb,
                "free_gb": mem_free_gb,
                "percent": round(mem_pct, 1)
            },
            "disk": {
                "total_gb": disk_total_gb,
                "used_gb": disk_used_gb,
                "free_gb": disk_free_gb,
                "percent": round(disk_pct, 1)
            },
            "process": {
                "memory_mb": proc_mem_mb,
                "pid": os.getpid(),
                "threads": proc_threads
            },
            "uptime_seconds": int(uptime_sec),
            "uptime_formatted": format_uptime(uptime_sec),
            "server_time": now_ist.strftime("%d %b %Y, %H:%M:%S IST"),
            "platform": platform.system(),
            "active_clients": ws_clients_count
        }
        _last_fetch_time = now

    except Exception as e:
        logger.warning(f"Error reading system health: {e}")
        if not _cached_stats:
            _cached_stats = {
                "status": "HEALTHY",
                "cpu_percent": 0.0,
                "cpu_cores": 1,
                "memory": {"total_gb": 0, "used_gb": 0, "free_gb": 0, "percent": 0.0},
                "disk": {"total_gb": 0, "used_gb": 0, "free_gb": 0, "percent": 0.0},
                "process": {"memory_mb": 0.0, "pid": os.getpid(), "threads": 1},
                "uptime_seconds": int(uptime_sec),
                "uptime_formatted": format_uptime(uptime_sec),
                "server_time": now_ist.strftime("%d %b %Y, %H:%M:%S IST"),
                "platform": platform.system(),
                "active_clients": ws_clients_count
            }

    return _cached_stats
