# Modal sandbox image (PRA-51)

The JS SDK image definition is exported as `@praxis/sandbox-tools/image`:
`sandboxBaseImage(client)` imports a digest-pinned Node 22.16.0 Bookworm slim image;
`sandboxToolsImage(client)` adds Python 3.11.2, git, build-essential and tmux.
The Debian snapshot freezes transitive package resolution. Top-level package versions,
the registry digest and the snapshot timestamp live in `src/modal/image.ts`.
Apt verifies Debian signatures; HTTP is used only to bootstrap CA certificates in the slim base.

PRA-20 can append a browser layer and PRA-82 can append per-harness layers with
`dockerfileCommands` without changing either builder. Jupyter and tree-sitter belong
to PRA-105 and PRA-106. There is no HTTP daemon, tunnel or sandbox bearer token:
PRA-100/PRA-77 use native Modal exec and filesystem APIs instead.

Run the opt-in smoke from the repository root with credentials already configured
for the Modal JS SDK (`~/.modal.toml` or `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET`):

```sh
PRAXIS_IMAGE_REVISION=$(git rev-parse HEAD) npm --prefix cloud run smoke:modal -w @praxis/sandbox-tools
```

It builds the image, publishes the private `praxis-sandbox:<full-git-sha>` tag,
records the image ID and cold boot-to-ready time, and exercises the Modal port's
exec and byte write/read, built-in Node and approved workspace Python diagnostics,
background jobs, git checkpoints/rewind and export. It uses 0.125 CPU, 256 MiB and
a 110-second hard lifetime; termination is awaited in `finally`. The final check
confirms termination using `poll()` because Modal's sandbox list can lag.
Logs go to the gitignored `cloud/artifacts/modal/sandboxes.log`.

The apt command has a 150-second deadline. SDK 0.11.1 exposes neither CPU nor a
whole-build timeout option for image builders; Modal controls registry import and
builder scheduling. Do not retry beyond an approved build/boot budget.

Run `npm --prefix cloud run typecheck` and `npm --prefix cloud test` to typecheck
and test the sandbox packages locally. This revision does not configure CI for
the offline image composition test.
A real image build/publish needs a Modal account token and incurs spend. No secret
or automatic paid build is added to CI; the tracked [PRA-110](https://linear.app/praxis-a/issue/PRA-110) sub-issue
covers enabling and verifying that authenticated build gate with owner-provided CI
credentials. The local smoke remains runnable independently of CI.
