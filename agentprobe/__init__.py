from .case import TestCase, Verification
from .loop import run_cua_step
from .cli import main


class AndroidDriver:
    def __init__(self, package: str = "", output_dir: str = "/tmp"):
        self.package = package
        self.output_dir = output_dir

    def screenshot(self, label=""):
        from .android import screenshot_b64
        return screenshot_b64(label, self.output_dir)

    def ensure_foreground(self, retries=3, verbose=False):
        from .android import ensure_app_foreground
        return ensure_app_foreground(self.package, retries=retries, verbose=verbose)

    def dismiss_telemetry(self, verbose=False):
        from .android import maybe_dismiss_telemetry_consent
        return maybe_dismiss_telemetry_consent(self.package, verbose=verbose)


def run_case(case, driver=None, model="gpt-4o", output_dir="/tmp"):
    return run_cua_step(
        goal=case.instruction,
        max_steps=case.maxSteps,
        model=model,
        step_label=case.name,
        output_dir=output_dir,
    )


__all__ = ["TestCase", "Verification", "AndroidDriver", "run_cua_step", "run_case", "main"]
