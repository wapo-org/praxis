# Modal Muse Code PR Reviewer

Reviews GitHub pull requests inside an isolated [Modal Sandbox](https://modal.com/docs/guide/sandboxes) with the [Meta Muse Code CLI](https://developer.meta.ai/ai/lp/muse-code) (`muse-ember-1.0`, a small model). Because the model is small, the reviewer is built so that **nothing it says is posted unless the server can verify it**. The rules are in [`REVIEW_GUIDELINES.md`](./REVIEW_GUIDELINES.md); the repo rules it enforces are in [`AGENTS.md`](../../AGENTS.md).

## How a review runs

1. **Checkout and install** in a sandbox that holds no credentials (no secrets in its environment, no credential volume).
2. **Deterministic gates, run by the server** (`gates.py`): `typecheck`, the test suite, `check:rules` against the merge-base baseline, and `comment-sweep`. Their output is posted verbatim. No model judges them.
3. **Credentials enter the sandbox only now**, and six Muse sessions run in parallel (`prompts.py`): five read-only sessions with one narrow job each (`abstractions`, `maintainability`, `conciseness`, `logic_bs`, `security`) and `hands_on`, which boots the API and web app. Each returns JSON findings: `rule_id`, `file`, `line`, `evidence`, `failure_scenario`, `confidence`, plus `linear_issue` / `linear_quote` for Linear claims. Maximum 5 per session.
4. **Server-side validation** (`validation.py`) drops every finding whose rule id is not on the closed list, whose file/line is not in the diff, whose evidence quote is not found verbatim, whose Linear quote is not in the issue text the server fetched, whose confidence is low, or which duplicates another.
5. **Verdict** (`review.py`): `REQUEST_CHANGES` only for a failed gate or a verified, high-confidence HARD-rule finding. Otherwise `COMMENT`. Never `APPROVE`.
6. **Run log** (`runlog.py`): every run is written to the Modal Volume `praxis-pr-review-runs`, including raw model output and every dropped finding with its reason. A session that returns nothing or malformed JSON posts nothing; the review only says the session had no usable output.

> Modal containers run Linux, so `PraxisChat/` Swift changes get a static review only.

## 1. Local setup

```bash
cd infra/modal-pr-review
uv sync
uv run modal setup
```

## 2. Authenticate Muse Code (OAuth volume)

```bash
./infra/modal-pr-review/scripts/sync-muse-auth.sh
```

This creates a file-backed OAuth session and uploads `auth.json` to the `muse-auth-state` Volume. The review function reads it and writes it into the sandbox with mode `600` only after the gates have run. Alternative: set `META_API_KEY` in the secret.

## 3. The Modal secret `praxis-pr-reviewer-secrets`

| Key | Purpose |
| --- | --- |
| `GITHUB_TOKEN` | Read the PR, clone, post the review. **See below.** |
| `GITHUB_WEBHOOK_SECRET` | HMAC key for the webhook. The webhook answers `503` if it is empty. |
| `LINEAR_API_KEY` | Read-only Linear access for `linear-read`, and for the server's quote check. |
| `MUSE_MODEL` | Default `muse-ember-1.0`. |
| `MUSE_REASONING_EFFORT` | Default `max`. |
| `MUSE_MAX_MODEL_STEPS` | No longer read: steps are fixed per session (40 read-only, 80 hands-on) in `prompts.py`. |

Optional: `META_API_KEY`, `REVIEW_DRAFT_PRS=1`, `ALLOW_FORK_PRS=1`, `ALLOWED_REPOS` (comma-separated, default `wapo-org/praxis`).

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

The same PAT is stored in the macOS keychain item `praxis-github-pat` for `git push github`; update both. Then run `smoke_sandbox` (below): `github_token_kind` should read `fine_grained_pat`.

## 4. Deploy and smoke-test

```bash
uv run --project infra/modal-pr-review modal deploy infra/modal-pr-review/app.py
uv run --project infra/modal-pr-review modal run infra/modal-pr-review/app.py::smoke_sandbox
uv run --project infra/modal-pr-review modal run infra/modal-pr-review/app.py::review_pr --repo wapo-org/praxis --pr 123
```

`smoke_sandbox` prints tool versions (`node`, `npm`, `gh`, `muse`), the installed skills, the token kind, and whether Muse auth is present. It prints no secret values.

## 5. GitHub webhook

**Settings → Webhooks → Add webhook:** payload URL = the `github_webhook` URL from `modal deploy`, content type `application/json`, secret = `GITHUB_WEBHOOK_SECRET`, events **Pull requests** and **Issue comments**.

- Automatic on `opened`, `synchronize`, `reopened`, `ready_for_review` (drafts skipped by default).
- On demand: a PR comment containing `/muse` or `@muse-review` from an owner, member or collaborator.
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
- **PR code runs before credentials exist in the sandbox.** `npm ci` and the gates execute PR-controlled code; the sandbox now has no secrets in its environment and no credential volume, and `auth.json` is written (mode `600`) only afterwards. `META_API_KEY` / `LINEAR_API_KEY` are passed to the Muse processes only.
- **Fork PRs via `/muse` comments** were not checked (the comment payload has no head repo); the run now re-checks and skips.
- **Empty webhook secret** would have accepted forged signatures; the webhook now returns `503`.
- **Repository allow-list** (`ALLOWED_REPOS`).
- **No raw model text on GitHub.** Session failures used to post up to 1500 characters of raw output; now only a fixed error class is posted. All outgoing text and the run log are scrubbed for known secret values and token shapes.
- **Model-claimed check failures no longer block.** Only server-run gates do.
- **Timeouts:** sandbox 2700 s, function 3000 s (install ≤ 600 s + gates ≤ 1020 s + sessions ≤ 900 s). Read-only sessions are capped at 40 model steps.

Not fixed — needs a decision or a live check:

- **Muse CLI is not pinned** (`curl https://dev.meta.ai/install.sh | bash`); the installer has no documented version flag. `smoke_sandbox` reports the installed version.
- **Node, `gh` and Playwright system packages** are pinned to a major or exact tool version, not to image digests.
- **Sandbox network egress is open.** Muse, npm and git need the network; Modal's `block_network` / `cidr_allowlist` cannot express a domain allow-list. The `hands_on` session runs PR code with `--yolo` while Muse credentials are in the sandbox, so a malicious same-repo PR could exfiltrate the Muse token and the Linear key. Mitigation today: forks are off and only collaborators can trigger.
- **Cost:** 6 sessions at `max` effort per push, and every `synchronize` event starts a new run without cancelling the previous one.
- **`check:rules` runs the PR's own copy of the script** (with the merge-base baseline); a PR that edits the script shows that in its diff.
- **Step and token counts** in the run log are best-effort: they are read from `usage` fields and `*step*` / `*tool*` event names in the Muse JSONL stream, which has not been checked against live output.

## Local tests

```bash
uv run --project infra/modal-pr-review pytest -q
```
