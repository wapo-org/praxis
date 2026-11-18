# Modal PR Reviewer

Reviews GitHub pull requests in Modal. Codex CLI, using `gpt-6.2-sol` at low reasoning, handles source review, UI planning, and visual assessment. Muse Code runs the headed browser workflows using `muse-ember-1.0` at medium reasoning. Code findings are validated against the diff. Browser and visual observations are reported with recording evidence.

The Codex process contract was recovered from deployment v4, revision `6771b05`. The existing Modal deployment name remains `praxis-muse-pr-reviewer` so the GitHub webhook URL stays stable.

## How a review runs

1. **Deterministic gates** run the PR's dependency install, typecheck, tests, rules and comment sweep in a disposable sandbox.
2. **Source review and UI planning** use a fresh checkout. Five read-only sessions return code findings for server-side validation. A sixth session reads the diff and plans up to four end-to-end workflows for changed web behavior.
3. **Hosted UI testing** waits up to three minutes for a ready Vercel web Preview matching the PR head SHA. Muse Ember at medium reasoning runs each workflow in headed Chromium and saves its video. A separate Codex session visually inspects contact sheets of up to 20 chronological frames each. UI outcomes and the evidence location appear in the review. The reviewer posts a separate PR comment with playable video attachments for that commit.
4. **Verdict and run log.** A failed deterministic gate or a verified high-confidence HARD finding can request changes. Browser and visual outcomes are advisory. Run records and UI evidence go to the private Modal volume `praxis-pr-review-runs`.

> Modal containers run Linux, so `PraxisChat/` Swift changes get a static review only.

## 1. Local setup

```bash
cd infra/modal-pr-review
uv sync
uv run modal setup
```

## 2. Authenticate the Muse browser worker (OAuth volume)

```bash
./infra/modal-pr-review/scripts/sync-muse-auth.sh
```

This creates a file-backed OAuth session and uploads `auth.json` to the `muse-auth-state` Volume. The review function reads it and writes it into the dedicated model sandboxes with mode `600`. Alternative: set `META_API_KEY` in the secret.

## 3. The Modal secret `praxis-pr-reviewer-secrets`

| Key | Purpose |
| --- | --- |
| `GITHUB_TOKEN` | Read the PR, clone, post the review. **See below.** |
| `GITHUB_WEBHOOK_SECRET` | HMAC key for the webhook. The webhook answers `503` if it is empty. |
| `LINEAR_API_KEY` | Read-only Linear access for `linear-read`, and for the server's quote check. |
| `VERCEL_WEB_PROJECT_ID` | ID of the Vercel **web** project. |
| `VERCEL_TOKEN` | Vercel API token scoped to the account/team containing the web project. |
| `VERCEL_TEAM_ID` | Team ID if Vercel requires a team scope. |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | Project automation secret for protected previews. |

Optional: `META_API_KEY`, `REVIEW_DRAFT_PRS=1`, `ALLOW_FORK_PRS=1`, `ALLOWED_REPOS` (comma-separated, default `wapo-org/praxis`).

The separate Modal secret `praxis-codekey-codex` supplies `CODEKEY_API_KEY` for Codex source and visual review.

### `GITHUB_TOKEN` must be a fine-grained PAT or a GitHub App token

The `wapo-org` organization has **OAuth App access restrictions** turned on. A `gho_` token (the kind `gh auth token` or Copilot hands out) can read but gets **403 on every write**, so it cannot post a review. Use one of:

- a **fine-grained PAT** (`github_pat_…`) for `wapo-org/praxis` with **Contents: read/write** and **Pull requests: read/write**, or
- a **GitHub App installation token** (`ghs_…`) with the same permissions.

The reviewer refuses to start with a `gho_` token, and it **fails loudly on any 401 or 403** from GitHub: the Modal call raises `GitHubAuthError` naming the action that was refused, and the run log records `status: "error"` with that message. It never skips the review silently. `modal run app.py::slop_report` lists such runs under `RUN ERROR`.

### The token expires — rotate it

The current fine-grained PAT **expires on 2026-12-16**. After that every run fails with `GitHub returned 401`. Create the replacement token before that date, then rotate.

`modal secret create --force` **replaces every key** in the secret; passing only `GITHUB_TOKEN=…` would delete the other five. Rotate one key with the helper, which reads all current keys, changes one, and writes them all back with `--from-json --force` (values never touch stdout or shell history):

```bash
uv run --project infra/modal-pr-review modal run infra/modal-pr-review/scripts/rotate_secret.py --key GITHUB_TOKEN
```

By hand, the same three steps: read the existing keys into a private JSON file, change the one value, then

```bash
uv run --project infra/modal-pr-review modal secret create praxis-pr-reviewer-secrets --from-json /path/to/keys.json --force
rm /path/to/keys.json
```

The same PAT is stored in the macOS keychain item `praxis-github-pat` for `git push github`; update both. Run a review to confirm the new token can post to GitHub.

### Vercel Preview setup

