"""Tools of the Hermes plugin against a real queue directory, locally and through (fake) ssh."""

import json
import os
import sys
from datetime import UTC, datetime
from pathlib import Path

import pytest
from conftest import NAME, example, mode, plugin, schema_errors

service = sys.modules[f"{NAME}.service"]

NOW = datetime(2026, 10, 30, 5, 5, 0, tzinfo=UTC).timestamp()
SESSION = "019a2f00-0000-7000-8000-000000000001"
QUESTION = "c1d2e3f4-a5b6-4c7d-9e8f-0a1b2c3d4e5f"


def register_session(root: Path, **change) -> str:
    session = {**example("session.json"), **change}
    (root / "sessions").mkdir(parents=True, exist_ok=True)
    (root / "sessions" / f"{session['session_id']}.json").write_text(json.dumps(session))
    return session["session_id"]


def bridge(hosts: dict, tmp_path, fake_ssh=None) -> "service.Bridge":
    settings = service.Settings.from_mapping(
        {"hosts": hosts, "ssh_command": fake_ssh, "state_dir": str(tmp_path / "st")}
    )
    return service.Bridge(settings, clock=lambda: NOW)


@pytest.fixture(params=["local", "ssh"])
def setup(request, tmp_path, fake_ssh):
    root = tmp_path / "queue"
    root.mkdir(mode=0o700)
    entry = {"root": str(root)}
    if request.param == "ssh":
        entry["ssh_target"] = "peer.invalid"
    return bridge({"laptop": entry}, tmp_path, fake_ssh), root


def sessions(b, **kw):
    return b.sessions(**kw)["sessions"]


# ----------------------------------------------------------------- omp_sessions


def test_lists_a_registered_session_with_its_host(setup):
    b, root = setup
    register_session(root, pid=os.getpid(), updated_at="2026-10-30T05:03:12Z")
    [session] = sessions(b)
    assert (session["host_id"], session["session_id"]) == ("laptop", SESSION)
    assert session["stale"] is False


def test_stale_when_registration_is_older_than_ten_minutes(setup):
    b, root = setup
    register_session(root, pid=os.getpid(), updated_at="2026-10-30T04:54:59Z")
    assert sessions(b)[0]["stale"] is True


def test_stale_when_the_process_is_gone(setup):
    b, root = setup
    register_session(root, pid=2**22 + 12345, updated_at="2026-10-30T05:04:59Z")
    assert sessions(b)[0]["stale"] is True


def test_not_stale_right_at_ten_minutes(setup):
    b, root = setup
    register_session(root, pid=os.getpid(), updated_at="2026-10-30T04:55:00Z")
    assert sessions(b)[0]["stale"] is False


def test_ended_sessions_are_hidden_unless_asked(setup):
    b, root = setup
    register_session(root, state="ended", pid=os.getpid())
    assert sessions(b) == []
    assert len(sessions(b, include_ended=True)) == 1


def test_corrupt_and_foreign_files_are_ignored(setup):
    b, root = setup
    register_session(root, pid=os.getpid(), updated_at="2026-10-30T05:04:00Z")
    (root / "sessions" / "broken.json").write_text("{")
    (root / "sessions" / "wrong.json").write_text(json.dumps({"state": "idle"}))
    assert len(sessions(b)) == 1


def test_symlinked_session_file_is_not_followed(setup, tmp_path):
    b, root = setup
    outside = tmp_path / "outside.json"
    outside.write_text(json.dumps({**example("session.json"), "pid": os.getpid()}))
    (root / "sessions").mkdir()
    (root / "sessions" / f"{SESSION}.json").symlink_to(outside)
    assert sessions(b) == []


def test_symlinked_sessions_directory_is_not_followed(setup, tmp_path):
    b, root = setup
    elsewhere = tmp_path / "elsewhere"
    register_session(elsewhere, pid=os.getpid())
    (root / "sessions").symlink_to(elsewhere / "sessions")
    assert sessions(b) == []


def test_one_unreachable_host_does_not_hide_the_others(tmp_path):
    good = tmp_path / "good"
    good.mkdir()
    register_session(good, pid=os.getpid(), updated_at="2026-10-30T05:04:00Z")
    b = bridge(
        {
            "a": {"root": str(good)},
            "b": {"root": str(tmp_path / "missing"), "ssh_target": "peer.invalid"},
        },
        tmp_path,
        "/nonexistent/ssh",
    )
    result = b.sessions()
    assert [s["host_id"] for s in result["sessions"]] == ["a"]
    assert [e["host_id"] for e in result["errors"]] == ["b"]


