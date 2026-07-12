"""CUA main loop for agentprobe Android harness."""
import json
import time
from pathlib import Path

from .android import screenshot_b64, ui_dump, get_screen_size
from .actions import execute_action
from .client import make_client
from .prompts import SYSTEM_PROMPT, SYSTEM_PROMPT_HOLO_APPENDIX
from .judge import judge_result
from .recording import assemble_gif, start_screen_recording, stop_screen_recording


def _extract_first_json_object(text: str) -> dict | None:
    """Extract the first valid JSON object from text using brace-depth tracking."""
    depth = 0
    start = None
    for i, ch in enumerate(text):
        if ch == '{':
            if depth == 0:
                start = i
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0 and start is not None:
                try:
                    return json.loads(text[start:i + 1])
                except json.JSONDecodeError:
                    start = None
    return None


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
    system_prompt_extra: str = "",
    grounding_fn=None,
) -> dict:
    """Run the CUA loop for a single goal until done/fail/max_steps.

    This drives the device but does NOT decide pass/fail against criteria — that
    is `judge_result`'s job (see run_case). Returns
    {"status": "success"|"failure"|"timeout", "steps": int, "last_screenshot": str}.

    Pass a pre-built `client` to reuse it for judging; otherwise one is made here.

    grounding_fn: optional callable(image_b64, description, image_width,
        image_height) -> (x, y). When provided, this is a two-tier CUA setup:
        `client`/`model` is the PLANNER (decides *what* to do, e.g. "tap the
        Settings icon") and grounding_fn is the GROUNDER (turns that
        description into real pixel coordinates for the "tap" action). See
        agentprobe.grounding for the Holo implementation. When None (default),
        the planner model is trusted to emit pixel x/y itself, as before.
    """
    if client is None:
        client, model = make_client(model)
    history = []
    captions = {}  # {filename: reasoning_text} for GIF overlays
    holo_appendix = SYSTEM_PROMPT_HOLO_APPENDIX if grounding_fn is not None else ""
    system = SYSTEM_PROMPT + holo_appendix + ("\n\n" + system_prompt_extra if system_prompt_extra else "")
    screen_w, screen_h = get_screen_size()
    label_prefix = f"[{step_label}] " if step_label else ""
    last_screenshot = ""

    for step in range(1, max_steps + 1):
        # Derive screenshot filename to track captions
        step_name = f"{step_label}_{step:02d}" if step_label else f"{step:03d}"

        img_b64 = screenshot_b64(
            label=step_name,
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

        reply = call_llm(client, model, system, history)
        history.append({"role": "assistant", "content": reply})

        # Parse action — tolerate markdown fences; handle nested JSON objects
        try:
            clean = reply.strip()
            if clean.startswith("```"):
                clean = clean.split("\n", 1)[1].rsplit("```", 1)[0].strip()
            # Try full string first; fall back to brace-depth scanner for nested objects
            try:
                action = json.loads(clean)
            except json.JSONDecodeError:
                action = _extract_first_json_object(clean)
                if action is None:
                    raise json.JSONDecodeError("no JSON object found", clean, 0)
        except (json.JSONDecodeError, AttributeError):
            if verbose:
                print(f"  {label_prefix}[step {step}] Failed to parse: {reply[:120]}")
            continue

        # Holo two-tier mode: planner emitted a "target" description instead
        # of x/y for a tap -- resolve it to real pixel coordinates now, before
        # captioning/execution. A grounding failure skips this step (like a
        # parse failure) rather than aborting the whole run.
        if grounding_fn is not None and action.get("type") == "tap" and "x" not in action:
            target = action.get("target", "")
            if not target:
                if verbose:
                    print(f"  {label_prefix}[step {step}] [holo] tap action missing 'target', skipping")
                continue
            try:
                gx, gy = grounding_fn(img_b64, target, screen_w, screen_h)
                action["x"], action["y"] = gx, gy
                if verbose:
                    print(f"  {label_prefix}[step {step}] [holo grounding] '{target}' -> ({gx}, {gy})")
            except Exception as e:  # noqa: BLE001 -- surfaced via skip, run continues
                if verbose:
                    print(f"  {label_prefix}[step {step}] [holo grounding] FAILED: {e}")
                continue

        # Capture action for caption overlay
        action_type = action.get('type', '?')
        action_reason = action.get('reason', '')
        if action_type and action_reason:
            # Create readable caption: "ACTION: reason"
            caption = f"{action_type.upper()}: {action_reason[:80]}"
        elif action_type:
            caption = f"{action_type.upper()}"
        else:
            caption = ""

        # Map step to screenshot filename for caption
        # Screenshots are saved as step-NNN_label.png or step-NNN.png
        if step_label:
            screenshot_base = f"step-{step:03d}_{step_label}"
        else:
            screenshot_base = f"step-{step:03d}"
        if caption:
            captions[f"{screenshot_base}.png"] = caption

        result = execute_action(action, speed_multiplier=speed_multiplier)
        if verbose:
            print(f"  {label_prefix}[step {step}] {action.get('type', '?')} -> {result}")

        if result == "DONE":
            if captions:
                (Path(output_dir) / "captions.json").write_text(json.dumps(captions, indent=2))
            return {"status": "success", "steps": step, "last_screenshot": last_screenshot}
        if result.startswith("FAIL"):
            if captions:
                (Path(output_dir) / "captions.json").write_text(json.dumps(captions, indent=2))
            return {"status": "failure", "steps": step, "last_screenshot": last_screenshot}

        # Trim history to keep context manageable
        if len(history) > 14:
            history = history[-14:]

        time.sleep(max(0.1, action_delay * speed_multiplier))

    # Save captions for GIF overlay (timeout case)
    if captions:
        (Path(output_dir) / "captions.json").write_text(json.dumps(captions, indent=2))

    return {"status": "timeout", "steps": max_steps, "last_screenshot": last_screenshot}


def run_case(
    case,
    model: str = "gpt-4o",
    include_ui_xml: bool = False,
    verbose: bool = True,
    output_dir: str = "/tmp/agentprobe-output",
    speed_multiplier: float = 1.0,
    grounding_fn=None,
) -> dict:
    """Run a TestCase end-to-end and return a verdict.

    Drives the device via the CUA loop, judges the final screenshot against the
    case's successCriteria / verification, assembles a demo GIF from the
    per-step screenshots, and writes result.json to output_dir.

    grounding_fn: optional two-tier grounding callable, forwarded to
        run_cua_step -- see its docstring (agentprobe.grounding.make_grounding_fn
        builds the Holo one). `model`/the client made from it remains the
        PLANNER in this mode; grounding_fn resolves tap coordinates.

    Returns the loop result augmented with:
        verdict: "pass" | "fail"
        reason:  explanation
        gif:     path to demo.gif (or None)
    """
    Path(output_dir).mkdir(parents=True, exist_ok=True)
    client, model = make_client(model)

    from .android import ensure_app_foreground, maybe_dismiss_telemetry_consent
    pkg = getattr(case, 'package', None)
    if pkg:
        ensure_app_foreground(pkg, verbose=verbose)
        maybe_dismiss_telemetry_consent(pkg, verbose=verbose)
        ensure_app_foreground(pkg, verbose=verbose)

    rec_thread, rec_remote = start_screen_recording(case.name)
    try:
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
            success_criteria="; ".join(case.successCriteria) if isinstance(case.successCriteria, list) else (case.successCriteria or ""),
            failure_criteria="; ".join(case.failureCriteria) if isinstance(case.failureCriteria, list) else (case.failureCriteria or ""),
            system_prompt_extra=case.systemPromptExtra,
            grounding_fn=grounding_fn,
        )
    finally:
        rec_local = str(Path(output_dir) / f"{case.name}.mp4")
        stop_screen_recording(rec_thread, rec_remote, rec_local)

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
