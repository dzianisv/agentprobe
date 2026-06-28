"""Tests for test case loading and normalization."""
import json
import os
import sys
import tempfile

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from agentprobe.case import TestCase, Verification
from agentprobe.cli import _load_case


def _write_temp(content: str, suffix: str) -> str:
    f = tempfile.NamedTemporaryFile(mode="w", suffix=suffix, delete=False)
    f.write(content)
    f.flush()
    return f.name


class TestYamlLoading:
    def test_goal_alias(self):
        path = _write_temp("name: t\ngoal: do thing\nsuccessCriteria:\n  - a\n  - b\n", ".yaml")
        case = _load_case(path, None)
        assert case.instruction == "do thing"
        assert case.successCriteria == ["a", "b"]

    def test_instruction_field(self):
        path = _write_temp("name: t\ninstruction: do thing\n", ".yaml")
        case = _load_case(path, None)
        assert case.instruction == "do thing"

    def test_max_steps_override(self):
        path = _write_temp("name: t\ngoal: do thing\nmaxSteps: 5\n", ".yaml")
        case = _load_case(path, 99)
        assert case.maxSteps == 99

    def test_max_steps_from_yaml(self):
        path = _write_temp("name: t\ngoal: do thing\nmaxSteps: 7\n", ".yaml")
        case = _load_case(path, None)
        assert case.maxSteps == 7

    def test_verification_loaded(self):
        path = _write_temp(
            "name: t\ngoal: g\nverification:\n  prompt: Is X visible? YES or NO.\n", ".yaml"
        )
        case = _load_case(path, None)
        assert case.verification is not None
        assert "YES or NO" in case.verification.prompt

    def test_string_success_criteria_normalized(self):
        path = _write_temp("name: t\ngoal: g\nsuccessCriteria: single item\n", ".yaml")
        case = _load_case(path, None)
        assert case.successCriteria == ["single item"]

    def test_failure_criteria_list(self):
        path = _write_temp(
            "name: t\ngoal: g\nfailureCriteria:\n  - error shown\n  - crash\n", ".yaml"
        )
        case = _load_case(path, None)
        assert case.failureCriteria == ["error shown", "crash"]


class TestJsonLoading:
    def test_basic_json(self):
        path = _write_temp(
            json.dumps({"name": "t", "instruction": "do thing", "maxSteps": 10}), ".json"
        )
        case = _load_case(path, None)
        assert case.name == "t"
        assert case.maxSteps == 10

    def test_criteria_alias(self):
        path = _write_temp(
            json.dumps({"name": "t", "instruction": "do thing", "criteria": ["a"]}), ".json"
        )
        case = _load_case(path, None)
        assert case.successCriteria == ["a"]


class TestSystemPromptExtra:
    def test_field_defaults_empty(self):
        case = TestCase(name="t", instruction="test")
        assert case.systemPromptExtra == ""

    def test_field_loaded_from_yaml(self):
        path = _write_temp(
            "name: t\ngoal: g\nsystemPromptExtra: Extra hint here.\n", ".yaml"
        )
        case = _load_case(path, None)
        assert case.systemPromptExtra == "Extra hint here."
