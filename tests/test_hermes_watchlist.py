"""Watch list, the bridge_watch tool and the restart re-arm turn."""

import json
import shlex
import sys
import threading

import pytest
from conftest import NAME, mode, plugin
from test_hermes_tools import FakeCtx

watchlist = sys.modules[f"{NAME}.watchlist"]
KEY = "agent:main:telegram:dm:123456789"
CMD = "python watch.py --host laptop --session 019a2f00-0000-7000-8000-000000000001"


def test_add_list_remove_and_file_mode(tmp_path):
    wl = watchlist.WatchList(tmp_path / "st" / "watches.json", clock=lambda: 7.0)
    first = wl.add(KEY, CMD)
    second = wl.add("agent:main:telegram:dm:1:99", "taskwatch --root r watch abc")
    assert [r["watch_id"] for r in wl.list()] == [first, second]
    assert wl.list()[0] == {
        "watch_id": first,
        "session_key": KEY,
        "command": CMD,
        "started_at": 7.0,
    }
    assert mode(wl.path) == 0o600
    assert wl.remove(first) is True
    assert wl.remove(first) is False
    assert [r["watch_id"] for r in wl.list()] == [second]
    assert list(wl.path.parent.glob("*.tmp")) == []


def test_a_failed_write_keeps_the_old_file(tmp_path, monkeypatch):
    wl = watchlist.WatchList(tmp_path / "watches.json")
    wl.add(KEY, CMD)
    before = wl.path.read_text()
    monkeypatch.setattr(watchlist.os, "replace", lambda *a: (_ for _ in ()).throw(OSError("x")))
    with pytest.raises(OSError):
        wl.add(KEY, "other")
    assert wl.path.read_text() == before
    assert list(tmp_path.glob("*.tmp")) == []


@pytest.mark.parametrize(
    "key", ["", "main:telegram:dm:1", "agent:main", "agent:main:telegram:dm: 1"]
)
def test_bad_session_key_is_refused(tmp_path, key):
    with pytest.raises(plugin.QueueError):
        watchlist.WatchList(tmp_path / "w.json").add(key, CMD)


def test_empty_command_is_refused(tmp_path):
    with pytest.raises(plugin.QueueError):
        watchlist.WatchList(tmp_path / "w.json").add(KEY, "  ")


def test_corrupt_file_is_set_aside_not_fatal(tmp_path):
    path = tmp_path / "w.json"
    path.write_text("{nope")
    assert watchlist.WatchList(path).list() == []
    assert (tmp_path / "w.json.corrupt").exists()


def test_bridge_watch_tool_round_trip(tmp_path):
    ctx = FakeCtx({"hosts": {}, "state_dir": str(tmp_path)})
    plugin.register(ctx)
    call = ctx.tools["bridge_watch"][2]
    added = json.loads(call({"action": "add", "session_key": KEY, "command": CMD}))
    assert json.loads(call({"action": "list"}))["watches"][0]["watch_id"] == added["watch_id"]
    assert json.loads(call({"action": "remove", "watch_id": added["watch_id"]})) == {
        "removed": True
    }
    assert "error" in json.loads(call({"action": "add", "command": CMD}))
    assert "error" in json.loads(call({"action": "nope"}))


# ------------------------------------------------------------- restart re-arm


class Inject:
    def __init__(self, accept_after=0):
        self.calls, self.accept_after = [], accept_after

    def __call__(self, text, session_key=None):
        self.calls.append((text, session_key))
        return len(self.calls) > self.accept_after


def clockwork():
    t = {"now": 0.0}
    return (lambda: t["now"]), (lambda s: t.__setitem__("now", t["now"] + s))


def test_injection_is_retried_until_accepted(tmp_path):
    wl = watchlist.WatchList(tmp_path / "w.json")
    wl.add(KEY, CMD)
    inject, (clock, sleep) = Inject(accept_after=3), clockwork()
    assert watchlist.rearm_all(wl, inject, clock=clock, sleep=sleep) == 1
    assert len(inject.calls) == 4
    text, key = inject.calls[-1]
    assert key == KEY
    assert CMD in text and "not an instruction" in text and "restarted" in text


