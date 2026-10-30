"""Read sessions and write inbox messages in the bridge queue, locally or through ssh."""

from __future__ import annotations

import json
import os
import shlex
import stat
import subprocess
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .events import is_utc_time, is_uuid, is_uuid4

STALE_SECONDS = 600
SSH_TIMEOUT_SECONDS = 30
_FILE_MARK = "@@omp-bridge-file@@"


class QueueError(Exception):
    """The queue could not be read or written; the message is safe to show the model."""


@dataclass(frozen=True)
class Host:
    host_id: str
    ssh_target: str = ""
    root: str = ""
    ssh_command: str = "ssh"


def _parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value[:-1] + "+00:00")


def utc_now_text(now: float) -> str:
    return datetime.fromtimestamp(int(now), UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def check_session(raw: Any, host: Host) -> dict[str, Any] | None:
    """Return the registration when it is usable, else None (corrupt files are ignored)."""
    if not isinstance(raw, dict):
        return None
    pid = raw.get("pid")
    ok = (
        raw.get("schema_version") == 1
        and is_uuid(raw.get("session_id"))
        and isinstance(raw.get("cwd"), str)
        and raw.get("state") in ("idle", "working", "ended")
        and is_utc_time(raw.get("updated_at"))
        and (pid is None or (isinstance(pid, int) and not isinstance(pid, bool) and pid >= 1))
    )
    if not ok:
        return None
    return {**raw, "host_id": host.host_id}


def mark_stale(session: dict[str, Any], alive: bool | None, now: float) -> dict[str, Any]:
    """stale = no pid, pid not running, or updated_at older than 10 minutes."""
    age = now - _parse_time(session["updated_at"]).timestamp()
    pid = session.get("pid")
    stale = pid is None or alive is False or age > STALE_SECONDS
    return {**session, "stale": stale, "pid_checked": alive is not None}


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def new_inbox_message(
    msg_id: str, kind: str, text: str, now: float, reply_to: str | None = None
) -> dict[str, Any]:
    message: dict[str, Any] = {
        "schema_version": 1,
        "msg_id": msg_id,
        "kind": kind,
        "text": text,
        "created_at": utc_now_text(now),
    }
    if reply_to is not None:
        message["reply_to"] = reply_to
    return message


# ---------------------------------------------------------------- local


class LocalQueue:
    def __init__(self, host: Host) -> None:
        self.host = host
        self.root = Path(host.root).expanduser()

    def _check_root(self) -> None:
        try:
            info = self.root.lstat()
        except FileNotFoundError:
            raise QueueError(
                f"queue root {self.host.root} does not exist on host {self.host.host_id}"
            ) from None
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise QueueError("the queue root is a symbolic link or not a directory")

    def _dir(self, *parts: str, create: bool = False) -> Path:
        """Walk below root, refusing symbolic links. Parents are created 0700 when asked."""
        self._check_root()
        path = self.root
        for part in parts:
            path = path / part
            try:
                info = path.lstat()
            except FileNotFoundError:
                if not create:
                    raise QueueError(f"{part} is missing in the queue") from None
                path.mkdir(mode=0o700)
                path.chmod(0o700)
                continue
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
                raise QueueError(f"{part} in the queue is a symbolic link or not a directory")
        return path

    def read_sessions(self, now: float) -> list[dict[str, Any]]:
        self._check_root()
        try:
            directory = self._dir("sessions")
        except QueueError:
            return []
        found = []
        for entry in sorted(directory.glob("*.json")):
            session = self._read_session_file(entry)
            if session is not None:
                alive = _pid_alive(session["pid"]) if session.get("pid") else False
                found.append(mark_stale(session, alive, now))
        return found

    def _read_session_file(self, path: Path) -> dict[str, Any] | None:
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(fd, encoding="utf-8") as handle:
                return check_session(json.load(handle), self.host)
        except (OSError, ValueError):
            return None

    def write_inbox(self, session_id: str, message: dict[str, Any]) -> None:
        target = self._dir("inbox", session_id, create=True)
        final = target / f"{message['msg_id']}.json"
        tmp = target / f"{message['msg_id']}.json.tmp"
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
        try:
            with os.fdopen(os.open(tmp, flags, 0o600), "w", encoding="utf-8") as handle:
                json.dump(message, handle, ensure_ascii=False)
                handle.flush()
                os.fsync(handle.fileno())
            os.rename(tmp, final)
        except OSError as exc:
            tmp.unlink(missing_ok=True)
            raise QueueError(f"cannot write the inbox message: {exc.strerror}") from exc


# ---------------------------------------------------------------- ssh


def _remote_root(root: str) -> str:
    """Shell word for root; only a leading ~/ is expanded, by the remote shell.

    Trailing slashes are dropped: `[ -L link/ ]` follows the link, so the root test would pass."""
    root = root.rstrip("/") or root[:1]
    if root == "~":
        return '"$HOME"'
    if root.startswith("~/"):
        return '"$HOME"/' + shlex.quote(root[2:])
    return shlex.quote(root)


_READ_SCRIPT = """\
root={root}
[ ! -L "$root" ] || exit 4
[ -d "$root" ] || exit 3
[ -d "$root/sessions" ] && [ ! -L "$root/sessions" ] || exit 0
for f in "$root"/sessions/*.json; do
  [ -f "$f" ] && [ ! -L "$f" ] || continue
  echo '{mark}'
  cat "$f"
  echo
done
"""

# set -C makes `>` fail when the temp file exists, so a writer never overwrites another's file.
_WRITE_SCRIPT = """\
set -eu
umask 077
root={root}
[ ! -L "$root" ] || exit 4
[ -d "$root" ] || exit 3
d="$root/inbox"
for p in "$d" "$d/{sid}"; do
  [ ! -L "$p" ] || exit 4
  [ -d "$p" ] || mkdir -m 700 "$p"
  [ -d "$p" ] || exit 4
  d=$p
done
tmp="$d/{msg}.json.tmp"
set -C
trap 'rm -f "$tmp"' EXIT
cat > "$tmp"
mv "$tmp" "$d/{msg}.json"
trap - EXIT
"""


class SshQueue:
    def __init__(self, host: Host) -> None:
        self.host = host

    def _run(self, script: str, stdin: str = "") -> str:
        argv = [
            *shlex.split(self.host.ssh_command),
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=10",
            "--",
            self.host.ssh_target,
            script,
        ]
        try:
            done = subprocess.run(
                argv,
                input=stdin,
                capture_output=True,
                text=True,
                timeout=SSH_TIMEOUT_SECONDS,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise QueueError(
                f"ssh to host {self.host.host_id} failed: {type(exc).__name__}"
            ) from exc
        if done.returncode == 3:
            raise QueueError(f"queue root {self.host.root} does not exist on {self.host.host_id}")
        if done.returncode == 4:
            raise QueueError(
                "a symbolic link or file blocks the queue path or root on the remote host"
            )
        if done.returncode != 0:
            raise QueueError(f"ssh to host {self.host.host_id} exited with {done.returncode}")
        return done.stdout

    def read_sessions(self, now: float) -> list[dict[str, Any]]:
        out = self._run(_READ_SCRIPT.format(root=_remote_root(self.host.root), mark=_FILE_MARK))
        sessions = []
        for chunk in out.split(_FILE_MARK + "\n")[1:]:
            try:
                session = check_session(json.loads(chunk), self.host)
            except ValueError:
                continue
            if session is not None:
                sessions.append(session)
        alive = self._alive_pids([s["pid"] for s in sessions if s.get("pid")])
        return [
            mark_stale(s, None if alive is None else s.get("pid") in alive, now) for s in sessions
        ]

    def _alive_pids(self, pids: list[int]) -> set[int] | None:
        """Pids running on the remote host, or None when that cannot be asked."""
        if not pids:
            return set()
        listed = " ".join(str(int(p)) for p in pids)
        try:
            out = self._run(f"for p in {listed}; do kill -0 $p 2>/dev/null && echo $p; done; true")
        except QueueError:
            return None
        return {int(line) for line in out.split() if line.isdigit()}

    def write_inbox(self, session_id: str, message: dict[str, Any]) -> None:
        # Both ids go into a shell script, so only well-formed UUIDs may reach it.
        if not (is_uuid(session_id) and is_uuid4(message["msg_id"])):
            raise QueueError("session_id or msg_id is not a UUID")
        script = _WRITE_SCRIPT.format(
            root=_remote_root(self.host.root), sid=session_id, msg=message["msg_id"]
        )
        self._run(script, json.dumps(message, ensure_ascii=False))


def open_queue(host: Host) -> LocalQueue | SshQueue:
    return SshQueue(host) if host.ssh_target else LocalQueue(host)
