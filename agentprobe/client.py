import os
import sys


def make_client(model: str, backend: str = None, api_key_env: str = None, base_url: str = None):
    """Create OpenAI-compatible client. Returns (client, model_name).

    backend=None (default): scan env vars in priority order, exactly as before.
        Exits the process via sys.exit if nothing is configured (backward compatible).
    backend="generic": explicit OpenAI-compatible endpoint via api_key_env/base_url.
        Raises ValueError (not sys.exit) on misconfiguration, so callers can catch it.
    backend=<named provider>: one of "azure_cua", "azure_openai", "azure_dev_ai",
        "openai", "xai", "gemini" — replicates that provider's branch directly,
        without needing it to be first in priority. Raises ValueError if the
        provider's required env var is missing. An explicit base_url argument, if
        passed, overrides that branch's default/env-derived base_url.
    """
    try:
        from openai import OpenAI, AzureOpenAI
    except ImportError:
        sys.exit("openai package required: pip install openai")

    if backend is None:
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

    if backend == "generic":
        if api_key_env is None or base_url is None:
            raise ValueError("backend='generic' requires both api_key_env and base_url to be provided")
        api_key = os.environ.get(api_key_env)
        if not api_key:
            raise ValueError(f"Environment variable {api_key_env} is not set (required for generic backend)")
        return OpenAI(api_key=api_key, base_url=base_url), model

    if backend == "azure_cua":
        if not os.environ.get("AZURE_CUA_API_KEY"):
            raise ValueError("AZURE_CUA_API_KEY is not set (required for backend='azure_cua')")
        resolved_base_url = base_url or os.environ.get("AZURE_CUA_BASE_URL", "https://vibe-dev-ai.cognitiveservices.azure.com/openai/v1")
        azure_model = os.environ.get("AZURE_CUA_MODEL", model)
        return OpenAI(api_key=os.environ["AZURE_CUA_API_KEY"], base_url=resolved_base_url), azure_model

    if backend == "azure_openai":
        if not os.environ.get("AZURE_OPENAI_API_KEY"):
            raise ValueError("AZURE_OPENAI_API_KEY is not set (required for backend='azure_openai')")
        azure_model = os.environ.get("AZURE_OPENAI_MODEL", "gpt-5.4")
        resolved_endpoint = base_url or os.environ.get("AZURE_OPENAI_ENDPOINT") or os.environ.get("AZURE_OPENAI_BASE_URL", "")
        return AzureOpenAI(
            api_key=os.environ["AZURE_OPENAI_API_KEY"],
            azure_endpoint=resolved_endpoint,
            api_version=os.environ.get("AZURE_OPENAI_API_VERSION", "2024-08-01-preview"),
        ), azure_model

    if backend == "azure_dev_ai":
        if not os.environ.get("AZURE_DEV_AI_API_KEY"):
            raise ValueError("AZURE_DEV_AI_API_KEY is not set (required for backend='azure_dev_ai')")
        resolved_base_url = base_url or os.environ.get("AZURE_DEV_AI_BASE_URL", "https://vibe-dev-ai.cognitiveservices.azure.com/openai/v1")
        azure_model = os.environ.get("AZURE_DEV_AI_MODEL", "gpt-4o-2024-11-20")
        return OpenAI(api_key=os.environ["AZURE_DEV_AI_API_KEY"], base_url=resolved_base_url), azure_model

    if backend == "openai":
        if not os.environ.get("OPENAI_API_KEY"):
            raise ValueError("OPENAI_API_KEY is not set (required for backend='openai')")
        resolved_base_url = base_url or os.environ.get("OPENAI_BASE_URL")
        client = OpenAI(base_url=resolved_base_url) if resolved_base_url else OpenAI()
        return client, model

    if backend == "xai":
        if not os.environ.get("XAI_API_KEY"):
            raise ValueError("XAI_API_KEY is not set (required for backend='xai')")
        resolved_base_url = base_url or "https://api.x.ai/v1"
        return OpenAI(api_key=os.environ["XAI_API_KEY"], base_url=resolved_base_url), "grok-2-vision-1212"

    if backend == "gemini":
        if not os.environ.get("GEMINI_API_KEY"):
            raise ValueError("GEMINI_API_KEY is not set (required for backend='gemini')")
        resolved_base_url = base_url or "https://generativelanguage.googleapis.com/v1beta/openai/"
        return OpenAI(api_key=os.environ["GEMINI_API_KEY"], base_url=resolved_base_url), "gemini-2.0-flash"

    raise ValueError(f"Unknown backend: {backend}")
