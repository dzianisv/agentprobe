import os
import sys


def make_client(model: str):
    """Create OpenAI-compatible client from env vars. Returns (client, model_name)."""
    try:
        from openai import OpenAI, AzureOpenAI
    except ImportError:
        sys.exit("openai package required: pip install openai")

    # Azure CUA (browser runner compat)
    if os.environ.get("AZURE_CUA_API_KEY"):
        base_url = os.environ.get("AZURE_CUA_BASE_URL", "https://vibe-dev-ai.cognitiveservices.azure.com/openai/v1")
        azure_model = os.environ.get("AZURE_CUA_MODEL", model)
        return OpenAI(api_key=os.environ["AZURE_CUA_API_KEY"], base_url=base_url), azure_model

    # Azure OpenAI (standard)
    if os.environ.get("AZURE_OPENAI_API_KEY"):
        azure_model = os.environ.get("AZURE_OPENAI_MODEL", "gpt-5.4")
        return AzureOpenAI(
            api_key=os.environ["AZURE_OPENAI_API_KEY"],
            azure_endpoint=os.environ.get("AZURE_OPENAI_ENDPOINT") or os.environ.get("AZURE_OPENAI_BASE_URL", ""),
            api_version=os.environ.get("AZURE_OPENAI_API_VERSION", "2024-08-01-preview"),
        ), azure_model

    # Azure Dev AI
    if os.environ.get("AZURE_DEV_AI_API_KEY"):
        base_url = os.environ.get("AZURE_DEV_AI_BASE_URL", "https://vibe-dev-ai.cognitiveservices.azure.com/openai/v1")
        azure_model = os.environ.get("AZURE_DEV_AI_MODEL", "gpt-4o-2024-11-20")
        return OpenAI(api_key=os.environ["AZURE_DEV_AI_API_KEY"], base_url=base_url), azure_model

    # OpenAI
    if os.environ.get("OPENAI_API_KEY"):
        base = os.environ.get("OPENAI_BASE_URL")
        client = OpenAI(base_url=base) if base else OpenAI()
        return client, model

    # xAI / Grok
    if os.environ.get("XAI_API_KEY"):
        return OpenAI(
            api_key=os.environ["XAI_API_KEY"],
            base_url="https://api.x.ai/v1",
        ), "grok-2-vision-1212"

    # Gemini
    if os.environ.get("GEMINI_API_KEY"):
        return OpenAI(
            api_key=os.environ["GEMINI_API_KEY"],
            base_url="https://generativelanguage.googleapis.com/v1beta/openai/",
        ), "gemini-2.0-flash"

    sys.exit(
        "Set one of: AZURE_CUA_API_KEY, AZURE_OPENAI_API_KEY, AZURE_DEV_AI_API_KEY, "
        "OPENAI_API_KEY, XAI_API_KEY, or GEMINI_API_KEY"
    )
