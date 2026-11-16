# Modal Muse Code PR Reviewer

Runs [Meta Muse Code CLI](https://developer.meta.ai/ai/lp/muse-code) (`muse-ember-1.0` at `max` reasoning effort) inside isolated [Modal Sandboxes](https://modal.com/docs/guide/sandboxes) on GitHub Pull Requests.

Each PR spawns **6 concurrent specialized sessions** grounded in [`AGENTS.md`](../../AGENTS.md), [`REVIEW_GUIDELINES.md`](./REVIEW_GUIDELINES.md), installed [`cursor/plugins` `pstack/skills`](https://github.com/cursor/plugins/tree/main/pstack/skills), and **read-only Linear (`PRA`)** issue verification (`https://mcp.linear.app/mcp/readonly` + `/usr/local/bin/linear-read`):

1. **`abstractions`** (`--disable-write`): Cross-file layer boundaries, pluggable modularity, type discipline, and centralized constants/tokens.
2. **`maintainability`** (`--disable-write`): Cross-file/cross-client blast radius (`cloud/` + `PraxisChat/`), file size, clean-break completeness (`PRA-73`), and Linear `PRA-*` alignment.
3. **`conciseness`** (`--disable-write`): Code conciseness, dead code/wrapper removal, and `comment-sweep.mjs` hygiene (`no-comments`, `unslop`).
4. **`logic_bs`** (`--disable-write`): Root-cause checks, algorithmic/Convex I/O efficiency, unjustified numbers, and unverified claim detection.
5. **`security`** (`--disable-write`): Tenant/owner isolation, secret redaction, SSRF egress, banned execution primitives, and taint/capability boundaries.
6. **`hands_on`**: Runs `npm --prefix cloud run typecheck`, `npm --prefix cloud test`, `node cloud/scripts/comment-sweep.mjs check`, boots the live `cloud/` API (`:8797`) + Vite web app (`:5173`), runs `smoke:local` and `p0-check.mjs`, and executes an ad-hoc Playwright Chromium verification tailored to the PR.

> Note: Modal containers run Linux, so `PraxisChat/` Swift/iOS changes receive static cross-file review while `cloud/` (API + Web UI) is booted and tested live. Review feedback uses a collaborative question/offer posture (`question_offer`) for subjective suggestions and only blocks (`REQUEST_CHANGES`) on objective failures, `AGENTS.md` HARD boundaries, or Linear `PRA-*` contradictions.

## 1. Local Setup & Modal Auth

```bash
cd infra/modal-pr-review
uv sync
uv run modal setup
```

## 2. Authenticate Muse Code in Modal (OAuth Volume)

Because macOS `muse login` stores OAuth tokens in the macOS Keychain rather than `auth.json`, run the helper script to create an isolated file-backed OAuth session (`TBH_CREDENTIAL_BACKEND=file`) and upload it to the persistent `muse-auth-state` Modal Volume:

```bash
./infra/modal-pr-review/scripts/sync-muse-auth.sh
```

*(Optional alternative: you can also provide `META_API_KEY` inside the Modal Secret below.)*

## 3. Create / Update the Modal Secret

Create (or `--force` update) the Modal Secret named `praxis-pr-reviewer-secrets`:

```bash
uv run --project infra/modal-pr-review modal secret create praxis-pr-reviewer-secrets \
  GITHUB_TOKEN="ghp_or_github_app_token_with_repo_and_pull_requests_write" \
  GITHUB_WEBHOOK_SECRET="your-random-webhook-secret" \
  LINEAR_API_KEY="lin_api_readonly_or_workspace_key" \
  MUSE_MODEL="muse-ember-1.0" \
  MUSE_REASONING_EFFORT="max" \
  MUSE_MAX_MODEL_STEPS="80"
```

Optional keys you can include in `praxis-pr-reviewer-secrets`:
- `META_API_KEY`: API key fallback/override instead of the OAuth volume.
- `REVIEW_DRAFT_PRS`: `"1"` to auto-review draft PRs on open/push.
- `ALLOW_FORK_PRS`: `"1"` to allow PRs from forks.

## 4. Deploy & Smoke-Test

Deploy the webhook and sandbox runner to Modal:

```bash
uv run --project infra/modal-pr-review modal deploy infra/modal-pr-review/app.py
```

Verify the Modal image (`node`, `gh`, `muse`, Playwright Chromium, installed `pstack` skills, Linear `PRA` read probe) and your uploaded Muse OAuth volume:

```bash
uv run --project infra/modal-pr-review modal run infra/modal-pr-review/app.py::smoke_sandbox
```

Trigger a manual review on any open PR:

```bash
uv run --project infra/modal-pr-review modal run infra/modal-pr-review/app.py::review_pr \
  --repo wapo-org/praxis \
  --pr 123 \
  --instructions "Focus on chat scroll behavior and SSE reconnect"
```

## 5. Wire Up the GitHub Webhook

After `modal deploy`, Modal prints the `github_webhook` HTTPS URL (`https://<workspace>--praxis-muse-pr-reviewer-github-webhook.us-east.modal.run`).

In your GitHub repository **Settings -> Webhooks -> Add webhook**:
- **Payload URL:** the `github_webhook` URL from `modal deploy`
- **Content type:** `application/json`
- **Secret:** the exact `GITHUB_WEBHOOK_SECRET` stored in Modal
- **Events:** select **Pull requests** and **Issue comments**

### Triggers
- Automatic on PR `opened`, `synchronize`, `reopened`, and `ready_for_review` (skips drafts by default).
- On-demand via PR comment containing `/muse` or `@muse-review` (with optional custom testing instructions after the command).

## Local Tests

```bash
uv run --project infra/modal-pr-review pytest infra/modal-pr-review/tests
```
