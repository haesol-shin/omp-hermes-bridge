"""omp-hermes-bridge Hermes plugin.

Bridge events in; omp_sessions, omp_send, omp_answer and bridge_watch out.

Uses only the public plugin API: register_tool, register_hook, get_config, inject_message.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from .service import Bridge, ConfigError, Settings
from .spool import QueueError
from .watchlist import WatchList, start_rearm_thread

logger = logging.getLogger(__name__)

_HOST = {"type": "string", "description": "host_id from the plugin config"}
_SESSION = {"type": "string", "description": "omp session_id (UUID) from omp_sessions"}

SCHEMAS = {
    "omp_sessions": {
        "name": "omp_sessions",
        "description": (
            "List running omp coding sessions on the configured hosts. A session marked "
            "stale has no live process or has not refreshed its registration for 10 minutes. "
            "pending_questions lists questions the session asked that still wait for an answer."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "host_id": {"type": "string", "description": "Only this host. Default: all."},
                "include_ended": {"type": "boolean", "description": "Also list ended sessions."},
            },
        },
    },
    "omp_send": {
        "name": "omp_send",
        "description": (
            "Queue a prompt for a running omp session. It starts a new turn when the session "
            "is idle and follows up when it is working. Queued is not delivered and not done."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "host_id": _HOST,
                "session_id": _SESSION,
                "text": {"type": "string", "description": "The prompt."},
            },
            "required": ["host_id", "session_id", "text"],
        },
    },
    "omp_answer": {
        "name": "omp_answer",
        "description": (
            "Queue the user's answer to a question an omp session asked (event kind asked). "
            "reply_to is the question id from that event; it may be left out when exactly one "
            "question of that session is open (see pending_questions in omp_sessions)."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "host_id": _HOST,
                "session_id": _SESSION,
                "reply_to": {"type": "string", "description": "question.id of the asked event"},
                "text": {"type": "string", "description": "The answer."},
            },
            "required": ["host_id", "session_id", "text"],
        },
    },
    "bridge_watch": {
        "name": "bridge_watch",
        "description": (
            "Record the background watchers of this room so a gateway restart can re-arm them. "
            "add: after you start a watcher (taskwatch watch or omp-bridge watch.py) give your "
            "session_key (agent:<profile>:<platform>:<chat type>:<chat id>[:<thread id>], the "
            "documented key of the chat you are in) and the exact command line; returns "
            "watch_id. remove: when the watch ended and its final state is handled. list: all "
            "records."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "action": {"enum": ["add", "remove", "list"]},
                "session_key": {"type": "string", "description": "add: this room's session key"},
                "command": {"type": "string", "description": "add: exact watcher command line"},
                "watch_id": {"type": "string", "description": "remove: id returned by add"},
            },
            "required": ["action"],
        },
    },
}


def _tool(call):
    """Tool handlers return JSON text; queue problems become an error result, not a crash."""

    def handler(params: dict[str, Any] | None = None, **_kwargs: Any) -> str:
        try:
            return json.dumps(call(params or {}), ensure_ascii=False)
        except QueueError as exc:
            return json.dumps({"error": str(exc)}, ensure_ascii=False)
        except KeyError as exc:
            return json.dumps({"error": f"missing argument {exc.args[0]}"})

    return handler


def bridge_watch(watches: WatchList, p: dict[str, Any]) -> dict[str, Any]:
    action = p.get("action")
    if action == "add":
        return {"watch_id": watches.add(p.get("session_key"), p.get("command"))}
    if action == "remove":
        return {"removed": watches.remove(str(p.get("watch_id") or ""))}
    if action == "list":
        return {"watches": watches.list()}
    raise QueueError("action must be add, remove or list")


def make_gateway_hook(bridge: Bridge):
    """pre_gateway_dispatch: act only on events of the configured webhook routes."""
    names = {f"webhook/{route}" for route in bridge.settings.routes}

    def hook(event, **_kwargs: Any):
        source = getattr(event, "source", None)
        if getattr(source, "chat_type", None) != "webhook" or source.chat_name not in names:
            return None
        outcome = bridge.handle_event(getattr(event, "raw_message", None))
        if outcome.decision is None or outcome.decision.action == "suppress":
            logger.info("omp-bridge: event dropped (%s)", outcome.reason)
            return {"action": "skip", "reason": f"omp-bridge: {outcome.reason}"}
        return {"action": "rewrite", "text": outcome.decision.prompt}

    return hook


def make_context_hook(bridge: Bridge):
    """pre_llm_call: tell the user's chat turn which omp questions are waiting for an answer.

    The announcement of a question runs in its own webhook session, so the session in which the
    user answers would otherwise not know host, session and question id."""

    def hook(platform: str = "", **_kwargs: Any):
        if platform == "webhook":
            return None
        try:
            return bridge.open_questions_note() or None
        except OSError:
            logger.warning("omp-bridge: pending questions unreadable", exc_info=True)
            return None

    return hook


def register(ctx) -> None:
    keys = ("hosts", "routes", "notify", "ssh_command", "state_dir")
    try:
        settings = Settings.from_mapping({k: ctx.get_config(k, default=None) for k in keys})
    except ConfigError as exc:
        logger.error("omp-bridge disabled: %s", exc)
        return
    bridge = Bridge(settings)
    tools = {
        "omp_sessions": _tool(
            lambda p: bridge.sessions(p.get("host_id"), bool(p.get("include_ended")))
        ),
        "omp_send": _tool(lambda p: bridge.send(p["host_id"], p["session_id"], p["text"])),
        "omp_answer": _tool(
            lambda p: bridge.answer(p["host_id"], p["session_id"], p.get("reply_to"), p["text"])
        ),
    }
    watches = WatchList(settings.state_dir / "watches.json")
    tools["bridge_watch"] = _tool(lambda p: bridge_watch(watches, p))
    for name, handler in tools.items():
        ctx.register_tool(name=name, toolset="omp_bridge", schema=SCHEMAS[name], handler=handler)
    ctx.register_hook("pre_gateway_dispatch", make_gateway_hook(bridge))
    ctx.register_hook("pre_llm_call", make_context_hook(bridge))
    allowed = ctx.get_config("allow_gateway_injection", default=None) is True
    start_rearm_thread(watches, ctx, allowed)
