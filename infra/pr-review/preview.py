"""Find the Vercel preview built from the exact PR head and the private inputs the hands-on sign-in needs."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

import httpx

VERCEL_API = "https://api.vercel.com"
DEPLOYMENT_HOST = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.vercel\.app")
DEPLOYMENT_ID = re.compile(r"dpl_[A-Za-z0-9]+")
VERCEL_TIMEOUT_SECONDS = 15
REQUIRED_KEYS = ("VERCEL_TOKEN", "VERCEL_WEB_PROJECT_ID", "PREVIEW_TEST_EMAIL", "PREVIEW_TEST_PASSWORD")


class PreviewUnavailable(Exception):
    def __init__(self, blocker: str, message: str):
        super().__init__(message)
        self.blocker = blocker


@dataclass(frozen=True)
class PreviewTarget:
    web_origin: str
    bypass: tuple[tuple[str, str], ...] = field(repr=False)
    email: str = field(repr=False)
    password: str = field(repr=False)

    def login_config(self) -> dict[str, Any]:
        return {
            "webOrigin": self.web_origin,
            "bypass": [{"origin": origin, "secret": secret} for origin, secret in self.bypass],
            "email": self.email,
            "password": self.password,
        }


def _metadata(client: httpx.Client, config: dict[str, str], path: str, params: dict[str, str]) -> dict[str, Any]:
    team = config.get("VERCEL_TEAM_ID", "").strip()
    if team:
        params = {**params, "teamId": team}
    response = client.get(VERCEL_API + path, params=params,
                          headers={"Authorization": f"Bearer {config['VERCEL_TOKEN']}"})
    response.raise_for_status()
    data = response.json()
    if not isinstance(data, dict):
        raise PreviewUnavailable("development_preview", "Vercel metadata was malformed.")
    return data


def _ready(row: Any, project_id: str) -> bool:
    return (
        isinstance(row, dict)
        and row.get("projectId") == project_id
        and row.get("target") in (None, "preview")
        and row.get("readyState", row.get("state")) == "READY"
    )


def resolve_origin(client: httpx.Client, config: dict[str, str], project_id: str, sha: str, repo_id: int) -> str:
    listing = _metadata(client, config, "/v7/deployments", {
        "projectId": project_id, "target": "preview", "sha": sha, "state": "READY",
    })
    for row in listing.get("deployments") or []:
        uid = row.get("uid") if isinstance(row, dict) else None
        if not _ready(row, project_id) or not isinstance(uid, str) or not DEPLOYMENT_ID.fullmatch(uid):
            continue
        detail = _metadata(client, config, f"/v13/deployments/{uid}", {"withGitRepoInfo": "true"})
        git = detail.get("gitSource")
        host = detail.get("url")
        if (
            _ready(detail, project_id)
            and isinstance(git, dict)
            and git.get("sha") == sha
            and str(git.get("repoId")) == str(repo_id)
            and isinstance(host, str)
            and DEPLOYMENT_HOST.fullmatch(host)
        ):
            return f"https://{host}"
    raise PreviewUnavailable("development_preview", "No ready Vercel preview matched the PR head yet.")


def preview_target(config: dict[str, str], sha: str, repo_id: int) -> PreviewTarget:
    missing = [key for key in REQUIRED_KEYS if not config.get(key, "").strip()]
    if missing:
        blocker = "test_account" if any(key.startswith("PREVIEW_TEST_") for key in missing) else "development_preview"
        raise PreviewUnavailable(blocker, "Reviewer preview configuration is incomplete: " + ", ".join(missing))
    try:
        with httpx.Client(timeout=VERCEL_TIMEOUT_SECONDS, trust_env=False) as client:
            web = resolve_origin(client, config, config["VERCEL_WEB_PROJECT_ID"], sha, repo_id)
            bypass = []
            if config.get("VERCEL_WEB_BYPASS_SECRET"):
                bypass.append((web, config["VERCEL_WEB_BYPASS_SECRET"]))
            if config.get("VERCEL_API_PROJECT_ID") and config.get("VERCEL_API_BYPASS_SECRET"):
                api = resolve_origin(client, config, config["VERCEL_API_PROJECT_ID"], sha, repo_id)
                bypass.append((api, config["VERCEL_API_BYPASS_SECRET"]))
    except httpx.HTTPError as error:
        raise PreviewUnavailable("development_preview", f"Vercel lookup failed ({type(error).__name__}).") from error
    return PreviewTarget(web, tuple(bypass), config["PREVIEW_TEST_EMAIL"], config["PREVIEW_TEST_PASSWORD"])
