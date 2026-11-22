# Praxis PR reviewer

Reviews pull requests on `wapo-org/praxis` from the Oracle host as `praxis-review.service`.
This folder is the source of truth: change it here, then deploy with `scripts/deploy.sh`.
Review rules and tone are in [`REVIEW_GUIDELINES.md`](./REVIEW_GUIDELINES.md).

## Flow

1. A GitHub webhook (`POST /github`, via Caddy at `review.129.80.63.165.sslip.io`) queues the PR in `queue.sqlite3`.
   Pull request events and `/muse` or `@muse-review` comments from collaborators trigger a run.
2. A gates container clones the PR head, runs `npm ci` and the deterministic gates (typecheck, tests, `check:rules`, `comment-sweep`).
   No credential exists in this container: it runs PR-controlled code.
3. A model container runs five read-only code sessions in parallel on `gpt-6.2-sol` (low effort, Codex Key):
   `abstractions`, `maintainability`, `conciseness`, `logic_bs` and `security`.
   They run as the unprivileged `node` user, so the root-owned checkout is read-only and the Muse login is unreadable.
4. A session sets `ui_check` when a change needs manual UI verification that tests cannot guarantee. Only then:
   - the server finds the Vercel preview built from the exact PR head and signs in as the test account (`review_tools/preview-login.mjs`, unrecorded);
   - Muse (`muse-ember-1.0`, medium) writes a check and runs it with `review-check`, which records only that check;
   - ffmpeg turns the recording into a contact sheet, and a Sol session scores it for consistency, function and unexpected states.
5. The server keeps only findings it can verify against the diff and posts one review.

Every preview shares one Convex backend deployed from `develop` (`.github/workflows/convex-preview.yml`).
For PRs that change `cloud/convex/`, the UI check says that backend changes were not live.

## Host layout

| Path | Contents |
|---|---|
| `/opt/praxis-review` | This folder plus `.venv` (FastAPI, httpx) |
| `/etc/praxis-review/credentials.json` | Private config (below), `root:praxis-review 640` |
| `/var/lib/praxis-review/codex-key/` | `config.toml` and `auth.json` for Codex Key |
| `/var/lib/praxis-review/muse-auth.json` | Muse OAuth state, refreshed by runs |
| `/var/lib/praxis-review/runs/` | One redacted JSON record per run |
| `/var/lib/praxis-review/review-artifacts/` | Contact sheets and recordings, never published |

Config keys: `GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET`, `LINEAR_API_KEY`, optional `META_API_KEY`,
`SOL_MODEL` / `SOL_REASONING_EFFORT`, `MUSE_MODEL` / `MUSE_REASONING_EFFORT`,
and for the UI check `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_WEB_PROJECT_ID`, `VERCEL_WEB_BYPASS_SECRET`,
optional `VERCEL_API_PROJECT_ID` / `VERCEL_API_BYPASS_SECRET`, `PREVIEW_TEST_EMAIL` and `PREVIEW_TEST_PASSWORD`.
A missing UI-check key turns into a private access request on the review instead of a check.

`GITHUB_TOKEN` must be a fine-grained PAT or GitHub App token with Contents and Pull requests read/write.

## Deploy

```bash
infra/pr-review/scripts/deploy.sh ubuntu@<host> <ssh-key>
```

It backs up `/opt/praxis-review` to `/opt/praxis-review.pre-deploy-<UTC>`, copies this folder, rebuilds the
`praxis-review-sandbox` image when the `Containerfile` changed or the tag in `container_runtime.py` is missing,
restarts the service and checks `/health`. Bump the image tag whenever the `Containerfile` changes.

To review a PR without a webhook delivery, insert a row into the queue on the host:

```bash
sudo -u praxis-review python3 -c "import sqlite3,uuid; c=sqlite3.connect('/var/lib/praxis-review/queue.sqlite3'); \
c.execute('INSERT INTO delivery VALUES (?,?,?,?,?,?)', (str(uuid.uuid4()), 'wapo-org/praxis', 31, 'issue_comment', '', 'queued')); c.commit()"
```

## Tests

```bash
uv run --project infra/pr-review --locked pytest infra/pr-review/tests -q
uv run --project infra/pr-review python infra/pr-review/evals/harness.py
```