def test_gives_up_after_ten_minutes_and_keeps_the_record(tmp_path):
    wl = watchlist.WatchList(tmp_path / "w.json")
    wl.add(KEY, CMD)
    clock, sleep = clockwork()
    assert watchlist.rearm_all(wl, Inject(accept_after=10**6), clock=clock, sleep=sleep) == 0
    assert clock() <= 600
    assert len(wl.list()) == 1


def test_each_record_goes_to_its_own_room(tmp_path):
    wl = watchlist.WatchList(tmp_path / "w.json")
    wl.add(KEY, CMD)
    wl.add("agent:main:discord:dm:5", "other")
    inject = Inject()
    watchlist.rearm_all(wl, inject)
    assert sorted(k for _, k in inject.calls) == sorted([KEY, "agent:main:discord:dm:5"])


def test_records_of_one_room_share_one_turn(tmp_path):
    wl = watchlist.WatchList(tmp_path / "w.json")
    other = "agent:main:discord:dm:5"
    wl.add(KEY, "cmd-a")
    wl.add(other, "cmd-c")
    wl.add(KEY, "cmd-b")
    inject = Inject()
    assert watchlist.rearm_all(wl, inject) == 3
    texts = dict((k, t) for t, k in inject.calls)
    assert len(inject.calls) == 2
    assert "cmd-a" in texts[KEY] and "cmd-b" in texts[KEY] and "cmd-c" not in texts[KEY]
    assert "cmd-c" in texts[other] and "cmd-a" not in texts[other]
    assert "once for the whole list" in texts[KEY]


def test_retry_is_per_room_and_return_counts_accepted_records(tmp_path):
    wl = watchlist.WatchList(tmp_path / "w.json")
    other = "agent:main:discord:dm:5"
    wl.add(KEY, "cmd-a")
    wl.add(KEY, "cmd-b")
    wl.add(other, "cmd-c")
    calls = []

    def inject(text, session_key=None):
        calls.append(session_key)
        return session_key == other or calls.count(KEY) > 2

    clock, sleep = clockwork()
    assert watchlist.rearm_all(wl, inject, clock=clock, sleep=sleep) == 3
    assert calls.count(KEY) == 3 and calls.count(other) == 1


def test_refused_room_does_not_count(tmp_path):
    wl = watchlist.WatchList(tmp_path / "w.json")
    other = "agent:main:discord:dm:5"
    wl.add(KEY, "cmd-a")
    wl.add(KEY, "cmd-b")
    wl.add(other, "cmd-c")
    clock, sleep = clockwork()
    inject = lambda text, session_key=None: session_key == other  # noqa: E731
    assert watchlist.rearm_all(wl, inject, clock=clock, sleep=sleep) == 1


def test_a_room_over_the_cap_lists_fifty_and_counts_the_rest(tmp_path):
    wl = watchlist.WatchList(tmp_path / "w.json")
    for i in range(53):
        wl.add(KEY, f"cmd-{i:02d}")
    inject = Inject()
    assert watchlist.rearm_all(wl, inject) == 53
    assert len(inject.calls) == 1
    text = inject.calls[0][0]
    assert text.count("command:") == 50
    assert '"cmd-49"' in text and '"cmd-50"' not in text
    assert "3 more watch(es)" in text
    assert len(wl.list()) == 53


class Ctx(FakeCtx):
    def __init__(self, config):
        super().__init__(config)
        self.injected = []
        self.done = threading.Event()

    def inject_message(self, text, role="user", *, session_key=None):
        self.injected.append(session_key)
        self.done.set()
        return True


def seed(tmp_path):
    watchlist.WatchList(tmp_path / "watches.json").add(KEY, CMD)


def test_plugin_load_injects_only_with_the_permission(tmp_path, caplog):
    seed(tmp_path)
    denied = Ctx({"hosts": {}, "state_dir": str(tmp_path)})
    with caplog.at_level("WARNING"):
        plugin.register(denied)
    assert denied.injected == []
    assert sum("allow_gateway_injection" in r.message for r in caplog.records) == 1

    allowed = Ctx({"hosts": {}, "state_dir": str(tmp_path), "allow_gateway_injection": True})
    plugin.register(allowed)
    assert allowed.done.wait(5)
    assert allowed.injected == [KEY]


