"""Modal images for the reviewer, with every tool version that can be pinned, pinned."""

from __future__ import annotations

from pathlib import Path

import modal

from codex_runtime import CODEX_VERSION
from prompts import installed_skills

PYTHON_VERSION = "3.12"
# Kept equal to uv.lock so the deployed webhook runs what the tests ran.
FASTAPI_VERSION = "0.163.1"
HTTPX_VERSION = "0.28.1"
JSONSCHEMA_VERSION = "4.26.0"
NODE_MAJOR = "22"
# cloud/package.json requires npm >= 11; Node 22 ships npm 10.
NPM_VERSION = "11.19.0"
PLAYWRIGHT_VERSION = "1.64.1"
SKILLS_REPO_URL = "https://github.com/cursor/plugins.git"
# Skills are prompt input for every session, so they are pinned to a reviewed commit, never to HEAD.
SKILLS_REPO_COMMIT = "bf0c7cd80abdbf7fe47b634978a7d1b4071f71a7"
# The Muse installer has no documented version flag; the installed version is recorded by `smoke_sandbox`.
MUSE_INSTALL_URL = "https://dev.meta.ai/install.sh"

LOCAL_MODULES = (
    "codex_runtime",
    "codex_session",
    "diff_index",
    "gates",
    "github_api",
    "images",
    "linear",
    "muse_output",
    "orchestrate",
    "pipeline",
    "prompt_examples",
    "prompts",
    "redact",
    "report",
    "review",
    "rules",
    "runlog",
    "sandbox",
    "ui_prompts",
    "ui_review",
    "validation",
    "vercel_preview",
)

GITHUB_CLI_INSTALL = (
    "curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg "
    "| dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg",
    "chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg",
    'echo "deb [arch=$(dpkg --print-architecture) '
    'signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] '
    'https://cli.github.com/packages stable main" '
    "> /etc/apt/sources.list.d/github-cli.list",
    "apt-get update && apt-get install -y --no-install-recommends gh",
    "rm -rf /var/lib/apt/lists/*",
)

web_image = (
    modal.Image.debian_slim(python_version=PYTHON_VERSION)
    .apt_install("ca-certificates", "curl", "gnupg")
    .run_commands(*GITHUB_CLI_INSTALL, "gh pr comment --help | grep -q -- --attach")
    .pip_install(f"fastapi[standard]=={FASTAPI_VERSION}", f"httpx=={HTTPX_VERSION}",
                 f"jsonschema=={JSONSCHEMA_VERSION}")
    .add_local_python_source(*LOCAL_MODULES)
    .add_local_dir(Path(__file__).with_name("browser"), remote_path="/opt/pr-review-ui")
)

_SKILLS_SPARSE_ARGS = " ".join(f"pstack/skills/{skill}" for skill in installed_skills())

sandbox_image = (
    modal.Image.debian_slim(python_version=PYTHON_VERSION)
    .apt_install(
        "bash",
        "ca-certificates",
        "curl",
        "git",
        "gnupg",
        "jq",
        "lsof",
        "procps",
        "ripgrep",
        "xz-utils",
    )
    .run_commands(
        f"curl -fsSL https://deb.nodesource.com/setup_{NODE_MAJOR}.x | bash -",
        "apt-get install -y --no-install-recommends nodejs",
        f"npm install -g npm@{NPM_VERSION}",
        *GITHUB_CLI_INSTALL,
        f"PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright npx -y playwright@{PLAYWRIGHT_VERSION} install chromium --with-deps",
        f"curl -fsSL {MUSE_INSTALL_URL} | bash",
        "ln -sf /root/.local/bin/muse /usr/local/bin/muse",
        "muse --version",
        "git init -q /tmp/cursor-plugins",
        f"cd /tmp/cursor-plugins && git remote add origin {SKILLS_REPO_URL} "
        f"&& git sparse-checkout set {_SKILLS_SPARSE_ARGS} "
        f"&& git fetch -q --depth=1 --filter=blob:none origin {SKILLS_REPO_COMMIT} "
        "&& git checkout -q FETCH_HEAD",
        "mkdir -p /opt/muse-skills && cp -r /tmp/cursor-plugins/pstack/skills/* /opt/muse-skills/ "
        "&& rm -rf /tmp/cursor-plugins",
    )
    .env(
        {
            "PATH": "/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "PLAYWRIGHT_BROWSERS_PATH": "/opt/ms-playwright",
            "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD": "1",
            "TBH_CREDENTIAL_BACKEND": "file",
            "XDG_CONFIG_HOME": "/root/.config",
            "HOME": "/root",
        }
    )
)


browser_image = (
    sandbox_image
    .apt_install("ffmpeg", "xvfb", "xauth")
    .run_commands(f"npm install --prefix /opt/pr-review-ui --no-audit --no-fund playwright@{PLAYWRIGHT_VERSION}")
)

codex_image = (
    sandbox_image
    .apt_install("bubblewrap")
    .run_commands(f"npm install -g @openai/codex@{CODEX_VERSION}")
    .pip_install(f"jsonschema=={JSONSCHEMA_VERSION}")
)
