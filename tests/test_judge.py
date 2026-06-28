"""Tests for agentprobe judge logic."""
import sys
import os

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from agentprobe.case import TestCase, Verification
from agentprobe.judge import judge_result


class FakeClient:
    """Minimal OpenAI-compatible stub for judge tests."""
    def __init__(self, response_text: str):
        self._text = response_text
        self.chat = self

    @property
    def completions(self):
        return self

    def create(self, **kwargs):
        return FakeResponse(self._text)


class FakeChoice:
    def __init__(self, text):
        self.message = FakeMessage(text)


class FakeMessage:
    def __init__(self, content):
        self.content = content


class FakeResponse:
    def __init__(self, text):
        self.choices = [FakeChoice(text)]


class TestJudgeResult:
    def _case(self, **kw):
        return TestCase(name="t", instruction="test", **kw)

    def test_explicit_failure_bypasses_judge(self):
        case = self._case(successCriteria=["screen shows X"])
        loop_result = {"status": "failure", "steps": 3, "last_screenshot": "abc"}
        result = judge_result(case, loop_result, FakeClient("YES"), "gpt-4o")
        assert result["verdict"] == "fail"
        assert "agent reported failure" in result["reason"]

    def test_verification_prompt_yes_is_pass(self):
        case = self._case(verification=Verification(prompt="Is X visible?"))
        loop_result = {"status": "success", "steps": 5, "last_screenshot": "abc"}
        result = judge_result(case, loop_result, FakeClient("YES, the element is visible"), "gpt-4o")
        assert result["verdict"] == "pass"

    def test_verification_prompt_no_is_fail(self):
        case = self._case(verification=Verification(prompt="Is X visible?"))
        loop_result = {"status": "success", "steps": 5, "last_screenshot": "abc"}
        result = judge_result(case, loop_result, FakeClient("NO, element not found"), "gpt-4o")
        assert result["verdict"] == "fail"

    def test_success_criteria_fallback_yes(self):
        case = self._case(successCriteria=["screen shows the dashboard"])
        loop_result = {"status": "success", "steps": 5, "last_screenshot": "abc"}
        result = judge_result(case, loop_result, FakeClient("YES, dashboard visible"), "gpt-4o")
        assert result["verdict"] == "pass"

    def test_success_criteria_fallback_no(self):
        case = self._case(successCriteria=["screen shows the dashboard"])
        loop_result = {"status": "success", "steps": 5, "last_screenshot": "abc"}
        result = judge_result(case, loop_result, FakeClient("NO, showing login"), "gpt-4o")
        assert result["verdict"] == "fail"

    def test_no_criteria_no_screenshot_uses_loop_status_success(self):
        case = self._case()
        loop_result = {"status": "success", "steps": 5, "last_screenshot": ""}
        result = judge_result(case, loop_result, FakeClient("YES"), "gpt-4o")
        assert result["verdict"] == "pass"

    def test_no_criteria_no_screenshot_uses_loop_status_timeout(self):
        case = self._case()
        loop_result = {"status": "timeout", "steps": 30, "last_screenshot": ""}
        result = judge_result(case, loop_result, FakeClient("NO"), "gpt-4o")
        assert result["verdict"] == "fail"

    def test_verification_api_error_is_fail(self):
        class FailingClient:
            class chat:
                class completions:
                    @staticmethod
                    def create(**kwargs):
                        raise RuntimeError("API error")
        case = self._case(verification=Verification(prompt="Is X visible?"))
        loop_result = {"status": "success", "steps": 5, "last_screenshot": "abc"}
        result = judge_result(case, loop_result, FailingClient(), "gpt-4o")
        assert result["verdict"] == "fail"
        assert "verification call failed" in result["reason"]