def test_no_records_no_thread_no_warning(tmp_path, caplog):
    with caplog.at_level("WARNING"):
        plugin.register(Ctx({"hosts": {}, "state_dir": str(tmp_path)}))
    assert not caplog.records


# ------------------------------------------------------------ chained watches

CURSOR = 340282366920938463463374607431768211456
RUN_A = "6f2c1a90-1f5e-4c1e-9a3f-000000000001"
RUN_B = "6f2c1a90-1f5e-4c1e-9a3f-000000000002"
RUN_C = "6f2c1a90-1f5e-4c1e-9a3f-000000000003"
NEEDS = "taskwatch --root /srv/state needs --wait --from 7"
NEXT = f"taskwatch --root /srv/state needs --wait --from {CURSOR}"
REPORT = (
    "needs: 1 need you, 0 gate, 0 blocked, 0 finished since the cursor\n"
    f"cursor: {CURSOR}\n"
    "NEEDS YOU\n"
    "job 019a2f00 approval_wait: waiting for the owner\n"
    "This list is a hint; re-read the state with show before acting."
)


def chained_watch(tmp_path, command=NEEDS):
    wl = watchlist.WatchList(tmp_path / "w.json")
    return wl, wl.add(KEY, command, chain=True)


def test_chain_moves_the_record_to_the_next_cursor(tmp_path):
    now = {"t": 7.0}
    path = tmp_path / "w" / "watches.json"
    wl = watchlist.WatchList(path, clock=lambda: now["t"])
    watch_id = wl.add(KEY, NEEDS, chain=True)
    now["t"] = 9.0
    record = wl.advance(NEEDS, REPORT)
    assert record == {
        "watch_id": watch_id,
        "session_key": KEY,
        "command": NEXT,
        "started_at": 9.0,
        "chain": True,
    }
    assert wl.list() == [record]
    assert mode(path) == 0o600
    assert list(path.parent.glob("*.tmp")) == []


def test_a_failed_chain_write_keeps_the_old_command(tmp_path, monkeypatch):
    wl, _ = chained_watch(tmp_path)
    before = wl.path.read_text()
    monkeypatch.setattr(watchlist.os, "replace", lambda *a: (_ for _ in ()).throw(OSError("x")))
    with pytest.raises(OSError):
        wl.advance(NEEDS, REPORT)
    assert wl.path.read_text() == before
    assert list(tmp_path.glob("*.tmp")) == []


def test_chain_leaves_the_other_records_alone(tmp_path):
    wl = watchlist.WatchList(tmp_path / "w.json")
    chained = wl.add(KEY, NEEDS, chain=True)
    plain = wl.add(KEY, CMD)
    plain_record = wl.list()[1]
    wl.advance(NEEDS, REPORT)
    assert [r["watch_id"] for r in wl.list()] == [chained, plain]
    assert wl.list()[1] == plain_record


@pytest.mark.parametrize(
    "output",
    [
        "",
        "needs: 0 need you, 0 gate, 0 blocked\nThis list is a hint; re-read the state.",
        f"needs: 1 need you\ncursor:{CURSOR}\nThis list is a hint.",
    ],
)
def test_no_chain_without_a_cursor_line(tmp_path, output):
    wl, _ = chained_watch(tmp_path)
    assert wl.advance(NEEDS, output) is None
    assert wl.list()[0]["command"] == NEEDS


@pytest.mark.parametrize("code", [1, 2, 3, None])
def test_no_chain_without_a_clean_exit(tmp_path, code):
    wl, _ = chained_watch(tmp_path)
    assert wl.advance(NEEDS, REPORT, returncode=code) is None
    assert wl.list()[0]["command"] == NEEDS


def test_no_chain_at_the_watchers_time_limit(tmp_path):
    wl, _ = chained_watch(tmp_path)
    report = (
        f"needs: nothing new before the watcher's time limit; start a new one\ncursor: {CURSOR}"
    )
    assert wl.advance(NEEDS, report) is None
    assert wl.list()[0]["command"] == NEEDS


