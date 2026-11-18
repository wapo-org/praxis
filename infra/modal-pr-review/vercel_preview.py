"""Verify Vercel Deployment Protection for an operator-approved PR head."""

from __future__ import annotations

import json
import os
import re
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass, field
from http.cookies import CookieError, SimpleCookie
from typing import Any

import httpx

from github_api import GitHubAuthError, fetch_pr_details, is_fork_pr

VERCEL_API = "https://api.vercel.com"
DEPLOYMENT_HOST = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.vercel\.app")
DEPLOYMENT_ID = re.compile(r"dpl_[A-Za-z0-9]+")
COMMIT_SHA = re.compile(r"[a-f0-9]{40}")
API_HEALTH_PATH = "/health"
BYPASS_HEADER = "x-vercel-protection-bypass"
SET_BYPASS_COOKIE_HEADER = "x-vercel-set-bypass-cookie"
VERCEL_COOKIE = "_vercel_jwt"
COOKIE_VALUE = re.compile(r"[A-Za-z0-9._~%+=/-]+")
PROTECTION_DENIAL = {401, 403}
PROTECTION_REDIRECTS = {
    httpx.URL("https://vercel.com/login"),
    httpx.URL("https://vercel.com/sso-api"),
}
HEALTH_MAX_BYTES = 4096


class PreviewUnavailable(Exception):
    pass


@dataclass(frozen=True)
class PreviewConfig:
    project_id: str
    token: str = field(repr=False)
    bypass_secret: str = field(repr=False)
    trusted_sha: str
    team_id: str = ""

    @classmethod
    def from_env(cls) -> PreviewConfig:
        return cls(
            project_id=os.environ.get("VERCEL_API_PROJECT_ID", "").strip(),
            token=os.environ.get("VERCEL_TOKEN", "").strip(),
            bypass_secret=os.environ.get("VERCEL_API_AUTOMATION_BYPASS_SECRET", "").strip(),
            trusted_sha=os.environ.get("VERCEL_TRUSTED_PREVIEW_SHA", "").strip(),
            team_id=os.environ.get("VERCEL_TEAM_ID", "").strip(),
        )


@contextmanager
def _get(
    client: httpx.Client, url: str | httpx.URL, headers: Mapping[str, str] | None = None,
) -> Iterator[httpx.Response]:
    # Explicit requests keep client-wide headers, auth and accumulated cookies out of the exchange.
    request = httpx.Request("GET", url, headers=headers)
    response = client.send(request, auth=None, follow_redirects=False, stream=True)
    try:
        yield response
    finally:
        response.close()


def _metadata(client: httpx.Client, config: PreviewConfig, path: str, params: dict[str, str]) -> dict[str, Any]:
    if config.team_id:
        params = {**params, "teamId": config.team_id}
    url = httpx.URL(VERCEL_API + path, params=params)
    with _get(client, url, {"Authorization": f"Bearer {config.token}"}) as response:
        response.raise_for_status()
        response.read()
        data = response.json()
    if not isinstance(data, dict):
        raise PreviewUnavailable("Vercel metadata was malformed.")
    return data


def _ready_preview(row: Any, config: PreviewConfig) -> bool:
    return (
        isinstance(row, dict)
        and row.get("projectId") == config.project_id
        and row.get("target") in (None, "preview")
        and not row.get("customEnvironment")
        and not row.get("deleted")
        and not row.get("softDeletedByRetention")
        and row.get("readyState", row.get("state")) == "READY"
    )


def _resolve_preview(client: httpx.Client, config: PreviewConfig, sha: str, repo_id: int) -> str:
    listing = _metadata(client, config, "/v7/deployments", {
        "projectId": config.project_id, "target": "preview", "sha": sha, "state": "READY",
    })
    deployments = listing.get("deployments")
    if not isinstance(deployments, list):
        raise PreviewUnavailable("Vercel did not return a deployment list.")
    for row in deployments:
        if not _ready_preview(row, config) or row.get("source") != "git" or row.get("prebuilt"):
            continue
        deployment_id = row.get("uid")
        if not isinstance(deployment_id, str) or not DEPLOYMENT_ID.fullmatch(deployment_id):
            continue
        detail = _metadata(client, config, f"/v13/deployments/{deployment_id}", {"withGitRepoInfo": "true"})
        git = detail.get("gitSource")
        host = detail.get("url")
        if (
            _ready_preview(detail, config)
            and detail.get("id") == deployment_id
            and isinstance(git, dict)
            and git.get("type") == "github"
            and git.get("sha") == sha
            and str(git.get("repoId")) == str(repo_id)
            and isinstance(host, str)
            and DEPLOYMENT_HOST.fullmatch(host)
            and host == row.get("url")
        ):
            return f"https://{host}"
    raise PreviewUnavailable("No ready Git deployment matched the API project, repository and PR head.")


