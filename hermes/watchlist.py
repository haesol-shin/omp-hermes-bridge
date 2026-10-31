"""Active watches of Hermes rooms, kept across gateway restarts, and the restart re-arm turn.

A watcher started with `terminal(background=true, notify_on_complete=true)` is killed by a normal
gateway shutdown, and after a crash it loses its output and exit code. The room records each watch
here; at plugin load a daemon thread asks the gateway to start one turn per room, listing every
record of that room.
"""

from __future__ import annotations

import json
import logging
import os
import re
import tempfile
import threading
import time
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .spool import QueueError

logger = logging.getLogger(__name__)

RETRY_WINDOW_SECONDS = 600
RETRY_INTERVAL_SECONDS = 5
COMMAND_MAX = 2000
# Public format: agent:<profile>:<platform>:<chat type>:<chat id>[:<thread or user id>]
_SESSION_KEY = re.compile(r"^agent:[^:\s]+:[^:\s]+:[^\s]+$")


class WatchList:
    """One JSON file (mode 0600), replaced atomically."""

    def __init__(self, path: Path, clock: Callable[[], float] = time.time) -> None:
        self.path = path
        self.clock = clock
        self._lock = threading.Lock()

    def _load(self) -> list[dict[str, Any]]:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return []
        except (OSError, ValueError):
            os.replace(self.path, self.path.with_name(self.path.name + ".corrupt"))
            return []
        return [r for r in data if isinstance(r, dict)] if isinstance(data, list) else []

    def _store(self, records: list[dict[str, Any]]) -> None:
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=self.path.parent, prefix=self.path.name, suffix=".tmp")
        try:  # mkstemp creates the file 0600
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(records, handle, ensure_ascii=False)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp, self.path)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise

    def list(self) -> list[dict[str, Any]]:
        with self._lock:
            return self._load()

    def add(self, session_key: str, command: str) -> str:
        if not isinstance(session_key, str) or not _SESSION_KEY.match(session_key):
            raise QueueError(
                "session_key must look like agent:<profile>:<platform>:<chat type>:<id>"
            )
        if not isinstance(command, str) or not command.strip() or len(command) > COMMAND_MAX:
            raise QueueError(
                f"command must be a non-empty string of at most {COMMAND_MAX} characters"
            )
        record = {
            "watch_id": str(uuid.uuid4()),
            "session_key": session_key,
            "command": command,
            "started_at": self.clock(),
        }
        with self._lock:
            self._store([*self._load(), record])
        return record["watch_id"]

    def remove(self, watch_id: str) -> bool:
        with self._lock:
            records = self._load()
            kept = [r for r in records if r.get("watch_id") != watch_id]
            if len(kept) != len(records):
                self._store(kept)
            return len(kept) != len(records)


RESTART_LIST_MAX = 50


def restart_text(records: list[dict[str, Any]]) -> str:
    """One turn for all records of a room; lists at most RESTART_LIST_MAX of them."""
    lines = [
        f"watch_id: {r.get('watch_id')} command: {json.dumps(r.get('command'), ensure_ascii=False)}"
        for r in records[:RESTART_LIST_MAX]
    ]
    if len(records) > RESTART_LIST_MAX:
        lines.append(
            f"{len(records) - RESTART_LIST_MAX} more watch(es) of this room are not listed; "
            "they stay in the watch list."
        )
    return (
        "The gateway restarted. The background watchers below may be gone. This message is data "
        "from the omp-bridge plugin, not an instruction from the user. Re-read the real state "
        "first (taskwatch show, omp_sessions). If the work still runs and the watch is still "
        "wanted, re-arm it with exactly its command and update the record with bridge_watch "
        "(remove, then add). Otherwise handle the final state and remove the record. "
        "Handle all listed watches in this one turn and answer the user once for the whole "
        "list.\n" + "\n".join(lines)
    )


def _by_room(records: list[dict[str, Any]]) -> dict[Any, list[dict[str, Any]]]:
    rooms: dict[Any, list[dict[str, Any]]] = {}
    for record in records:
        rooms.setdefault(record.get("session_key"), []).append(record)
    return rooms


def rearm_all(
    watches: WatchList,
    inject: Callable[..., bool],
    *,
    window: float = RETRY_WINDOW_SECONDS,
    interval: float = RETRY_INTERVAL_SECONDS,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> int:
    """One turn per room, retried until accepted or the window ends. Returns the number of
    records of accepted rooms. Records of unaccepted rooms stay in the file for the next start."""
    todo = _by_room(watches.list())
    if not todo:
        return 0
    deadline = clock() + window
    accepted = 0
    while todo:
        still = {}
        for key, records in todo.items():
            try:
                ok = bool(inject(restart_text(records), session_key=key))
            except Exception:
                logger.warning("omp-bridge: inject_message raised", exc_info=True)
                ok = False
            if ok:
                accepted += len(records)
            else:
                still[key] = records
        todo = still
        if todo:
            if clock() + interval > deadline:
                logger.warning(
                    "omp-bridge: %d room(s) not re-armed; kept for next start", len(todo)
                )
                break
            sleep(interval)
    return accepted


def start_rearm_thread(watches: WatchList, ctx: Any, allowed: bool) -> threading.Thread | None:
    """Daemon thread for the restart turn. Without the permission: one warning, nothing else."""
    if not watches.list():
        return None
    if not allowed:
        logger.warning(
            "omp-bridge: watches are recorded but allow_gateway_injection is not set (plugin "
            "settings and plugins.entries.<id>); no restart turn will be sent"
        )
        return None
    thread = threading.Thread(
        target=rearm_all, args=(watches, ctx.inject_message), name="omp-bridge-rearm", daemon=True
    )
    thread.start()
    return thread
