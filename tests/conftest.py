"""Load the Hermes plugin the way Hermes does: as a package imported by file path."""

import importlib.util
import json
import stat
import sys
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator, FormatChecker

ROOT = Path(__file__).resolve().parent.parent
CONTRACT = ROOT / "contract"
NAME = "omp_bridge_plugin"


def _load():
    spec = importlib.util.spec_from_file_location(
        NAME, ROOT / "hermes" / "__init__.py", submodule_search_locations=[str(ROOT / "hermes")]
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[NAME] = module
    spec.loader.exec_module(module)
    return module


plugin = _load()


def example(name: str) -> dict:
    return json.loads((CONTRACT / "examples" / name).read_text(encoding="utf-8"))


def schema_errors(schema: str, message: dict) -> list:
    path = CONTRACT / "schema" / f"{schema}.schema.json"
    validator = Draft202012Validator(
        json.loads(path.read_text(encoding="utf-8")), format_checker=FormatChecker()
    )
    return list(validator.iter_errors(message))


def mode(path: Path) -> int:
    return stat.S_IMODE(path.lstat().st_mode)


@pytest.fixture
def fake_ssh(tmp_path):
    """An ssh that runs the remote command in a local shell, as sshd would for a login shell."""
    script = tmp_path / "fake-ssh"
    script.write_text(
        '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nshift\nexec sh -c "$1"\n'
    )
    script.chmod(0o755)
    return str(script)
