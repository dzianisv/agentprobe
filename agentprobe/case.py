from dataclasses import dataclass
from typing import Optional


@dataclass
class Verification:
    prompt: str


@dataclass
class TestCase:
    name: str
    instruction: str
    successCriteria: str = ""
    failureCriteria: str = ""
    maxSteps: int = 30
    verification: Optional[Verification] = None