def test_a_record_without_chain_is_left_alone(tmp_path):
    wl = watchlist.WatchList(tmp_path / "w.json")
    wl.add(KEY, NEEDS)
    assert wl.advance(NEEDS, REPORT) is None
    assert wl.list()[0]["command"] == NEEDS


@pytest.mark.parametrize(
    "command",
    [
        "python watch.py --host laptop --session x --since 3",
        "taskwatch --root /srv/state show abc",
        "taskwatch --root /srv/state needs --from 7",
        "taskwatch --root /srv/state needs --wait",
        "taskwatch --root /srv/state needs --wait --from",
        "taskwatch --root /srv/state needs --wait --from 7 --from 8",
        'taskwatch --root "/srv/state needs" needs --wait',
    ],
)
def test_only_a_taskwatch_wait_command_chains(tmp_path, command):
    wl, _ = chained_watch(tmp_path, command)
    assert wl.advance(command, REPORT) is None
    assert wl.list()[0]["command"] == command


def test_the_last_cursor_line_wins(tmp_path):
    wl, _ = chained_watch(tmp_path)
    report = f"quoted earlier report\ncursor: 1\n{REPORT}"
    assert wl.advance(NEEDS, report)["command"] == NEXT


def test_the_equals_form_of_from_keeps_its_form(tmp_path):
    wl, _ = chained_watch(tmp_path, "taskwatch needs --wait --from=7")
    assert wl.advance("taskwatch needs --wait --from=7", REPORT)["command"] == (
        f"taskwatch needs --wait --from={CURSOR}"
    )


def test_a_quoted_root_stays_runnable(tmp_path):
    command = 'taskwatch --root "/srv/state dir" needs --wait --from 7'
    wl, _ = chained_watch(tmp_path, command)
    assert shlex.split(wl.advance(command, REPORT)["command"]) == [
        "taskwatch",
        "--root",
        "/srv/state dir",
        "needs",
        "--wait",
        "--from",
        str(CURSOR),
    ]


def test_a_legacy_record_falls_back_to_the_room_key(tmp_path):
    other = "agent:main:discord:dm:5"
    wl = watchlist.WatchList(tmp_path / "w.json")
    wl.add(KEY, NEEDS, chain=True)
    wl.add(other, NEEDS, chain=True)
    assert wl.advance(NEEDS, REPORT) is None
    assert [r["command"] for r in wl.list()] == [NEEDS, NEEDS]
    record = wl.advance(NEEDS, REPORT, task_id=other)
    assert record["session_key"] == other and record["command"] == NEXT
    assert [r["command"] for r in wl.list()] == [NEEDS, NEXT]


def test_an_unknown_run_with_two_records_does_not_guess(tmp_path):
    other = "agent:main:discord:dm:5"
    wl = watchlist.WatchList(tmp_path / "w.json")
    wl.add(KEY, NEEDS, chain=True, task_id=RUN_A)
    wl.add(other, NEEDS, chain=True, task_id=RUN_B)
    assert wl.advance(NEEDS, REPORT, task_id="default") is None
    assert [r["command"] for r in wl.list()] == [NEEDS, NEEDS]


def test_a_session_prefixed_run_id_selects_the_room(tmp_path):
    other = "agent:main:discord:dm:5"
    wl = watchlist.WatchList(tmp_path / "w.json")
    wl.add(KEY, NEEDS, chain=True, task_id=RUN_A)
    wl.add(other, NEEDS, chain=True, task_id=RUN_B)
    record = wl.advance(NEEDS, REPORT, task_id=f"session:{other}")
    assert record["session_key"] == other and record["command"] == NEXT
    assert [r["command"] for r in wl.list()] == [NEEDS, NEXT]


def test_a_repeated_completion_does_not_move_the_other_room(tmp_path):
    other = "agent:main:discord:dm:5"
    wl = watchlist.WatchList(tmp_path / "w.json")
    first = wl.add(KEY, NEEDS, chain=True, task_id=RUN_A)
    second = wl.add(other, NEEDS, chain=True, task_id=RUN_B)
    hook = watchlist.make_terminal_hook(wl)
    rewritten = hook(command=NEEDS, output=REPORT, returncode=0, task_id=f"session:{KEY}")
    assert rewritten is not None and first in rewritten
    again = hook(command=NEEDS, output=REPORT, returncode=0, task_id=f"session:{KEY}")
    assert again == rewritten and second not in again
    listed = {r["watch_id"]: r["command"] for r in wl.list()}
    assert listed[first] == NEXT
    assert listed[second] == NEEDS


