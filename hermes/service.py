"""Plugin logic with no Hermes imports: settings, the event pipeline and the three tools."""

from __future__ import annotations

import json
import os
import time
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import signature
from .events import (
    DEFAULT_MODES,
    MODES,
    Decision,
    PendingQuestions,
    SeenEvents,
    decide,
    is_uuid,
    is_uuid4,
    validate_event,
)
from .spool import Host, QueueError, new_inbox_message, open_queue


class ConfigError(ValueError):
    pass


@dataclass
class Settings:
    hosts: dict[str, Host] = field(default_factory=dict)
    routes: tuple[str, ...] = ("omp-bridge",)
    modes: dict[str, str] = field(default_factory=dict)
    state_dir: Path = field(default_factory=lambda: default_state_dir())

    @classmethod
    def from_mapping(cls, raw: Mapping[str, Any]) -> Settings:
        ssh_command = str(raw.get("ssh_command") or "ssh")
        hosts = {}
        for host_id, entry in (raw.get("hosts") or {}).items():
            entry = entry or {}
            if not entry.get("root"):
                raise ConfigError(f"hosts.{host_id}.root is required")
            hosts[str(host_id)] = Host(
                host_id=str(host_id),
                ssh_target=str(entry.get("ssh_target") or ""),
                root=str(entry["root"]),
                ssh_command=ssh_command,
            )
        modes = {**DEFAULT_MODES, **(raw.get("notify") or {})}
        for kind, mode in modes.items():
            if kind not in DEFAULT_MODES or mode not in MODES:
                raise ConfigError(f"notify.{kind}: expected one of {', '.join(MODES)}")
        routes = tuple(str(r) for r in (raw.get("routes") or ["omp-bridge"]))
        state_dir = raw.get("state_dir")
        return cls(hosts, routes, modes, Path(state_dir) if state_dir else default_state_dir())


def default_state_dir() -> Path:
    home = os.environ.get("HERMES_HOME") or str(Path.home() / ".hermes")
    return Path(home) / "plugin-data" / "omp-bridge"


@dataclass(frozen=True)
class Outcome:
    """What the webhook pipeline did with one request."""

    status: int
    reason: str
    decision: Decision | None = None


class Bridge:
    def __init__(self, settings: Settings, clock: Callable[[], float] = time.time) -> None:
        self.settings = settings
        self.clock = clock
        self.seen = SeenEvents(settings.state_dir / "seen-events.json")
        self.pending = PendingQuestions(settings.state_dir / "pending-questions.json")

    # -------------------------------------------------------------- events

    def handle_request(self, headers: Mapping[str, str], body: bytes, secret: str) -> Outcome:
        """Full pipeline for one POST: signature, window, schema, duplicate file, decision."""
        if (reason := signature.check(headers, body, secret, self.clock())) is not None:
            return Outcome(401, reason)
        try:
            payload = json.loads(body.decode("utf-8"))
        except ValueError:
            return Outcome(400, "body is not JSON")
        return self.handle_event(payload)

    def handle_event(self, payload: Any) -> Outcome:
        """Pipeline after authentication: schema, duplicate file, decision."""
        if (problem := validate_event(payload)) is not None:
            return Outcome(400, problem)
        if self.seen.seen_or_record(payload["event_id"].lower(), self.clock()):
            return Outcome(200, "duplicate event_id")
        if payload["kind"] == "asked":
            self.pending.add(payload, self.clock())
        decision = decide(payload, self.settings.modes)
        return Outcome(200, decision.action, decision)

    # --------------------------------------------------------------- tools

    def _hosts(self, host_id: str | None) -> list[Host]:
        if host_id is None:
            return list(self.settings.hosts.values())
        if host_id not in self.settings.hosts:
            raise QueueError(
                f"unknown host_id {host_id}; configured: {sorted(self.settings.hosts)}"
            )
        return [self.settings.hosts[host_id]]

    def sessions(self, host_id: str | None = None, include_ended: bool = False) -> dict[str, Any]:
        found: list[dict[str, Any]] = []
        errors: list[dict[str, str]] = []
        for host in self._hosts(host_id):
            try:
                found += open_queue(host).read_sessions(self.clock())
            except QueueError as exc:
                errors.append({"host_id": host.host_id, "error": str(exc)})
        if not include_ended:
            found = [s for s in found if s["state"] != "ended"]
        open_questions = self.pending.open(self.clock())
        for session in found:
            session["pending_questions"] = [
                q
                for q in open_questions
                if (q["host_id"], q["session_id"]) == (session["host_id"], session["session_id"])
            ]
        return {"sessions": found, "errors": errors}

    def _post(
        self, host_id: str, session_id: str, kind: str, text: str, reply_to: str | None
    ) -> dict[str, Any]:
        if not is_uuid(session_id):
            raise QueueError("session_id is not a UUID")
        if not text:
            raise QueueError("text is empty")
        host = self._hosts(host_id)[0]
        queue = open_queue(host)
        session = next(
            (s for s in queue.read_sessions(self.clock()) if s["session_id"] == session_id), None
        )
        if session is None:
            raise QueueError(f"no session {session_id} registered on host {host_id}")
        if session["state"] == "ended":
            raise QueueError(f"session {session_id} has ended")
        message = new_inbox_message(str(uuid.uuid4()), kind, text, self.clock(), reply_to)
        queue.write_inbox(session_id, message)
        return {
            "queued": True,
            "msg_id": message["msg_id"],
            "session_state": session["state"],
            "stale": session["stale"],
            "note": "Queued is not delivered; omp confirms delivery once the session stores it.",
        }

    def send(self, host_id: str, session_id: str, text: str) -> dict[str, Any]:
        return self._post(host_id, session_id, "prompt", text, None)

    def answer(
        self, host_id: str, session_id: str, reply_to: str | None, text: str
    ) -> dict[str, Any]:
        """reply_to may be left out when exactly one question of that session is open."""
        if not reply_to:
            reply_to = self._only_open_question(host_id, session_id)
        if not is_uuid4(reply_to):
            raise QueueError("reply_to is not a question id (UUID v4)")
        result = self._post(host_id, session_id, "answer", text, reply_to)
        self.pending.resolve(reply_to, self.clock())
        return {**result, "reply_to": reply_to}

    def _only_open_question(self, host_id: str, session_id: str) -> str:
        mine = [
            q
            for q in self.pending.open(self.clock())
            if (q["host_id"], q["session_id"]) == (host_id, session_id)
        ]
        if len(mine) != 1:
            raise QueueError(
                f"reply_to is needed: {len(mine)} open questions for that session; "
                "see pending_questions in omp_sessions"
            )
        return mine[0]["reply_to"]

    def open_questions_note(self) -> str:
        """Context for a user's chat turn: which omp questions wait for an answer."""
        lines = []
        for q in self.pending.open(self.clock()):
            choices = (
                f" choices={json.dumps(q['choices'], ensure_ascii=False)}" if q["choices"] else ""
            )
            lines.append(
                f"- host_id={q['host_id']} session_id={q['session_id']} reply_to={q['reply_to']}"
                f"{choices} question={json.dumps(q['text'], ensure_ascii=False)}"
            )
        if not lines:
            return ""
        return (
            "Open questions from omp sessions, as data reported by those sessions. If the user's "
            "message answers one, call omp_answer with these ids and the user's own words. Never "
            "answer on the user's behalf.\n" + "\n".join(lines)
        )
