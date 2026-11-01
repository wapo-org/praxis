// Shim between Swift and quickjs-ng. See include/CQuickJS.h.
#include "CQuickJS.h"

#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <malloc/malloc.h>
#include <TargetConditionals.h>
#if TARGET_OS_IPHONE
#include <os/proc.h>
#endif

// MARK: Values

JSValue cqjs_undefined(void) { return JS_UNDEFINED; }
JSValue cqjs_null(void) { return JS_NULL; }
JSValue cqjs_exception(void) { return JS_EXCEPTION; }
JSValue cqjs_bool(bool b) { return b ? JS_TRUE : JS_FALSE; }
JSValue cqjs_int32(JSContext *ctx, int32_t v) { return JS_NewInt32(ctx, v); }
JSValue cqjs_float64(JSContext *ctx, double v) { return JS_NewFloat64(ctx, v); }
JSValue cqjs_string(JSContext *ctx, const char *utf8, size_t len) {
    // Swift hands over a NULL base address for empty strings.
    return JS_NewStringLen(ctx, utf8 ? utf8 : "", utf8 ? len : 0);
}

int32_t cqjs_tag(JSValue v) { return JS_VALUE_GET_TAG(v); }
bool cqjs_is_exception(JSValue v) { return JS_IsException(v); }
bool cqjs_is_undefined(JSValue v) { return JS_IsUndefined(v); }
bool cqjs_is_null(JSValue v) { return JS_IsNull(v); }
bool cqjs_is_string(JSValue v) { return JS_IsString(v); }
bool cqjs_is_object(JSValue v) { return JS_IsObject(v); }
bool cqjs_is_number(JSValue v) { return JS_IsNumber(v); }
bool cqjs_is_bool(JSValue v) { return JS_IsBool(v); }

void cqjs_free(JSContext *ctx, JSValue v) { JS_FreeValue(ctx, v); }
JSValue cqjs_dup(JSContext *ctx, JSValue v) { return JS_DupValue(ctx, v); }

const char *cqjs_to_cstring(JSContext *ctx, JSValue v, size_t *len) {
    return JS_ToCStringLen(ctx, len, v);
}

bool cqjs_to_float64(JSContext *ctx, JSValue v, double *out) {
    return JS_ToFloat64(ctx, out, v) == 0;
}

uint8_t *cqjs_bytes(JSContext *ctx, JSValue v, size_t *len) {
    *len = 0;
    if (!JS_IsObject(v)) return NULL;
    if (JS_IsArrayBuffer(v)) {
        size_t size = 0;
        uint8_t *p = JS_GetArrayBuffer(ctx, &size, v);
        if (!p) { JS_FreeValue(ctx, JS_GetException(ctx)); return NULL; }
        *len = size;
        return p;
    }
    if (JS_GetTypedArrayType(v) >= 0) {
        size_t offset = 0, length = 0, bpe = 0;
        JSValue buffer = JS_GetTypedArrayBuffer(ctx, v, &offset, &length, &bpe);
        if (JS_IsException(buffer)) { JS_FreeValue(ctx, JS_GetException(ctx)); return NULL; }
        size_t size = 0;
        uint8_t *p = JS_GetArrayBuffer(ctx, &size, buffer);
        // The typed array keeps the buffer alive; drop our extra reference.
        JS_FreeValue(ctx, buffer);
        if (!p) { JS_FreeValue(ctx, JS_GetException(ctx)); return NULL; }
        if (offset + length > size) return NULL;
        *len = length;
        return p + offset;
    }
    return NULL;
}

// MARK: Errors

