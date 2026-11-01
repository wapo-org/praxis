# Vendored quickjs-ng

- Upstream: https://github.com/quickjs-ng/quickjs (MIT, see `LICENSE`)
- Tag: `v0.17.0`
- Commit: `6d46d07d04041b40f4f49eaa7fdebe44c314c699` (2026-09-18)
- Vendored: 2026-10-22

Copied unmodified: the library sources listed in upstream `CMakeLists.txt`
(`qjs_sources`: `quickjs.c`, `libregexp.c`, `libunicode.c`, `dtoa.c`) and the
headers they include. `quickjs.h` lives in `include/` so Swift can see the
API. Not vendored: `quickjs-libc`, `qjs`/`qjsc`, tests, test262, build scripts.

Local additions (not upstream): `include/CQuickJS.h`, `cquickjs_shim.c`.

To update: clone the new tag into an empty temp directory, copy the same file
set over these, re-check `qjs_sources`/defines in upstream `CMakeLists.txt`
against `Package.swift`, and run `swift test --filter AgentJSTests`.