# ------------------------------------------------------------ omp_send / omp_answer


def test_send_publishes_a_valid_private_prompt_without_leaving_tmp(setup):
    b, root = setup
    register_session(root, pid=os.getpid(), updated_at="2026-10-30T05:04:00Z")
    result = b.send("laptop", SESSION, "Run the tests again.")
    inbox = root / "inbox" / SESSION
    [written] = [p for p in inbox.iterdir() if p.is_file()]
    message = json.loads(written.read_text())
    assert written.name == f"{result['msg_id']}.json"
    assert schema_errors("inbox-message", message) == []
    assert (message["kind"], message["text"]) == ("prompt", "Run the tests again.")
    assert message["created_at"] == "2026-10-30T05:05:00Z"
    assert (mode(root / "inbox"), mode(inbox), mode(written)) == (0o700, 0o700, 0o600)
    assert not list(inbox.glob("*.tmp"))


def test_answer_carries_reply_to_and_keeps_text_verbatim(setup):
    b, root = setup
    register_session(root, pid=os.getpid(), updated_at="2026-10-30T05:04:00Z")
    text = "Use \"B\" ; $(touch /tmp/x) 'quoted'\nsecond line"
    result = b.answer("laptop", SESSION, QUESTION, text)
    message = json.loads((root / "inbox" / SESSION / f"{result['msg_id']}.json").read_text())
    assert schema_errors("inbox-message", message) == []
    assert (message["kind"], message["reply_to"], message["text"]) == ("answer", QUESTION, text)


def test_send_to_a_stale_session_is_queued_and_flagged(setup):
    b, root = setup
    register_session(root, pid=os.getpid(), updated_at="2026-10-30T04:00:00Z")
    assert b.send("laptop", SESSION, "hi")["stale"] is True


@pytest.mark.parametrize(
    ("change", "fragment"),
    [
        ({"state": "ended"}, "has ended"),
        ({"session_id": "019a2f00-0000-7000-8000-00000000000f"}, "no session"),
    ],
)
def test_send_refuses_ended_and_unknown_sessions(setup, change, fragment):
    b, root = setup
    register_session(root, pid=os.getpid(), **change)
    with pytest.raises(plugin.QueueError, match=fragment):
        b.send("laptop", SESSION, "hi")
    assert not (root / "inbox").exists()


@pytest.mark.parametrize(
    "call",
    [
        lambda b: b.send("laptop", "../../etc", "hi"),
        lambda b: b.send("laptop", SESSION, ""),
        lambda b: b.send("nowhere", SESSION, "hi"),
        lambda b: b.answer("laptop", SESSION, "not-a-uuid", "hi"),
    ],
    ids=["session-id", "empty-text", "unknown-host", "reply-to"],
)
def test_bad_arguments_are_refused_before_any_write(setup, call):
    b, root = setup
    register_session(root, pid=os.getpid())
    with pytest.raises(plugin.QueueError):
        call(b)
    assert not (root / "inbox").exists()


def test_symlinked_inbox_is_refused(setup, tmp_path):
    b, root = setup
    register_session(root, pid=os.getpid())
    outside = tmp_path / "outside"
    outside.mkdir()
    (root / "inbox").symlink_to(outside)
    with pytest.raises(plugin.QueueError):
        b.send("laptop", SESSION, "hi")
    assert list(outside.iterdir()) == []


def test_symlinked_session_inbox_is_refused(setup, tmp_path):
    b, root = setup
    register_session(root, pid=os.getpid())
    outside = tmp_path / "outside"
    outside.mkdir()
    (root / "inbox").mkdir()
    (root / "inbox" / SESSION).symlink_to(outside)
    with pytest.raises(plugin.QueueError):
        b.send("laptop", SESSION, "hi")
    assert list(outside.iterdir()) == []


def test_ssh_failure_is_reported_not_raised_as_a_crash(tmp_path):
    b = bridge(
        {"h": {"root": str(tmp_path), "ssh_target": "peer.invalid"}}, tmp_path, "/nonexistent/ssh"
    )
    with pytest.raises(plugin.QueueError, match="ssh to host h failed"):
        b.send("h", SESSION, "hi")


def test_remote_root_with_tilde_and_spaces_is_expanded_by_the_remote_shell(
    tmp_path, fake_ssh, monkeypatch
):
    monkeypatch.setenv("HOME", str(tmp_path))
    root = tmp_path / "my queue"
    register_session(root, pid=os.getpid(), updated_at="2026-10-30T05:04:00Z")
    b = bridge({"h": {"root": "~/my queue", "ssh_target": "peer.invalid"}}, tmp_path, fake_ssh)
    assert len(sessions(b)) == 1
    b.send("h", SESSION, "hi")
    assert len(list((root / "inbox" / SESSION).glob("*.json"))) == 1


