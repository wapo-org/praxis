#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
TMP_XDG="$(mktemp -d)"
trap 'rm -rf "${TMP_XDG}"' EXIT

echo "Starting isolated Muse Code OAuth login (file-backed credentials, leaving your macOS Keychain untouched)..."
TBH_CREDENTIAL_BACKEND=file XDG_CONFIG_HOME="${TMP_XDG}" muse login

AUTH_FILE="${TMP_XDG}/muse/auth.json"
if [ ! -f "${AUTH_FILE}" ]; then
  echo "ERROR: ${AUTH_FILE} was not created." >&2
  exit 1
fi

echo "Ensuring Modal Volume 'muse-auth-state' exists..."
uv run --project "${PROJECT_DIR}" modal volume create muse-auth-state --version 2 >/dev/null 2>&1 || true

echo "Uploading auth.json to Modal Volume 'muse-auth-state'..."
uv run --project "${PROJECT_DIR}" modal volume put muse-auth-state "${AUTH_FILE}" /auth.json --force

if [ -f "${HOME}/.config/muse/settings.json" ]; then
  echo "Uploading ~/.config/muse/settings.json to Modal Volume 'muse-auth-state'..."
  uv run --project "${PROJECT_DIR}" modal volume put muse-auth-state "${HOME}/.config/muse/settings.json" /settings.json --force
fi

echo "Done! Verify in Modal with:"
echo "  uv run --project \"${PROJECT_DIR}\" modal run \"${PROJECT_DIR}/app.py::smoke_sandbox\""
