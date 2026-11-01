// CQuickJS — vendored quickjs-ng plus a small shim for what Swift can't
// import directly: value macros (JS_UNDEFINED, JS_EXCEPTION, …), the magic
// C-function constructor (needs a cast), and the run guard that enforces
// memory / time / cancellation limits from inside the engine.
#ifndef CQUICKJS_H
#define CQUICKJS_H

#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>
#include "quickjs.h"

#ifdef __cplusplus
extern "C" {
#endif

// MARK: Values

JSValue cqjs_undefined(void);
JSValue cqjs_null(void);
JSValue cqjs_exception(void);
JSValue cqjs_bool(bool b);
JSValue cqjs_int32(JSContext *ctx, int32_t v);
JSValue cqjs_float64(JSContext *ctx, double v);
/// `utf8` may be NULL for an empty string.
JSValue cqjs_string(JSContext *ctx, const char *utf8, size_t len);

int32_t cqjs_tag(JSValue v);
bool cqjs_is_exception(JSValue v);
bool cqjs_is_undefined(JSValue v);
bool cqjs_is_null(JSValue v);
bool cqjs_is_string(JSValue v);
bool cqjs_is_object(JSValue v);
bool cqjs_is_number(JSValue v);
bool cqjs_is_bool(JSValue v);

void cqjs_free(JSContext *ctx, JSValue v);
JSValue cqjs_dup(JSContext *ctx, JSValue v);

/// UTF-8 bytes of `v` converted to a string (lone surrogates become
/// replacement-safe 3-byte sequences). Free with `JS_FreeCString`.
const char *cqjs_to_cstring(JSContext *ctx, JSValue v, size_t *len);
bool cqjs_to_float64(JSContext *ctx, JSValue v, double *out);

/// Bytes of a Uint8Array / any typed array / DataView / ArrayBuffer.
/// Returns NULL (and clears nothing) when `v` is none of those.
uint8_t *cqjs_bytes(JSContext *ctx, JSValue v, size_t *len);

// MARK: Errors

typedef enum {
    CQJS_ERROR = 0,
    CQJS_TYPE_ERROR = 1,
    CQJS_RANGE_ERROR = 2,
    CQJS_SYNTAX_ERROR = 3,
} CQJSErrorKind;

/// New error object; `name` overrides the constructor's name when non-NULL.
JSValue cqjs_new_error(JSContext *ctx, CQJSErrorKind kind, const char *name, const char *message);
/// Throws a new error and returns JS_EXCEPTION.
JSValue cqjs_throw_error(JSContext *ctx, CQJSErrorKind kind, const char *message);

// MARK: Functions & promises

typedef JSValue CQJSHostFunction(JSContext *ctx, JSValue this_val, int argc, JSValue *argv, int magic);

/// A native function that dispatches on `magic` (one trampoline for all
/// host bindings).
JSValue cqjs_new_host_function(JSContext *ctx, CQJSHostFunction *fn, const char *name, int length, int magic);

/// New pending promise; writes [resolve, reject] to `funcs` (owned).
JSValue cqjs_new_promise(JSContext *ctx, JSValue funcs[2]);
/// Calls `fn(arg)` and frees the result. Returns false on exception.
bool cqjs_call1(JSContext *ctx, JSValue fn, JSValue arg);

// MARK: Run guard

typedef enum {
    CQJS_TRIP_NONE = 0,
    CQJS_TRIP_CANCELLED = 1,
    CQJS_TRIP_TIMEOUT = 2,
    CQJS_TRIP_CPU = 3,
    CQJS_TRIP_MEMORY = 4,
} CQJSTrip;

/// Per-run limits shared by the allocator and the interrupt handler.
/// Owned by Swift; must outlive the runtime created from it.
typedef struct CQJSGuard CQJSGuard;

CQJSGuard *cqjs_guard_new(size_t memory_limit, uint64_t wall_deadline_ns, uint64_t cpu_budget_ns);
void cqjs_guard_free(CQJSGuard *g);
/// Thread-safe: may be called from any thread while JS runs.
void cqjs_guard_cancel(CQJSGuard *g);
/// First limit that tripped (sticky), or CQJS_TRIP_NONE.
CQJSTrip cqjs_guard_trip(CQJSGuard *g);
/// Brackets one synchronous stretch of JS execution; the CPU budget only
/// counts time inside these brackets (not time spent awaiting I/O).
void cqjs_guard_enter(CQJSGuard *g);
void cqjs_guard_exit(CQJSGuard *g);
uint64_t cqjs_guard_cpu_ns(CQJSGuard *g);
size_t cqjs_guard_peak_memory(CQJSGuard *g);
/// Re-checks wall clock / CPU outside JS (e.g. after a wait).
CQJSTrip cqjs_guard_poll(CQJSGuard *g);

/// Runtime whose allocations count against `g`'s memory limit and whose
/// interrupt handler enforces `g`'s time limits and cancellation.
JSRuntime *cqjs_new_runtime(CQJSGuard *g, size_t max_stack_size);
/// Context with the standard intrinsics (incl. DOMException, atob/btoa,
/// performance, queueMicrotask).
JSContext *cqjs_new_context(JSRuntime *rt);

// MARK: Eval

/// Evaluates `source` as a global script. `line` is the line number of the
/// first line (0 lets a one-line wrapper header keep user line numbers).
JSValue cqjs_eval(JSContext *ctx, const char *source, size_t len, const char *filename, int line, bool compile_only);

// MARK: Platform

/// Monotonic clock in nanoseconds (includes sleep).
uint64_t cqjs_now_ns(void);
/// `os_proc_available_memory()` on iOS; 0 where unavailable (macOS, some
/// simulators).
size_t cqjs_available_memory(void);

#ifdef __cplusplus
}
#endif

#endif // CQUICKJS_H