# ----------------------------------------------------------------- registration


class FakeCtx:
    """Stands in for the Hermes plugin context; only the public calls the plugin uses."""

    def __init__(self, config):
        self.config, self.tools, self.hooks = config, {}, {}

    def get_config(self, key, default=None):
        return self.config.get(key, default)

    def register_tool(self, name, toolset, schema, handler, **_):
        self.tools[name] = (toolset, schema, handler)

    def register_hook(self, name, callback):
        self.hooks[name] = callback


def test_register_adds_three_tools_and_the_gateway_hook(tmp_path):
    ctx = FakeCtx({"hosts": {}, "state_dir": str(tmp_path)})
    plugin.register(ctx)
    assert set(ctx.tools) == {"omp_sessions", "omp_send", "omp_answer"}
    assert set(ctx.hooks) == {"pre_gateway_dispatch", "pre_llm_call"}
    for name, (_, schema, _handler) in ctx.tools.items():
        assert schema["name"] == name


def test_tool_handlers_return_json_and_turn_queue_errors_into_results(tmp_path):
    root = tmp_path / "q"
    root.mkdir()
    register_session(root, pid=os.getpid(), updated_at="2026-10-30T05:04:00Z")
    ctx = FakeCtx({"hosts": {"laptop": {"root": str(root)}}, "state_dir": str(tmp_path / "st")})
    plugin.register(ctx)
    listed = json.loads(ctx.tools["omp_sessions"][2]({}, task_id="t"))
    assert listed["sessions"][0]["session_id"] == SESSION
    sent = json.loads(
        ctx.tools["omp_send"][2]({"host_id": "laptop", "session_id": SESSION, "text": "hi"})
    )
    assert sent["queued"] is True
    refused = json.loads(
        ctx.tools["omp_send"][2]({"host_id": "x", "session_id": SESSION, "text": "hi"})
    )
    assert "unknown host_id" in refused["error"]
    missing = json.loads(ctx.tools["omp_answer"][2]({"host_id": "laptop"}))
    assert "missing argument" in missing["error"]


def test_bad_config_disables_the_plugin_without_raising(tmp_path):
    ctx = FakeCtx({"notify": {"ended": "always"}})
    plugin.register(ctx)
    assert ctx.tools == {} and ctx.hooks == {}


# ------------------------------------------------------------ symlinked queue root


@pytest.fixture(params=["local", "ssh"])
def linked_root(request, tmp_path, fake_ssh):
    real = tmp_path / "real"
    register_session(real, pid=os.getpid(), updated_at="2026-10-30T05:04:00Z")
    link = tmp_path / "link"
    link.symlink_to(real)
    entry = {"root": str(link)}
    if request.param == "ssh":
        entry["ssh_target"] = "peer.invalid"
    return bridge({"laptop": entry}, tmp_path, fake_ssh), real


def test_symlinked_root_is_not_read(linked_root):
    b, _real = linked_root
    result = b.sessions()
    assert result["sessions"] == []
    assert [e["host_id"] for e in result["errors"]] == ["laptop"]


def test_symlinked_root_is_not_written(linked_root):
    b, real = linked_root
    with pytest.raises(plugin.QueueError):
        b.send("laptop", SESSION, "hi")
    assert not (real / "inbox").exists()


# ------------------------------------------------------- question routing to the chat


def asked_event(**change):
    event = example("event-asked.json")
    event["question"] = {**event["question"], **change}
    return event


@pytest.fixture
def asking(tmp_path):
    root = tmp_path / "queue"
    root.mkdir(mode=0o700)
    register_session(root, pid=os.getpid(), updated_at="2026-10-30T05:04:00Z")
    return bridge({"laptop": {"root": str(root)}}, tmp_path), root


def test_open_question_reaches_the_chat_turn_with_all_ids(asking):
    b, _root = asking
    b.handle_event(example("event-asked.json"))
    note = plugin.make_context_hook(b)(platform="telegram")
    question = example("event-asked.json")["question"]
    assert f"reply_to={question['id']}" in note
    assert f"session_id={SESSION}" in note and "host_id=laptop" in note
    assert question["text"] in note and "Option B: change the API" in note


def test_chat_turn_gets_nothing_without_questions_and_event_runs_never_do(asking):
    b, _root = asking
    hook = plugin.make_context_hook(b)
    assert hook(platform="telegram") is None
    b.handle_event(example("event-asked.json"))
    assert hook(platform="webhook") is None