def test_a_lone_record_with_another_run_is_left_alone(tmp_path):
    wl = watchlist.WatchList(tmp_path / "w.json")
    wl.add(KEY, NEEDS, chain=True, task_id=RUN_A)
    assert wl.advance(NEEDS, REPORT, task_id=RUN_B) is None
    assert wl.list()[0]["command"] == NEEDS


@pytest.mark.parametrize("run_id", ["default", "profile:main", "shared:peer"])
def test_a_shared_run_id_still_chains_a_lone_record(tmp_path, run_id):
    wl = watchlist.WatchList(tmp_path / "w.json")
    wl.add(KEY, NEEDS, chain=True, task_id=RUN_A)
    assert wl.advance(NEEDS, REPORT, task_id=run_id)["command"] == NEXT


def test_a_shared_run_id_does_not_choose_between_two_rooms(tmp_path):
    other = "agent:main:discord:dm:5"
    wl = watchlist.WatchList(tmp_path / "w.json")
    wl.add(KEY, NEEDS, chain=True, task_id=RUN_A)
    wl.add(other, NEEDS, chain=True, task_id=RUN_B)
    assert wl.advance(NEEDS, REPORT, task_id="default") is None
    assert [r["command"] for r in wl.list()] == [NEEDS, NEEDS]


def test_a_docker_default_profile_watch_still_chains(tmp_path):
    wl = watchlist.WatchList(tmp_path / "w.json")
    watch_id = wl.add(KEY, NEEDS, chain=True, task_id=RUN_A)
    rewritten = watchlist.make_terminal_hook(wl)(
        command=NEEDS, output=REPORT, returncode=0, task_id="default"
    )
    assert rewritten is not None and watch_id in rewritten and NEXT in rewritten
    assert wl.list()[0]["command"] == NEXT


def test_a_legacy_lone_record_with_an_unknown_run_is_left_alone(tmp_path):
    wl, _ = chained_watch(tmp_path)
    assert wl.advance(NEEDS, REPORT, task_id=RUN_C) is None
    assert wl.list()[0]["command"] == NEEDS


def test_the_run_id_from_the_tool_call_selects_the_record(tmp_path):
    other = "agent:main:discord:dm:5"
    ctx = FakeCtx({"hosts": {}, "state_dir": str(tmp_path)})
    plugin.register(ctx)
    call = ctx.tools["bridge_watch"][2]
    first = json.loads(
        call(
            {"action": "add", "session_key": KEY, "command": NEEDS, "chain": True},
            task_id=RUN_A,
        )
    )
    second = json.loads(
        call(
            {"action": "add", "session_key": other, "command": NEEDS, "chain": True},
            task_id=RUN_B,
        )
    )
    assert (
        ctx.hooks["transform_terminal_output"](
            command=NEEDS, output=REPORT, returncode=0, task_id=RUN_C
        )
        is None
    )
    rewritten = ctx.hooks["transform_terminal_output"](
        command=NEEDS, output=REPORT, returncode=0, task_id=RUN_A
    )
    assert rewritten is not None and NEXT in rewritten
    listed = {r["watch_id"]: r for r in json.loads(call({"action": "list"}))["watches"]}
    assert listed[first["watch_id"]]["command"] == NEXT
    assert listed[first["watch_id"]]["task_id"] == RUN_A
    assert listed[second["watch_id"]]["command"] == NEEDS


def test_a_repeated_transform_does_not_advance_twice(tmp_path):
    now = {"t": 7.0}
    wl = watchlist.WatchList(tmp_path / "w.json", clock=lambda: now["t"])
    wl.add(KEY, NEEDS, chain=True, task_id=RUN_A)
    first = wl.advance(NEEDS, REPORT, task_id=RUN_A)
    now["t"] = 30.0
    assert wl.advance(NEEDS, REPORT, task_id=RUN_A) == first
    assert wl.list() == [first]


