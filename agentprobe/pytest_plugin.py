"""pytest plugin for agentprobe CUA fixtures."""
import pytest
from .case import TestCase
from .loop import run_cua_step


@pytest.fixture
def cua_case():
    def _run(case: TestCase, model: str = "gpt-4o", output_dir: str = "/tmp/agentprobe-output"):
        result = run_cua_step(
            goal=case.instruction,
            max_steps=case.maxSteps,
            model=model,
            step_label=case.name,
            output_dir=output_dir,
        )
        return result
    return _run
