"""pytest plugin for agentprobe CUA fixtures.

Provides a `cua_case` fixture that runs a TestCase end-to-end (drive + judge +
GIF) and returns the verdict dict. The caller asserts on result["verdict"].
"""
import pytest

from .case import TestCase
from .loop import run_case


@pytest.fixture
def cua_case():
    def _run(case: TestCase, model: str = "gpt-4o",
             output_dir: str = "/tmp/agentprobe-output", **kwargs):
        return run_case(case, model=model, output_dir=output_dir, **kwargs)
    return _run
