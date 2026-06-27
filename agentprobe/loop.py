"""CUA main loop for agentprobe Android harness."""
import json
import re
import time
from pathlib import Path

from .android import screenshot_b64, ui_dump, get_screen_size
from .actions import execute_action
from .client import make_client
from .prompts import SYSTEM_PROMPT
from .judge import judge_result
from .recording import assemble_gif


def call_llm(client, model: str, system: str, history: list, max_retries: int = 5) -> str:
    """Call LLM via OpenAI-compatible API with exponential backoff on rate limit.

    Returns the model's reply text (the next-action JSON, as a string).
    """
    for attempt in range(max_retries):
        try:
            response = client.chat.completions.create(
                model=model,
                messages=[{"role": "system", "content": system}] + history,
                max_completion_tokens=300,
                temperature=0,
            )
            return response.choices[0].message.content.strip()
        except Exception as e:
            if "429" in str(e) and attempt < max_retries - 1:
                wait = min(60, 15 * (2 ** attempt))
                print(f"  [rate limited, retrying in {wait}s...]")
                time.sleep(wait)
                continue
            raise


def run_cua_step(
    goal: str,
    max_steps: int = 30,
    model: str = "gpt-4o",
    include_ui_xml: bool = False,
    verbose: bool = True,
    step_label: str = "step",
    action_delay: float = 1.0,
    output_dir: str = "/tmp",
    speed_multiplier: float = 1.0,
    client=None,
    success_criteria: str = "",
    failure_criteria: str = "",
) -> dict:
    """Run the CUA loop for a single goal until done/fail/max_steps.

    This drives the device but does NOT decide pass/fail against criteria — that
    is `judge_result`'s job (see run_case). Returns
    {"status": "success"|"failure"|"timeout", "steps": int, "last_screenshot": str}.

    Pass a pre-built `client` to reuse it for judging; otherwise one is made here.
    """
    if client is None:
        client, model = make_client(model)
    history = []
    screen_w, screen_h = get_screen_size()
    label_prefix = f"[{step_label}] " if step_label else ""
    last_screenshot = ""

    for step in range(1, max_steps + 1):
        img_b64 = screenshot_b64(
            label=f"{step_label}_{step:02d}" if step_label else f"{step:03d}",
            output_dir=output_dir,
        )
        last_screenshot = img_b64

        criteria_lines = []
        if success_criteria:
            criteria_lines.append(f"SUCCESS when: {success_criteria}")
        if failure_criteria:
            criteria_lines.append(f"FAIL immediately if: {failure_criteria}")
        criteria_block = ("\n" + "\n".join(criteria_lines)) if criteria_lines else ""

        content = [
            {
                "type": "text",
                "text": (
                    f"{label_prefix}Step {step}/{max_steps}. "
                    f"Screen: {screen_w}x{screen_h}px. "
                    f"Goal: {goal}{criteria_block}\n"
                    "What action should I take next?"
                ),
            },
            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{img_b64}", "detail": "high"}},
        ]

        if include_ui_xml:
            xml = ui_dump()
            if xml:
                content.append({"type": "text", "text": f"UI hierarchy (truncated to 4000 chars):\n{xml[:4000]}"})

        history.append({"role": "user", "content": content})

        reply = call_llm(client, model, SYSTEM_PROMPT, history)
        history.append({"role": "assistant", "content": reply})

        # Parse action — tolerate markdown fences and multi-object responses
        try:
            clean = reply.strip()
            if clean.startswith("```"):
                clean = clean.split("\n", 1)[1].rsplit("```", 1)[0].strip()
            m = re.search(r'\{[^{}]*\}', clean)
            action = json.loads(m.group(0)) if m else json.loads(clean)
        except (json.JSONDecodeError, AttributeError):
            if verbose:
                print(f"  {label_prefix}[step {step}] Failed to parse: {reply[:120]}")
            continue

        result = execute_action(action, speed_multiplier=speed_multiplier)
        if verbose:
            print(f"  {label_prefix}[step {step}] {action.get('type', '?')} -> {result}")

        if result == "DONE":
            return {"status": "success", "steps": step, "last_screenshot": last_screenshot}
        if result.startswith("FAIL"):
            return {"status": "failure", "steps": step, "last_screenshot": last_screenshot}

        # Trim history to keep context manageable
        if len(history) > 14:
            history = history[-14:]

        time.sleep(max(0.1, action_delay * speed_multiplier))

    return {"status": "timeout", "steps": max_steps, "last_screenshot": last_screenshot}


def run_case(
    case,
    model: str = "gpt-4o",
    include_ui_xml: bool = False,
    verbose: bool = True,
    output_dir: str = "/tmp/agentprobe-output",
    speed_multiplier: float = 1.0,
) -> dict:
    """Run a TestCase end-to-end and return a verdict.

    Drives the device via the CUA loop, judges the final screenshot against the
    case's successCriteria / verification, assembles a demo GIF from the
    per-step screenshots, and writes result.json to output_dir.

    Returns the loop result augmented with:
        verdict: "pass" | "fail"
        reason:  explanation
        gif:     path to demo.gif (or None)
    """
    Path(output_dir).mkdir(parents=True, exist_ok=True)
    client, model = make_client(model)

    loop_result = run_cua_step(
        goal=case.instruction,
        max_steps=case.maxSteps,
        model=model,
        include_ui_xml=include_ui_xml,
        verbose=verbose,
        step_label=case.name,
        output_dir=output_dir,
        speed_multiplier=speed_multiplier,
        client=client,
        success_criteria=getattr(case, "successCriteria", ""),
        failure_criteria=getattr(case, "failureCriteria", ""),
    )

    result = judge_result(case, loop_result, client, model)

    gif = assemble_gif(output_dir)
    result["gif"] = gif

    # Drop the base64 blob before persisting — it bloats result.json.
    persisted = {k: v for k, v in result.items() if k != "last_screenshot"}
    try:
        (Path(output_dir) / "result.json").write_text(json.dumps(persisted, indent=2))
    except Exception:
        pass

    if verbose:
        print(f"  [judge] verdict={result['verdict']} -- {result.get('reason', '')}")
        if gif:
            print(f"  [gif] {gif}")
    return result
