"""Contract schemas accept every example and reject known-bad messages."""

import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator, FormatChecker

CONTRACT = Path(__file__).resolve().parent.parent / "contract"
SCHEMA_OF = {
    "session.json": "session",
    "inbox-prompt.json": "inbox-message",
    "inbox-answer.json": "inbox-message",
    "done-delivered.json": "done-message",
    "done-dropped-late.json": "done-message",
}
SESSION = "019a2f00-0000-7000-8000-000000000001"
ID4 = "3f1c2a4e-8b7d-4c1a-9e2f-0a1b2c3d4e5f"
AT = "2026-10-30T05:10:00Z"


def validator(name: str) -> Draft202012Validator:
    schema = json.loads((CONTRACT / "schema" / f"{name}.schema.json").read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema, format_checker=FormatChecker())


def event(**extra):
    base = {
        "schema_version": 1,
        "event_id": ID4,
        "kind": "ended",
        "host_id": "h",
        "session_id": SESSION,
        "cwd": "/",
        "at": AT,
    }
    return {**base, **extra}


def inbox(**extra):
    base = {"schema_version": 1, "msg_id": ID4, "kind": "prompt", "text": "x", "created_at": AT}
    return {**base, **extra}


@pytest.mark.parametrize(
    "path", sorted((CONTRACT / "examples").glob("*.json")), ids=lambda p: p.name
)
def test_example_is_valid(path):
    name = SCHEMA_OF.get(path.name, "event")
    errors = list(validator(name).iter_errors(json.loads(path.read_text(encoding="utf-8"))))
    assert errors == []


BAD = [
    ("event", event(reason="x")),
    ("event", event(kind="asked")),
    ("event", event(session_id="../../outside")),
    ("event", event(at="2026-99-99T25:61:61Z")),
    ("event", event(summary="x" * 4001)),
    ("inbox-message", inbox(kind="answer")),
    ("inbox-message", inbox(reply_to=ID4)),
    ("inbox-message", inbox(created_at="2026-10-30T05:10:00+09:00")),
    ("inbox-message", inbox(delivered_at=AT)),
    ("done-message", inbox()),
    ("done-message", inbox(delivered_at=AT, dropped="late", dropped_at=AT)),
    ("done-message", inbox(dropped="late", dropped_at=AT)),
]


@pytest.mark.parametrize(("name", "message"), BAD)
def test_bad_message_is_rejected(name, message):
    assert list(validator(name).iter_errors(message)) != []
