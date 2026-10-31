"""Watch list, the bridge_watch tool and the restart re-arm turn."""

import json
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