def test_the_hook_appends_the_next_command_and_moves_the_record(tmp_path):
    wl, watch_id = chained_watch(tmp_path)
    hook = watchlist.make_terminal_hook(wl)
    rewritten = hook(command=NEEDS, output=REPORT, returncode=0)
    assert rewritten.startswith(REPORT)
    assert NEXT in rewritten and watch_id in rewritten
    assert "do not call bridge_watch add" in rewritten
    assert "truncation marker" in rewritten and "process log" in rewritten
    assert "not a user instruction" in rewritten
    assert wl.list()[0]["command"] == NEXT
    assert hook(command=NEEDS, output=REPORT, returncode=0) == rewritten


def test_the_chain_note_survives_the_completion_window(tmp_path):
    wl, _ = chained_watch(tmp_path)
    body = "\n".join(f"job {i:03d} approval_wait: waiting for the owner" for i in range(60))
    report = f"needs: 1 need you, 0 gate, 0 blocked\ncursor: {CURSOR}\n{body}"
    assert len(report) > 2000
    full = watchlist.make_terminal_hook(wl)(command=NEEDS, output=report, returncode=0)
    window = full[-2000:]  # the gateway keeps the last 2000 characters
    assert NEXT in window and "process log" in window and "truncation marker" in window
    assert len(full) - len(report) < 1000
    assert wl.list()[0]["command"] == NEXT


def test_the_hook_returns_none_and_never_raises(tmp_path, monkeypatch):
    wl, _ = chained_watch(tmp_path)
    hook = watchlist.make_terminal_hook(wl)
    assert hook(command=NEEDS, output=REPORT, returncode=None) is None
    assert hook(command=NEEDS, output="", returncode=0) is None
    assert hook(command=None, output=REPORT, returncode=0) is None
    assert hook(command=NEEDS, output=None, returncode=0) is None
    monkeypatch.setattr(wl, "_store", lambda records: (_ for _ in ()).throw(OSError("x")))
    assert hook(command=NEEDS, output=REPORT, returncode=0) is None
    assert wl.list()[0]["command"] == NEEDS


def test_restart_rearm_lists_the_next_command_and_keeps_chain(tmp_path):
    wl, watch_id = chained_watch(tmp_path)
    wl.advance(NEEDS, REPORT)
    inject = Inject()
    assert watchlist.rearm_all(wl, inject) == 1
    text = inject.calls[0][0]
    assert f'"{NEXT}"' in text and watch_id in text
    assert "chain: true" in text and "pass chain: true" in text


def test_the_restart_instruction_re_add_keeps_chaining(tmp_path):
    wl, watch_id = chained_watch(tmp_path)
    wl.advance(NEEDS, REPORT)
    command = wl.list()[0]["command"]
    assert wl.remove(watch_id)
    new_id = wl.add(KEY, command, chain=True, task_id=RUN_B)
    record = wl.advance(command, REPORT.replace(str(CURSOR), "555"), task_id=RUN_B)
    assert record["watch_id"] == new_id
    assert record["command"].endswith("--from 555")


def test_bridge_watch_add_takes_chain_only_as_a_boolean(tmp_path):
    ctx = FakeCtx({"hosts": {}, "state_dir": str(tmp_path)})
    plugin.register(ctx)
    call = ctx.tools["bridge_watch"][2]
    plain = json.loads(call({"action": "add", "session_key": KEY, "command": CMD}, task_id=RUN_A))
    chained = json.loads(
        call(
            {"action": "add", "session_key": KEY, "command": NEEDS, "chain": True},
            task_id=RUN_A,
        )
    )
    wrong = json.loads(
        call(
            {"action": "add", "session_key": KEY, "command": NEEDS, "chain": "yes"},
            task_id=RUN_A,
        )
    )
    listed = {r["watch_id"]: r for r in json.loads(call({"action": "list"}))["watches"]}
    assert "chain" not in listed[plain["watch_id"]]
    assert "task_id" not in listed[plain["watch_id"]]
    assert listed[chained["watch_id"]]["chain"] is True
    assert listed[chained["watch_id"]]["task_id"] == RUN_A
    assert "chain" not in listed[wrong["watch_id"]]
    assert "task_id" not in listed[wrong["watch_id"]]