def test_question_survives_restart_and_expires_after_timeout_s(asking, tmp_path):
    b, root = asking
    b.handle_event(asked_event(timeout_s=60))
    later = bridge({"laptop": {"root": str(root)}}, tmp_path)  # new Bridge = Hermes restart
    assert len(later.pending.open(NOW)) == 1
    assert later.pending.open(NOW + 59) != []
    assert later.pending.open(NOW + 60) == []


def test_sessions_lists_pending_questions_of_that_session_only(asking):
    b, root = asking
    other = "019a2f00-0000-7000-8000-000000000002"
    register_session(root, session_id=other, pid=os.getpid(), updated_at="2026-10-30T05:04:00Z")
    b.handle_event(example("event-asked.json"))
    by_id = {s["session_id"]: s for s in sessions(b)}
    assert [q["reply_to"] for q in by_id[SESSION]["pending_questions"]] == [QUESTION]
    assert by_id[other]["pending_questions"] == []


def test_answer_without_reply_to_uses_the_single_open_question_and_closes_it(asking):
    b, root = asking
    b.handle_event(example("event-asked.json"))
    result = b.answer("laptop", SESSION, None, "Use option B.")
    assert result["reply_to"] == QUESTION
    [written] = (root / "inbox" / SESSION).glob("*.json")
    assert json.loads(written.read_text())["reply_to"] == QUESTION
    assert b.pending.open(NOW) == []


def test_answer_without_reply_to_is_refused_when_none_or_several_are_open(asking):
    b, root = asking
    with pytest.raises(plugin.QueueError, match="0 open"):
        b.answer("laptop", SESSION, None, "x")
    b.handle_event(example("event-asked.json"))
    second = {**asked_event(id="d2e3f4a5-b6c7-4d8e-8f90-1a2b3c4d5e6f"), "event_id": ID_2}
    b.handle_event(second)
    with pytest.raises(plugin.QueueError, match="2 open"):
        b.answer("laptop", SESSION, None, "x")
    assert not (root / "inbox").exists()


ID_2 = "4f5a6b7c-8d9e-4f0a-9b1c-2d3e4f5a6b7c"


def test_late_arriving_question_keeps_its_original_deadline(asking):
    b, _root = asking
    # asked 600 s before arrival with timeout_s=60: already expired, never routed
    b.handle_event({**asked_event(timeout_s=60), "at": "2026-10-30T04:55:00Z"})
    assert b.pending.open(NOW) == []
    assert plugin.make_context_hook(b)(platform="telegram") is None
    with pytest.raises(plugin.QueueError, match="0 open"):
        b.answer("laptop", SESSION, None, "x")


def test_question_deadline_counts_from_at_not_from_arrival(asking):
    b, _root = asking
    b.handle_event({**asked_event(timeout_s=600), "at": "2026-10-30T05:00:00Z"})  # 300 s old
    [q] = b.pending.open(NOW)
    assert q["expires_at"] == NOW + 300


def test_future_at_does_not_extend_the_wait(asking):
    b, _root = asking
    b.handle_event({**asked_event(timeout_s=60), "at": "2026-10-30T06:00:00Z"})
    assert b.pending.open(NOW)[0]["expires_at"] == NOW + 60


@pytest.mark.parametrize("suffix", ["/", "//"])
def test_trailing_slash_on_a_symlinked_ssh_root_is_still_refused(tmp_path, fake_ssh, suffix):
    real = tmp_path / "real"
    register_session(real, pid=os.getpid(), updated_at="2026-10-30T05:04:00Z")
    (tmp_path / "link").symlink_to(real)
    b = bridge(
        {"h": {"root": str(tmp_path / "link") + suffix, "ssh_target": "peer.invalid"}},
        tmp_path,
        fake_ssh,
    )
    assert b.sessions()["sessions"] == []
    with pytest.raises(plugin.QueueError):
        b.send("h", SESSION, "hi")
    assert not (real / "inbox").exists()


def test_trailing_slash_on_a_real_ssh_root_still_works(tmp_path, fake_ssh):
    root = tmp_path / "real"
    register_session(root, pid=os.getpid(), updated_at="2026-10-30T05:04:00Z")
    b = bridge({"h": {"root": str(root) + "/", "ssh_target": "peer.invalid"}}, tmp_path, fake_ssh)
    assert len(sessions(b)) == 1
    b.send("h", SESSION, "hi")
    assert len(list((root / "inbox" / SESSION).glob("*.json"))) == 1