1. Connect the **web** project to the Praxis GitHub repository and enable Preview deployments for PR branches. Use [the existing web deployment settings](../../cloud/DEPLOY.md#4-vercel-web) and point previews to test backend resources. Verify that Vercel publishes a ready deployment for the PR's head commit. Hobby supports Git previews for eligible repositories and [includes HTTPS](https://vercel.com/docs/plans).
2. In the web project's **Settings → Deployment Protection → Protection Bypass for Automation**, generate a secret for the reviewer. Keep Vercel Authentication enabled. The Modal function exchanges the secret for a cookie on the resolved deployment origin; the browser sandbox receives the cookie rather than the account token or project secret. [Vercel automation access](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation)
3. Add the four Vercel keys to the dedicated Modal secret `praxis-pr-reviewer-vercel`. A Vercel cookie grants deployment access. Flows that also need Praxis sign-in report a blocker unless they can complete sign-in with test fixtures. Use test accounts and synthetic data in recordings.
4. Run one review against a UI PR with a ready preview. Check that the head SHA matches and the separate recordings comment shows playable videos. GitHub requires the reviewer identity to have push access for attachments. Recordings are visible to PR readers, so use synthetic data on test infrastructure. A failed upload leaves the GitHub review and Modal evidence available. Download the evidence using the run ID in the GitHub review:

   ```bash
   uv run --project infra/modal-pr-review modal volume get praxis-pr-review-runs ui-evidence/<run-id> ./ui-evidence
   ```

## 4. Deploy and smoke-test

```bash
uv run --project infra/modal-pr-review modal deploy infra/modal-pr-review/app.py
uv run --project infra/modal-pr-review modal run infra/modal-pr-review/app.py::smoke_sandbox
uv run --project infra/modal-pr-review modal run infra/modal-pr-review/app.py::review_pr --repo wapo-org/praxis --pr 123
```

`smoke_sandbox` verifies a structured response from the Codex runner in a Modal VM and reports the active model and effort.

## 5. GitHub webhook

**Settings → Webhooks → Add webhook:** payload URL = the `github_webhook` URL from `modal deploy`, content type `application/json`, secret = `GITHUB_WEBHOOK_SECRET`, events **Pull requests** and **Issue comments**.

- Automatic on `opened`, `synchronize`, `reopened`, `ready_for_review` (drafts skipped by default).
- On demand: a PR comment containing `/review`, `/codex`, `/muse`, or `@muse-review` from an owner, member or collaborator.
- Fork PRs are skipped on both paths unless `ALLOW_FORK_PRS=1`; repositories outside `ALLOWED_REPOS` are ignored.

## 6. Seeing slop

```bash
# Last 50 runs: drop rate by reason and session, findings per PR, rule frequency, won't-fix share
uv run --project infra/modal-pr-review modal run infra/modal-pr-review/app.py::slop_report --limit 50

# Offline: score the recorded outputs in evals/recorded (no model, no network)
uv run --project infra/modal-pr-review python infra/modal-pr-review/evals/harness.py

# Live: run the 10 eval fixtures against the model and print precision / recall (costs model calls)
uv run --project infra/modal-pr-review modal run infra/modal-pr-review/app.py::run_evals
```

`evals/cases/*.json` are small diffs with seeded issues (and two clean ones) plus the rule ids we expect. `evals/recorded/*.json` are hand-written stand-ins for model output, used to test the harness; replace them with real outputs after the first live eval. A human marks a finding as wrong by replying "won't fix" (or "false positive") in its review thread; the slop report counts those per rule.

## 7. Environment audit (2026-11-16)

Fixed in code:

- **Skills pinned** to `cursor/plugins@bf0c7cd` (was `HEAD`), and only the 5 skills a prompt uses are installed (was 21).
- **npm pinned** to 11.19.0 (Node 22 ships npm 10; `cloud/` requires ≥ 11). `fastapi` and `httpx` pinned to the `uv.lock` versions.
- **Gate and model sandboxes are separate.** `npm ci` and the gates run without credentials. Source review gets a clean checkout and per-process Codex credentials. Muse credentials stay in the browser sandbox.
- **Fork PRs via `/muse` comments** were not checked (the comment payload has no head repo); the run now re-checks and skips.
- **Empty webhook secret** would have accepted forged signatures; the webhook now returns `503`.
- **Repository allow-list** (`ALLOWED_REPOS`).
- **No raw model text on GitHub.** Session failures used to post up to 1500 characters of raw output; now only a fixed error class is posted. All outgoing text and the run log are scrubbed for known secret values and token shapes.
- **Model-claimed check failures no longer block.** Only server-run gates do.
- **Timeouts:** review function 4800 s, browser sandbox 2100 s. Browser execution is capped at 80 model steps and visual review at 30.

Not fixed — needs a decision or a live check:

- **Muse CLI is not pinned** (`curl https://dev.meta.ai/install.sh | bash`); the installer has no documented version flag.
- **Node, `gh` and Playwright system packages** are pinned to a major or exact tool version, not to image digests.
- **Sandbox network egress is open.** Muse, npm and git need the network; Modal's `block_network` / `cidr_allowlist` cannot express a domain allow-list. Source review and browser testing run in separate sandboxes. The browser sees untrusted preview content and has no Linear or GitHub token.
- **Cost:** Six source sessions run per push. A UI plan adds browser execution and visual review when its preview is ready. Every `synchronize` event starts a new run.
- **`check:rules` runs the PR's own copy of the script** (with the merge-base baseline); a PR that edits the script shows that in its diff.
- **Step and token counts** in the run log are best-effort: they are read from `usage` fields and `*step*` / `*tool*` event names in the Muse JSONL stream, which has not been checked against live output.

## Local tests

```bash
uv run --project infra/modal-pr-review pytest -q
```