def _protection_denied(response: httpx.Response) -> bool:
    if response.status_code in PROTECTION_DENIAL:
        return True
    if not response.is_redirect:
        return False
    location = httpx.URL(response.headers.get("location", ""))
    return location.copy_with(query=None, fragment=None) in PROTECTION_REDIRECTS


def _exchange_cookie(client: httpx.Client, health_url: httpx.URL, config: PreviewConfig) -> str:
    headers = {BYPASS_HEADER: config.bypass_secret, SET_BYPASS_COOKIE_HEADER: "true"}
    with _get(client, health_url, headers) as response:
        location = response.headers.get("location")
        if not response.is_redirect or not location or health_url.join(location) != health_url:
            raise PreviewUnavailable("Vercel did not return the expected same-URL cookie exchange.")
        cookies = []
        for header in response.headers.get_list("set-cookie"):
            parsed: SimpleCookie = SimpleCookie()
            parsed.load(header)
            if VERCEL_COOKIE in parsed:
                cookies.append(parsed[VERCEL_COOKIE])
        if len(cookies) != 1:
            raise PreviewUnavailable("Vercel did not return a single protection cookie.")
        cookie = cookies[0]
        value = cookie.value
        if (
            not cookie["secure"]
            or not cookie["httponly"]
            or cookie["domain"] not in ("", health_url.host)
            or cookie["path"] not in ("", "/", API_HEALTH_PATH)
            or not COOKIE_VALUE.fullmatch(value)
            or value in (config.bypass_secret, config.token)
        ):
            raise PreviewUnavailable("Vercel returned an unusable protection cookie.")
        return value


def _verify_health(client: httpx.Client, origin: str, config: PreviewConfig) -> None:
    url = httpx.URL(origin + API_HEALTH_PATH)
    with _get(client, url) as response:
        if not _protection_denied(response):
            raise PreviewUnavailable("The anonymous health request did not show Vercel protection.")
    value = _exchange_cookie(client, url, config)
    with _get(client, url, {"Cookie": f"{VERCEL_COOKIE}={value}"}) as response:
        if response.status_code != 200:
            raise PreviewUnavailable("The cookie-only request did not reach API health.")
        body = bytearray()
        for chunk in response.iter_bytes():
            body.extend(chunk)
            if len(body) > HEALTH_MAX_BYTES:
                raise PreviewUnavailable("The API health response exceeded its size limit.")
        health = json.loads(body)
        if not isinstance(health, dict) or (
            health.get("type") != "health" or health.get("ok") is not True or health.get("mode") != "production"
        ):
            raise PreviewUnavailable("The API health response was invalid.")


def check_api_preview(
    *,
    gh: httpx.Client,
    vercel: httpx.Client,
    repo: str,
    pr_number: int,
    allowed_repos: tuple[str, ...],
    config: PreviewConfig,
) -> dict[str, str]:
    try:
        if repo not in allowed_repos or pr_number < 1:
            raise PreviewUnavailable("The requested PR is outside the reviewer allowlist.")
        if not config.project_id or not config.token or not config.bypass_secret:
            raise PreviewUnavailable("The API project ID, Vercel token and API bypass secret are required.")
        if not COMMIT_SHA.fullmatch(config.trusted_sha):
            raise PreviewUnavailable("An operator-approved full PR head SHA is required.")
        if config.token == config.bypass_secret:
            raise PreviewUnavailable("Use a dedicated API bypass secret distinct from the Vercel token.")
        pr = fetch_pr_details(gh, repo, pr_number)
        base_repo = pr["base"]["repo"]
        repo_id = base_repo["id"]
        sha = pr["head"]["sha"]
        if (
            is_fork_pr(pr) or base_repo["full_name"] != repo or type(repo_id) is not int or repo_id < 1
            or pr["head"]["repo"]["id"] != repo_id
        ):
            raise PreviewUnavailable("Hosted credential checks require a same-repository PR.")
        if sha != config.trusted_sha:
            raise PreviewUnavailable("The current PR head does not match the operator-approved SHA.")
        origin = _resolve_preview(vercel, config, sha, repo_id)
        _verify_health(vercel, origin, config)
    except PreviewUnavailable as exc:
        return {"status": "blocked", "reason": str(exc)}
    except GitHubAuthError:
        return {"status": "blocked", "reason": "GitHub denied access to the PR metadata."}
    except (httpx.HTTPError, httpx.InvalidURL, CookieError, ValueError, KeyError, TypeError, AttributeError):
        return {"status": "blocked", "reason": "The hosted API check received a failed request or invalid response."}
    return {"status": "verified", "sha": sha, "api_origin": origin, "check": "protected_api_health"}
