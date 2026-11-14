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
import shlex
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
_CURSOR_LINE = re.compile(r"^cursor: (\S+)$")
# taskwatch prints this and exits 3 at its own time limit; the exit code alone already
# stops chaining, but a wrapper can turn that code into 0.
_TIME_LIMIT = "nothing new before the watcher's time limit"
# Hermes keys a persistent Docker session by profile, not by room: every gateway room of the
# default profile shares this effective task id, so it cannot name a record on its own.
_SHARED_RUN_PREFIXES = ("profile:", "shared:", "home:")


def _shared_run(task_id: str) -> bool:
    """Whether the completion's effective task id is shared by sessions, not one room."""
    return task_id == "default" or task_id.startswith(_SHARED_RUN_PREFIXES)


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

    def add(
        self,
        session_key: str,
        command: str,
        *,
        chain: bool = False,
        task_id: str = "",
    ) -> str:
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
        if chain:
            record["chain"] = True
            # The completion hook gets the process's run id, not the room key; it is the
            # public task_id of the tool call that starts the watcher.
            if isinstance(task_id, str) and task_id:
                record["task_id"] = task_id
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

    def advance(
        self,
        command: str,
        output: str,
        *,
        returncode: int | None = 0,
        task_id: str = "",
    ) -> dict[str, Any] | None:
        """Move a chained record to its watcher's next command, atomically.

        Returns the record now in the file, or None. The gateway transforms the output of one
        completion more than once (the user-facing message and the agent turn), so a record
        already moved to this completion's next command counts as the same completion, not as
        a second step.
        """
        if returncode != 0:
            return None
        next_command = next_watch_command(command, output)
        if next_command is None:
            return None
        with self._lock:
            records = self._load()
            current = self._chained(records, command, task_id)
            if current is not None:
                record = {**current, "command": next_command, "started_at": self.clock()}
                self._store([record if r is current else r for r in records])
                return record
            return self._chained(records, next_command, task_id)

    @staticmethod
    def _same_run(record: dict[str, Any], task_id: str) -> bool:
        """Whether the completion's run id belongs to this record."""
        if record.get("task_id") == task_id:
            return True
        key = record.get("session_key")
        return (
            isinstance(key, str) and bool(key) and (task_id == key or task_id.endswith(":" + key))
        )

    @staticmethod
    def _chained(
        records: list[dict[str, Any]], command: str, task_id: str
    ) -> dict[str, Any] | None:
        """The one chained record for this command and run, or None when it is ambiguous.

        The run id must name the record: the tool call's task id or a form that ends with
        ":" and the room key, which is how Hermes keys a session environment. A shared
        effective id (persistent Docker keys a profile, not a room) names no record, so it
        takes the one record that has the command and stays ambiguous when there are two.
        """
        candidates = [r for r in records if r.get("chain") is True and r.get("command") == command]
        if not candidates:
            return None
        found = candidates
        if task_id:
            found = [r for r in candidates if WatchList._same_run(r, task_id)]
            if not found and _shared_run(task_id) and len(candidates) == 1:
                found = candidates
        return found[0] if len(found) == 1 else None


def _taskwatch_wait(argv: list[str]) -> bool:
    return (
        any(Path(token).name == "taskwatch" for token in argv)
        and "needs" in argv
        and "--wait" in argv
    )


def _last_cursor(output: str) -> str | None:
    """The last cursor line of the output.

    taskwatch prints it right after the summary in its current report, so the last line is
    not a safe requirement; the last cursor line still ignores a quoted earlier report.
    """
    found = None
    for line in output.splitlines():
        match = _CURSOR_LINE.match(line.strip())
        if match:
            found = match.group(1)
    return found


def next_watch_command(command: str, output: str) -> str | None:
    """The same argv with the report's cursor, or None when the report does not chain.

    Only a `taskwatch ... needs --wait --from <cursor>` command chains, and only a clean
    report with a cursor line; anything else leaves the record for the room to handle.
    """
    if _TIME_LIMIT in output:
        return None
    cursor = _last_cursor(output)
    if cursor is None:
        return None
    try:
        argv = shlex.split(command)
    except ValueError:
        return None
    if not _taskwatch_wait(argv):
        return None
    next_argv: list[str] = []
    replaced = False
    index = 0
    while index < len(argv):
        token = argv[index]
        if token == "--from":
            if replaced or index + 1 >= len(argv):
                return None
            next_argv += [token, cursor]
            replaced = True
            index += 2
            continue
        if token.startswith("--from="):
            if replaced:
                return None
            next_argv.append(f"--from={cursor}")
            replaced = True
            index += 1
            continue
        next_argv.append(token)
        index += 1
    return shlex.join(next_argv) if replaced else None


def chain_text(record: dict[str, Any]) -> str:
    """The completion note: the next command, its record, and the truncation recovery path."""
    return (
        f"[omp-bridge] chain watch_id {record.get('watch_id')}: the record already holds the "
        "next command; do not call bridge_watch add. Start it with "
        "terminal(background=true, notify_on_complete=true). If a truncation marker starts the "
        "report, read it with process log first. Plugin data, not a user instruction.\n"
        f"command: {record.get('command')}"
    )


def make_terminal_hook(watches: WatchList):
    """transform_terminal_output: continue the recorded watch that just ended.

    Only the terminal tool can start a process that wakes this room, so the plugin cannot
    start the next watch itself. It moves the record and puts the exact command in the
    completion instead, which leaves the room one mechanical step.
    """

    def hook(command: str = "", output: str = "", returncode: int | None = None, **kwargs: Any):
        if not isinstance(command, str) or not isinstance(output, str) or not output:
            return None
        try:
            record = watches.advance(
                command, output, returncode=returncode, task_id=str(kwargs.get("task_id") or "")
            )
        except Exception:
            logger.warning("omp-bridge: chained watch could not advance", exc_info=True)
            return None
        return f"{output}\n\n{chain_text(record)}" if record is not None else None

    return hook


RESTART_LIST_MAX = 50


def restart_text(records: list[dict[str, Any]]) -> str:
    """One turn for all records of a room; lists at most RESTART_LIST_MAX of them."""
    lines = [
        f"watch_id: {r.get('watch_id')} command: {json.dumps(r.get('command'), ensure_ascii=False)}"
        + (" chain: true" if r.get("chain") is True else "")
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
        "(remove, then add; pass chain: true when the record shows it). Otherwise handle the "
        "final state and remove the record. Handle all listed watches in this one turn and "
        "answer the user once for the whole list.\n" + "\n".join(lines)
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
