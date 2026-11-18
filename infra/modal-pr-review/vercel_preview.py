"""Resolve the configured web project's immutable preview, then bootstrap its browser cookie."""

from __future__ import annotations

import os
import re
import time
from dataclasses import dataclass, field
from typing import Any

import httpx

DEPLOYMENTS_URL = "https://api.vercel.com/v7/deployments"
DEPLOYMENT_HOST = re.compile(r"[a-z0-9][a-z0-9-]{0,62}\.vercel\.app")
POLL_SECONDS = 10
PREVIEW_WAIT_SECONDS = 180
VERCEL_COOKIE_NAME = "_vercel_jwt"
TERMINAL_STATES = {"ERROR", "CANCELED", "BLOCKED"}


class PreviewUnavailable(Exception):
    pass


@dataclass(frozen=True)
class PreviewConfig:
    project_id: str
    token: str = field(repr=False)
    team_id: str = ""
    bypass_secret: str = field(default="", repr=False)

    @classmethod
    def from_env(cls) -> PreviewConfig:
        return cls(*(os.environ.get(key, "").strip() for key in (
            "VERCEL_WEB_PROJECT_ID", "VERCEL_TOKEN", "VERCEL_TEAM_ID", "VERCEL_AUTOMATION_BYPASS_SECRET"
        )))


def resolve_preview(
    client: httpx.Client, config: PreviewConfig, head_sha: str, *, wait_seconds: int = PREVIEW_WAIT_SECONDS
) -> str:
    if not config.project_id or not config.token:
        raise PreviewUnavailable("Vercel web project ID and API access token are required.")
    params = {"projectId": config.project_id, "sha": head_sha, "target": "preview"}
    if config.team_id:
        params["teamId"] = config.team_id

    deadline = time.monotonic() + wait_seconds
    while True:
        try:
            response = client.get(
                DEPLOYMENTS_URL, params=params, headers={"Authorization": f"Bearer {config.token}"}
            )
            if response.status_code in (401, 403):
                raise PreviewUnavailable("Vercel refused access to the configured web project.")
            response.raise_for_status()
            rows = response.json()["deployments"]
        except (httpx.HTTPError, KeyError, ValueError, TypeError):
            raise PreviewUnavailable("Vercel deployment lookup failed.") from None

        if not isinstance(rows, list):
            raise PreviewUnavailable("Vercel deployment lookup returned an invalid response.")
        matching = [row for row in rows if _matches_preview(row, config.project_id, head_sha)]
        for row in matching:
            host = row.get("url")
            if row.get("readyState") == "READY" and isinstance(host, str) and DEPLOYMENT_HOST.fullmatch(host):
                return f"https://{host}"

        if matching and all(row.get("readyState") in TERMINAL_STATES for row in matching):
            raise PreviewUnavailable("The Vercel preview build for this commit failed or was canceled.")
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise PreviewUnavailable("No ready Vercel web preview was found for the PR head commit.")
        time.sleep(min(POLL_SECONDS, remaining))


def _matches_preview(row: Any, project_id: str, head_sha: str) -> bool:
    if not isinstance(row, dict) or row.get("projectId") != project_id or row.get("target") not in (None, "preview"):
        return False
    git_source = row.get("gitSource")
    meta = row.get("meta")
    source_sha = git_source.get("sha") if isinstance(git_source, dict) else None
    github_sha = meta.get("githubCommitSha") if isinstance(meta, dict) else None
    return (source_sha or github_sha) == head_sha


def preview_cookie(client: httpx.Client, preview_url: str, bypass_secret: str) -> dict[str, Any] | None:
    headers = {}
    if bypass_secret:
        headers = {
            "x-vercel-protection-bypass": bypass_secret,
            "x-vercel-set-bypass-cookie": "true",
        }
    try:
        with client.stream("GET", preview_url, headers=headers, follow_redirects=False) as response:
            if response.status_code in (401, 403):
                raise PreviewUnavailable("Vercel preview access was denied. Check Deployment Protection settings.")
            for cookie in response.cookies.jar:
                if bypass_secret and cookie.name == VERCEL_COOKIE_NAME and cookie.value and cookie.value != bypass_secret:
                    return {
                        "name": cookie.name,
                        "value": cookie.value,
                        "url": preview_url,
                        "secure": True,
                        "httpOnly": True,
                        "sameSite": "Lax",
                    }
            if bypass_secret:
                raise PreviewUnavailable("Vercel did not issue a browser automation cookie.")
            return None
    except httpx.HTTPError:
        raise PreviewUnavailable("The Vercel preview could not be reached.") from None
