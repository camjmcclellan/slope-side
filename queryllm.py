import os
import requests


def query_llm(model: str, system: str, prompt: str) -> str:
    api_key = os.getenv("OPENROUTER_API_KEY")
    if not api_key:
        raise ValueError("Missing environment variable: OPENROUTER_API_KEY")

    response = requests.post(
        "https://openrouter.ai/api/v1/chat/completions",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json={
            "model": model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": prompt},
            ],
        },
    )

    response.raise_for_status()
    return response.json()["choices"][0]["message"]["content"]


if __name__ == "__main__":
    from pathlib import Path
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).with_name(".env"))

    result = query_llm(
        model="google/gemini-3-flash-preview",
        system="You are a helpful assistant.",
        prompt="Say hello in one sentence.",
    )
    print(result)
