"""CUA main loop for agentprobe Android harness."""
import json
import re
import time

from .android import screenshot_b64, ui_dump, get_screen_size
from .actions import execute_action
from .client import make_client
from .prompts import SYSTEM_PROMPT
from .checks import wait_for_session_idle


def call_llm(client, model: str, system: str, history: list, max_retries: int = 5) -> dict:
    """Call LLM via OpenAI-compatible API with exponential backoff on rate limit."""
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
) -> dict:
    """Run the CUA loop for a single goal until done/fail/max_steps.

    Returns {"status": "success"|"failure"|"timeout", "steps": int, "last_screenshot": str}
    """
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

        content = [
            {
                "type": "text",
                "text": (
                    f"{label_prefix}Step {step}/{max_steps}. "
                    f"Screen: {screen_w}x{screen_h}px. "
                    f"Goal: {goal}\n"
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


def run_query_test(
    query: str,
    context_url: str = "",
    model: str = "gpt-4o",
    include_ui_xml: bool = False,
    verbose: bool = False,
) -> dict:
    """Run a query test: optionally poll context_url for idle, then run CUA step."""
    if context_url:
        session = wait_for_session_idle(context_url)
        if session:
            sid = session.get("id", "?")
            if verbose:
                print(f"  [query] session {sid[:16]}... is idle")

    return run_cua_step(
        goal=query,
        model=model,
        include_ui_xml=include_ui_xml,
        verbose=verbose,
    )
