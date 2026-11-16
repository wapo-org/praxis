"""Rotate one key of the reviewer's Modal secret without wiping the others.

`modal secret create --force` replaces the whole secret, so this reads every current key, swaps one,
and writes them all back. Values never reach stdout, argv or Modal logs.

    uv run --project infra/modal-pr-review modal run infra/modal-pr-review/scripts/rotate_secret.py --key GITHUB_TOKEN
"""

from __future__ import annotations

import getpass
import json
import os
import subprocess
import tempfile

import modal

SECRET_NAME = "praxis-pr-reviewer-secrets"

app = modal.App("praxis-pr-reviewer-secret-rotation")


@app.function()
def baseline_env_names() -> list[str]:
    return sorted(os.environ)


@app.function(secrets=[modal.Secret.from_name(SECRET_NAME)])
def read_secret_keys(baseline: list[str]) -> dict[str, str]:
    """Only the variables the secret adds; returned to the caller, never printed."""
    known = set(baseline)
    return {name: value for name, value in os.environ.items() if name not in known}


def merge_key(current: dict[str, str], key: str, value: str) -> dict[str, str]:
    if not value.strip():
        raise ValueError("refusing to write an empty value")
    return {**current, key: value.strip()}


@app.local_entrypoint()
def main(key: str) -> None:
    current = read_secret_keys.remote(baseline_env_names.remote())
    if key not in current:
        print(f"note: {key} is not in the secret yet; it will be added")
    updated = merge_key(current, key, getpass.getpass(f"New value for {key} (hidden): "))

    handle, path = tempfile.mkstemp(suffix=".json")
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as file:
            json.dump(updated, file)
        subprocess.run(
            ["modal", "secret", "create", SECRET_NAME, "--from-json", path, "--force"],
            check=True,
            stdout=subprocess.DEVNULL,
        )
    finally:
        os.remove(path)
    print(f"{SECRET_NAME} rewritten with keys: {', '.join(sorted(updated))}")