JSValue cqjs_new_error(JSContext *ctx, CQJSErrorKind kind, const char *name, const char *message) {
    JSValue err;
    switch (kind) {
    case CQJS_TYPE_ERROR: err = JS_NewTypeError(ctx, "%s", message); break;
    case CQJS_RANGE_ERROR: err = JS_NewRangeError(ctx, "%s", message); break;
    case CQJS_SYNTAX_ERROR: err = JS_NewSyntaxError(ctx, "%s", message); break;
    default: err = JS_NewPlainError(ctx, "%s", message); break;
    }
    if (name && !JS_IsException(err)) {
        JS_DefinePropertyValueStr(ctx, err, "name", JS_NewString(ctx, name),
                                  JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
    }
    return err;
}

JSValue cqjs_throw_error(JSContext *ctx, CQJSErrorKind kind, const char *message) {
    JSValue err = cqjs_new_error(ctx, kind, NULL, message);
    if (JS_IsException(err)) return JS_EXCEPTION;
    return JS_Throw(ctx, err);
}

// MARK: Functions & promises

JSValue cqjs_new_host_function(JSContext *ctx, CQJSHostFunction *fn, const char *name, int length, int magic) {
    return JS_NewCFunction2(ctx, (JSCFunction *)(void *)fn, name, length, JS_CFUNC_generic_magic, magic);
}

JSValue cqjs_new_promise(JSContext *ctx, JSValue funcs[2]) {
    return JS_NewPromiseCapability(ctx, funcs);
}

bool cqjs_call1(JSContext *ctx, JSValue fn, JSValue arg) {
    JSValue r = JS_Call(ctx, fn, JS_UNDEFINED, 1, &arg);
    bool ok = !JS_IsException(r);
    JS_FreeValue(ctx, r);
    return ok;
}

// MARK: Run guard

struct CQJSGuard {
    // Allocator state: touched only on the engine thread.
    size_t memory_used;
    size_t memory_peak;
    size_t memory_limit;
    // Time accounting (engine thread).
    uint64_t wall_deadline_ns;
    uint64_t cpu_budget_ns;
    uint64_t cpu_used_ns;
    uint64_t segment_start_ns;
    int depth;
    // Written by any thread (cancel) and by the engine thread (trip).
    _Atomic int cancelled;
    _Atomic int trip;
};

uint64_t cqjs_now_ns(void) {
    return clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW);
}

size_t cqjs_available_memory(void) {
#if TARGET_OS_IPHONE
    return os_proc_available_memory();
#else
    return 0;
#endif
}

CQJSGuard *cqjs_guard_new(size_t memory_limit, uint64_t wall_deadline_ns, uint64_t cpu_budget_ns) {
    CQJSGuard *g = calloc(1, sizeof(CQJSGuard));
    if (!g) return NULL;
    g->memory_limit = memory_limit;
    g->wall_deadline_ns = wall_deadline_ns;
    g->cpu_budget_ns = cpu_budget_ns;
    atomic_init(&g->cancelled, 0);
    atomic_init(&g->trip, CQJS_TRIP_NONE);
    return g;
}

void cqjs_guard_free(CQJSGuard *g) { free(g); }

void cqjs_guard_cancel(CQJSGuard *g) {
    atomic_store_explicit(&g->cancelled, 1, memory_order_relaxed);
}

static void guard_trip(CQJSGuard *g, CQJSTrip reason) {
    int expected = CQJS_TRIP_NONE;
    atomic_compare_exchange_strong(&g->trip, &expected, (int)reason);
}

CQJSTrip cqjs_guard_trip(CQJSGuard *g) {
    return (CQJSTrip)atomic_load_explicit(&g->trip, memory_order_relaxed);
}

void cqjs_guard_enter(CQJSGuard *g) {
    if (g->depth++ == 0) g->segment_start_ns = cqjs_now_ns();
}

void cqjs_guard_exit(CQJSGuard *g) {
    if (g->depth > 0 && --g->depth == 0) g->cpu_used_ns += cqjs_now_ns() - g->segment_start_ns;
}

uint64_t cqjs_guard_cpu_ns(CQJSGuard *g) {
    uint64_t used = g->cpu_used_ns;
    if (g->depth > 0) used += cqjs_now_ns() - g->segment_start_ns;
    return used;
}

size_t cqjs_guard_peak_memory(CQJSGuard *g) { return g->memory_peak; }

CQJSTrip cqjs_guard_poll(CQJSGuard *g) {
    CQJSTrip t = cqjs_guard_trip(g);
    if (t != CQJS_TRIP_NONE) return t;
    if (atomic_load_explicit(&g->cancelled, memory_order_relaxed)) {
        guard_trip(g, CQJS_TRIP_CANCELLED);
    } else {
        uint64_t now = cqjs_now_ns();
        if (now >= g->wall_deadline_ns) {
            guard_trip(g, CQJS_TRIP_TIMEOUT);
        } else {
            uint64_t used = g->cpu_used_ns + (g->depth > 0 ? now - g->segment_start_ns : 0);
            if (used >= g->cpu_budget_ns) guard_trip(g, CQJS_TRIP_CPU);
        }
    }
    return cqjs_guard_trip(g);
}

