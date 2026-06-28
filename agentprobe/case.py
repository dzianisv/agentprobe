from dataclasses import dataclass, field
from typing import List, Optional


@dataclass
class Verification:
    prompt: str


@dataclass
class TestCase:
    name: str
    instruction: str
    successCriteria: List[str] = field(default_factory=list)
    failureCriteria: List[str] = field(default_factory=list)
    maxSteps: int = 30
    verification: Optional[Verification] = None
    url: str = ""
    systemPromptExtra: str = ""  # App-specific prompt additions appended to SYSTEM_PROMPT
    package: str = ""  # Android app package name for pre-flight (e.g. cc.agentlabs.opencode)
