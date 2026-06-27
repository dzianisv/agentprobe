"""Pass/fail judgement for agentprobe.

After the CUA loop ends (done or maxSteps), the loop reports only what the
agent *thinks* it did. That is not a verdict — the agent can emit `done` while
sitting on the wrong screen. This module sends the FINAL screenshot plus a
yes/no question to the vision model and uses its answer as the real verdict.

Priority of the question asked:
  1. `verification.prompt` if the case defines one (explicit anti-hallucination guard).
  2. otherwise `successCriteria` phrased as "Is this satisfied? Answer YES or NO."

If neither is available, there is nothing to judge against, so the loop's own
status is passed through unchanged.
"""


def _ask_yes_no(client, model: str, question: str, screenshot_b64: str) -> dict:
    """Ask the vision model a YES/NO question about a screenshot.

    Returns {"passed": bool, "answer": str, "error": str|None}.
    A verification API failure is treated as a FAIL, never a silent pass.
    """
    try:
        response = client.chat.completions.create(
            model=model,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": (
                                f"{question}\n\n"
                                "Answer with YES or NO on the first line, then one short "
                                "sentence of evidence describing what you see."
                            ),
                        },
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:image/png;base64,{screenshot_b64}",
                                "detail": "high",
                            },
                        },
                    ],
                }
            ],
            max_completion_tokens=120,
            temperature=0,
        )
        raw = (response.choices[0].message.content or "").strip()
        passed = raw.upper().lstrip().startswith("YES")
        return {"passed": passed, "answer": raw, "error": None}
    except Exception as exc:  # noqa: BLE001 — any verifier failure fails the test
        return {"passed": False, "answer": "", "error": str(exc)}


def judge_result(case, loop_result: dict, client, model: str) -> dict:
    """Turn a raw loop result into a verdict using the case's criteria.

    Args:
        case: a TestCase (has .successCriteria, .failureCriteria, .verification).
        loop_result: dict from run_cua_step (status + last_screenshot).
        client, model: an OpenAI-compatible client + model name for the vision call.

    Returns the loop_result augmented with:
        verdict: "pass" | "fail"
        reason:  human-readable explanation
        verification: the raw judge answer dict (when a vision check ran)
    """
    out = dict(loop_result)
    screenshot = loop_result.get("last_screenshot", "")

    # Agent explicitly bailed — that is a fail regardless of criteria.
    if loop_result.get("status") == "failure":
        out["verdict"] = "fail"
        out["reason"] = "agent reported failure during the run"
        return out

    question = None
    if getattr(case, "verification", None) and getattr(case.verification, "prompt", ""):
        question = case.verification.prompt
    elif getattr(case, "successCriteria", ""):
        question = (
            f"The success criteria for this test is: {case.successCriteria}\n"
            "Looking at this final screenshot, is the criteria satisfied?"
        )

    # Nothing to judge against — fall back to the loop's own status.
    if not question or not screenshot:
        ok = loop_result.get("status") == "success"
        out["verdict"] = "pass" if ok else "fail"
        out["reason"] = (
            "no successCriteria/verification defined; used loop status "
            f"'{loop_result.get('status')}'"
        )
        return out

    judged = _ask_yes_no(client, model, question, screenshot)
    out["verification"] = judged
    if judged["error"]:
        out["verdict"] = "fail"
        out["reason"] = f"verification call failed: {judged['error']}"
    elif judged["passed"]:
        out["verdict"] = "pass"
        out["reason"] = judged["answer"] or "verifier answered YES"
    else:
        out["verdict"] = "fail"
        out["reason"] = judged["answer"] or "verifier answered NO"
    return out