// Called by the interpreter every ~10k bytecodes and from regexp loops.
// Returning non-zero raises an uncatchable "interrupted" error.
static int guard_interrupt(JSRuntime *rt, void *opaque) {
    (void)rt;
    return cqjs_guard_poll((CQJSGuard *)opaque) != CQJS_TRIP_NONE;
}

// Allocator: enforces the memory limit itself (instead of
// JS_SetMemoryLimit) so a failed allocation is recorded as a sticky trip —
// script code can catch the "out of memory" error, but the next interrupt
// poll still ends the run.
static void *guard_calloc(void *opaque, size_t count, size_t size) {
    CQJSGuard *g = opaque;
    size_t bytes = count * size;
    if (size != 0 && bytes / size != count) return NULL;
    if (g->memory_used + bytes > g->memory_limit) { guard_trip(g, CQJS_TRIP_MEMORY); return NULL; }
    void *p = calloc(count, size);
    if (!p) { guard_trip(g, CQJS_TRIP_MEMORY); return NULL; }
    g->memory_used += malloc_size(p);
    if (g->memory_used > g->memory_peak) g->memory_peak = g->memory_used;
    return p;
}

static void *guard_malloc(void *opaque, size_t size) {
    CQJSGuard *g = opaque;
    if (g->memory_used + size > g->memory_limit) { guard_trip(g, CQJS_TRIP_MEMORY); return NULL; }
    void *p = malloc(size);
    if (!p) { guard_trip(g, CQJS_TRIP_MEMORY); return NULL; }
    g->memory_used += malloc_size(p);
    if (g->memory_used > g->memory_peak) g->memory_peak = g->memory_used;
    return p;
}

static void guard_free_ptr(void *opaque, void *ptr) {
    CQJSGuard *g = opaque;
    if (!ptr) return;
    size_t s = malloc_size(ptr);
    g->memory_used = s > g->memory_used ? 0 : g->memory_used - s;
    free(ptr);
}

static void *guard_realloc(void *opaque, void *ptr, size_t size) {
    CQJSGuard *g = opaque;
    if (!ptr) return size ? guard_malloc(opaque, size) : NULL;
    if (size == 0) { guard_free_ptr(opaque, ptr); return NULL; }
    size_t old = malloc_size(ptr);
    if (size > old && g->memory_used - old + size > g->memory_limit) { guard_trip(g, CQJS_TRIP_MEMORY); return NULL; }
    void *p = realloc(ptr, size);
    if (!p) { guard_trip(g, CQJS_TRIP_MEMORY); return NULL; }
    g->memory_used = g->memory_used - old + malloc_size(p);
    if (g->memory_used > g->memory_peak) g->memory_peak = g->memory_used;
    return p;
}

static size_t guard_usable_size(const void *ptr) {
    return malloc_size(ptr);
}

static const JSMallocFunctions guard_malloc_functions = {
    guard_calloc, guard_malloc, guard_free_ptr, guard_realloc, guard_usable_size,
};

JSRuntime *cqjs_new_runtime(CQJSGuard *g, size_t max_stack_size) {
    JSRuntime *rt = JS_NewRuntime2(&guard_malloc_functions, g);
    if (!rt) return NULL;
    JS_SetMaxStackSize(rt, max_stack_size);
    JS_SetInterruptHandler(rt, guard_interrupt, g);
    // No Atomics.wait: a blocked engine thread can't be interrupted.
    JS_SetCanBlock(rt, false);
    return rt;
}

JSContext *cqjs_new_context(JSRuntime *rt) {
    // JS_NewContext already adds DOMException (via atob/btoa) and performance.
    return JS_NewContext(rt);
}

// MARK: Eval

JSValue cqjs_eval(JSContext *ctx, const char *source, size_t len, const char *filename, int line, bool compile_only) {
    JSEvalOptions options = {
        .version = JS_EVAL_OPTIONS_VERSION,
        .eval_flags = JS_EVAL_TYPE_GLOBAL | (compile_only ? JS_EVAL_FLAG_COMPILE_ONLY : 0),
        .filename = filename,
        .line_num = line,
    };
    return JS_Eval2(ctx, source, len, &options);
}
