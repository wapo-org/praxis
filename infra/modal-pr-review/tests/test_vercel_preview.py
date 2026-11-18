from __future__ import annotations

import json
from dataclasses import replace

import httpx
import pytest

from vercel_preview import BYPASS_HEADER, SET_BYPASS_COOKIE_HEADER, PreviewConfig, check_api_preview

REPO = "wapo-org/praxis"
REPO_ID = 1234
SHA = "a" * 40
ORIGIN = "https://praxis-api-exact.vercel.app"
HOST = ORIGIN.removeprefix("https://")
TOKEN = "synthetic-metadata-token"
BYPASS = "synthetic-api-bypass"
COOKIE = "synthetic-api-cookie"
PROJECT = "prj_api"
DEPLOYMENT = "dpl_ExactApi"
HEALTH = {"type": "health", "ok": True, "mode": "production"}
SET_COOKIE = f"_vercel_jwt={COOKIE}; Secure; HttpOnly; Path=/"
CONFIG = PreviewConfig(PROJECT, TOKEN, BYPASS, SHA, "team_test")


class HostedPreview:
    def __init__(self) -> None:
        self.head_sha = SHA
        self.head_repo = {"full_name": REPO, "id": REPO_ID}
        self.row = {
            "uid": DEPLOYMENT, "projectId": PROJECT, "source": "git", "target": None, "readyState": "READY", "url": HOST,
        }
        self.other_rows = []
        self.detail = {
            "id": DEPLOYMENT, "projectId": PROJECT, "target": None, "readyState": "READY", "url": HOST,
            "gitSource": {"type": "github", "repoId": str(REPO_ID), "sha": SHA},
        }
        self.anonymous = httpx.Response(302, headers={
            "location": "https://vercel.com/sso-api?state=synthetic",
            "set-cookie": "unrelated=anonymous-state; Path=/",
        })
        self.exchange = httpx.Response(307, headers={"location": "/health", "set-cookie": SET_COOKIE})
        self.health = httpx.Response(200, json=HEALTH)
        self.metadata_redirect = False
        self.github_denied = False
        self.requests: list[httpx.Request] = []

    def github(self, request: httpx.Request) -> httpx.Response:
        assert str(request.url) == f"https://api.github.com/repos/{REPO}/pulls/29"
        assert BYPASS_HEADER not in request.headers
        assert "cookie" not in request.headers
        assert request.headers["authorization"] == "Bearer synthetic-github-token"
        if self.github_denied:
            return httpx.Response(403, json={"message": TOKEN})
        return httpx.Response(200, json={
            "head": {"sha": self.head_sha, "repo": self.head_repo},
            "base": {"repo": {"full_name": REPO, "id": REPO_ID}},
        })

    def vercel(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.url.host == "api.vercel.com":
            assert request.headers["authorization"] == f"Bearer {TOKEN}"
            assert BYPASS_HEADER not in request.headers
            assert "cookie" not in request.headers
            if self.metadata_redirect:
                return httpx.Response(302, headers={"location": ORIGIN})
            if request.url.path == "/v7/deployments":
                assert dict(request.url.params) == {
                    "projectId": PROJECT, "target": "preview", "sha": SHA, "state": "READY", "teamId": "team_test",
                }
                return httpx.Response(200, json={"deployments": [*self.other_rows, self.row]})
            assert request.url.path == f"/v13/deployments/{DEPLOYMENT}"
            assert dict(request.url.params) == {"withGitRepoInfo": "true", "teamId": "team_test"}
            return httpx.Response(200, json=self.detail)

        assert str(request.url) == ORIGIN + "/health"
        assert "authorization" not in request.headers
        if BYPASS_HEADER in request.headers:
            assert request.headers[BYPASS_HEADER] == BYPASS
            assert request.headers[SET_BYPASS_COOKIE_HEADER] == "true"
            assert "cookie" not in request.headers
            return self.exchange
        assert SET_BYPASS_COOKIE_HEADER not in request.headers
        if "cookie" in request.headers:
            assert request.headers["cookie"] == f"_vercel_jwt={COOKIE}"
            return self.health
        return self.anonymous

    def check(self, config: PreviewConfig = CONFIG, repo: str = REPO) -> dict[str, str]:
        with (
            httpx.Client(transport=httpx.MockTransport(self.github),
                         headers={"authorization": "Bearer synthetic-github-token"}) as gh,
            httpx.Client(transport=httpx.MockTransport(self.vercel), follow_redirects=True,
                         headers={"authorization": "Bearer unrelated", "cookie": "unrelated=state"}) as vercel,
        ):
            result = check_api_preview(
                gh=gh, vercel=vercel, repo=repo, pr_number=29, allowed_repos=(REPO,), config=config,
            )
        for secret in (TOKEN, BYPASS, COOKIE):
            assert secret not in json.dumps(result)
            assert all(secret not in str(request.url) for request in self.requests)
        return result


def test_protected_api_uses_exact_git_deployment_and_isolates_each_credential() -> None:
    preview = HostedPreview()
    preview.other_rows = [
        {**preview.row, "projectId": "prj_web", "url": "praxis-web.vercel.app"},
        {**preview.row, "target": "production"},
        {**preview.row, "source": "cli"},
        {**preview.row, "customEnvironment": {"slug": "staging"}},
    ]
    assert preview.check() == {
        "status": "verified", "sha": SHA, "api_origin": ORIGIN, "check": "protected_api_health",
    }
    assert [request.url.path for request in preview.requests] == [
        "/v7/deployments", f"/v13/deployments/{DEPLOYMENT}", "/health", "/health", "/health",
    ]


@pytest.mark.parametrize("changes", [
    {"url": "https://unrelated.invalid/"},
    {"url": "branch-alias.vercel.app"},
    {"projectId": "prj_web"},
    {"gitSource": {"type": "github", "repoId": REPO_ID, "sha": "b" * 40}},
    {"gitSource": {"type": "github", "repoId": REPO_ID + 1, "sha": SHA}},
])
def test_unverified_deployment_metadata_never_reaches_a_preview(changes: dict) -> None:
    preview = HostedPreview()
    preview.detail.update(changes)
    assert preview.check()["status"] == "blocked"
    assert len(preview.requests) == 2
    assert {request.url.host for request in preview.requests} == {"api.vercel.com"}


def test_vercel_metadata_redirect_does_not_forward_the_token() -> None:
    preview = HostedPreview()
    preview.metadata_redirect = True
    assert preview.check()["status"] == "blocked"
    assert [request.url.host for request in preview.requests] == ["api.vercel.com"]


@pytest.mark.parametrize("reason", ["fork", "deleted repo", "advanced head", "missing approval", "missing key", "repo"])
def test_unapproved_pr_never_contacts_vercel(reason: str) -> None:
    preview = HostedPreview()
    config = CONFIG
    repo = REPO
    if reason == "fork":
        preview.head_repo = {"full_name": "other/praxis"}
    elif reason == "deleted repo":
        preview.head_repo = None
    elif reason == "advanced head":
        preview.head_sha = "b" * 40
    elif reason == "missing approval":
        config = replace(config, trusted_sha="")
    elif reason == "missing key":
        config = replace(config, bypass_secret="")
    else:
        repo = "other/praxis"
    assert preview.check(config=config, repo=repo)["status"] == "blocked"
    assert preview.requests == []


def test_github_auth_failure_is_blocked_without_echoing_response_content() -> None:
    preview = HostedPreview()
    preview.github_denied = True
    assert preview.check() == {"status": "blocked", "reason": "GitHub denied access to the PR metadata."}
    assert preview.requests == []


@pytest.mark.parametrize("location", ["https://praxis-web.vercel.app/health", "/health?unexpected=1", "/redirect"])
def test_exchange_redirect_cannot_send_any_credential_to_another_url(location: str) -> None:
    preview = HostedPreview()
    preview.exchange = httpx.Response(307, headers={"location": location, "set-cookie": SET_COOKIE})
    assert preview.check()["status"] == "blocked"
    assert len(preview.requests) == 4


@pytest.mark.parametrize("header", [
    "other_cookie=unrelated; Secure; HttpOnly; Path=/",
    f"_vercel_jwt={BYPASS}; Secure; HttpOnly; Path=/",
    f"_vercel_jwt={COOKIE}; Secure; HttpOnly; Domain=.vercel.app; Path=/",
    f"_vercel_jwt={COOKIE}; Secure; Path=/",
])
def test_unusable_cookie_stops_before_replay(header: str) -> None:
    preview = HostedPreview()
    preview.exchange = httpx.Response(307, headers={"location": "/health", "set-cookie": header})
    assert preview.check()["status"] == "blocked"
    assert len(preview.requests) == 4


@pytest.mark.parametrize("path", ["/login", "/sso-api"])
def test_vercel_auth_redirect_counts_as_anonymous_denial(path: str) -> None:
    preview = HostedPreview()
    preview.anonymous = httpx.Response(302, headers={"location": f"https://vercel.com{path}?state=synthetic#fragment"})
    assert preview.check()["status"] == "verified"
    assert [request.url.host for request in preview.requests[-3:]] == [HOST, HOST, HOST]


@pytest.mark.parametrize("location", [
    "https://elsewhere.invalid/sso-api",
    "http://vercel.com/sso-api",
    "https://vercel.com/sso-api/extra",
    "/sso-api",
])
def test_unrecognized_redirect_stops_after_anonymous_request(location: str) -> None:
    preview = HostedPreview()
    preview.anonymous = httpx.Response(302, headers={"location": location})
    assert preview.check() == {
        "status": "blocked", "reason": "The anonymous health request did not show Vercel protection.",
    }
    assert len(preview.requests) == 3


@pytest.mark.parametrize("status", [401, 403])
@pytest.mark.parametrize("headers", [{}, {
    "server": "Vercel", "x-vercel-id": "synthetic-request", "location": "https://vercel.com/sso-api",
}])
def test_app_denial_stops_before_bypass_exchange(status: int, headers: dict[str, str]) -> None:
    preview = HostedPreview()
    preview.anonymous = httpx.Response(status, headers=headers, json={"error": "Access denied"})
    assert preview.check() == {
        "status": "blocked", "reason": "The anonymous health request did not show Vercel protection.",
    }
    assert len(preview.requests) == 3


def test_not_modified_with_vercel_location_is_not_an_auth_redirect() -> None:
    preview = HostedPreview()
    preview.anonymous = httpx.Response(304, headers={"location": "https://vercel.com/sso-api"})
    assert preview.check()["status"] == "blocked"
    assert len(preview.requests) == 3


def test_public_health_cannot_be_counted_as_protected_proof() -> None:
    preview = HostedPreview()
    preview.anonymous = httpx.Response(200, json=HEALTH)
    assert preview.check()["status"] == "blocked"
    assert len(preview.requests) == 3


@pytest.mark.parametrize("status, body", [(401, HEALTH), (302, HEALTH), (200, {"ok": True}),
                                         (200, {**HEALTH, "mode": "local"}), (200, {**HEALTH, "ok": 1})])
def test_exchange_alone_is_not_proof_of_hosted_api_health(status: int, body: dict) -> None:
    preview = HostedPreview()
    preview.health = httpx.Response(status, json=body, headers={"location": "https://elsewhere.invalid/"})
    assert preview.check()["status"] == "blocked"
    assert len(preview.requests) == 5
