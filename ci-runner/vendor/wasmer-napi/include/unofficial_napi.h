#ifndef UNOFFICIAL_NAPI_H_
#define UNOFFICIAL_NAPI_H_

#include <stdint.h>

#include "js_native_api.h"

#ifdef __cplusplus
extern "C" {
#endif

struct uv_loop_s;

// Provider-owned resources used during environment construction and teardown.
// Their representations are private to the provider; callers may only move
// them through the operations that name the corresponding handle type.
typedef struct unofficial_napi_env_owner__* unofficial_napi_env_owner;
typedef struct unofficial_napi_guest_heap__* unofficial_napi_guest_heap;

enum { UNOFFICIAL_NAPI_ENV_CREATE_OPTIONS_VERSION = 1 };

enum { UNOFFICIAL_NAPI_RUNTIME_OPTIONS_VERSION = 1 };

// Configuration for the provider's process-global JavaScript runtime. This
// must be applied before creating an environment. Repeating an identical
// configuration is idempotent; a conflicting configuration is rejected.
// Pointed-to strings are observed only for the duration of the call.
typedef struct {
  uint32_t size;
  uint32_t version;
  const char* engine_flags;
  size_t engine_flags_length;
} unofficial_napi_runtime_options;

NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_configure_runtime(
    const unofficial_napi_runtime_options* options_or_null);

// All provider configuration needed before engine/isolate creation. The
// descriptor is observed only for the duration of unofficial_napi_create_env;
// pointed-to strings remain owned by the caller. `size` and `version` make
// additions ABI-compatible. Process-global configuration is deliberately
// excluded and belongs to unofficial_napi_configure_runtime.
typedef struct {
  uint32_t size;
  uint32_t version;
  uint64_t total_memory;
  uint64_t constrained_memory;
  size_t max_young_generation_size_in_bytes;
  size_t max_old_generation_size_in_bytes;
  size_t code_range_size_in_bytes;
  void* stack_limit;
  /* Opaque guest-heap resource (see napi_host_guest_heap_alloc). When set, the
   * env's array-buffer allocator places every backing store in the guest's
   * linear memory from isolate birth. Ownership transfers only after size and
   * version validation proves that this field is present, before validating
   * any other argument. It is then released exactly once via
   * napi_host_guest_heap_release (by the allocator destructor, or on any later
   * env-creation failure). */
  unofficial_napi_guest_heap guest_heap;
} unofficial_napi_env_create_options;

typedef void (*unofficial_napi_context_token_callback)(napi_env env,
                                                       void* token,
                                                       void* data);
typedef void (*unofficial_napi_foreground_task_callback)(napi_env env,
                                                         void* data);
typedef void (*unofficial_napi_foreground_task_cleanup)(napi_env env,
                                                        void* data);
typedef napi_status (*unofficial_napi_enqueue_foreground_task_callback)(
    void* target,
    unofficial_napi_foreground_task_callback callback,
    void* data,
    unofficial_napi_foreground_task_cleanup cleanup,
    uint64_t delay_millis);
typedef void (*unofficial_napi_fatal_error_callback)(napi_env env,
                                                     const char* location,
                                                     const char* message);
typedef void (*unofficial_napi_oom_error_callback)(napi_env env,
                                                   const char* location,
                                                   bool is_heap_oom,
                                                   const char* detail);

typedef enum {
  unofficial_napi_env_hook_context_token_assign = 1u << 0,
  unofficial_napi_env_hook_context_token_unassign = 1u << 1,
  unofficial_napi_env_hook_enqueue_foreground_task = 1u << 2,
  unofficial_napi_env_hook_fatal_error = 1u << 3,
  unofficial_napi_env_hook_oom_error = 1u << 4,
} unofficial_napi_env_hook;

enum { UNOFFICIAL_NAPI_ENV_HOOKS_VERSION = 1 };

// Immutable embedder callbacks attached as one complete environment state
// transition. `size` and `version` make additions ABI-compatible. `data` is
// owned by the embedder and must remain valid until the environment is released.
typedef struct {
  uint32_t size;
  uint32_t version;
  void* data;
  unofficial_napi_context_token_callback context_token_assign_callback;
  unofficial_napi_context_token_callback context_token_unassign_callback;
  unofficial_napi_enqueue_foreground_task_callback enqueue_foreground_task_callback;
  unofficial_napi_fatal_error_callback fatal_error_callback;
  unofficial_napi_oom_error_callback oom_error_callback;
} unofficial_napi_env_hooks;

static inline uint64_t unofficial_napi_env_hooks_requested(
    const unofficial_napi_env_hooks* hooks) {
  if (hooks == NULL) return 0;
  uint64_t requested = 0;
  if (hooks->context_token_assign_callback != NULL)
    requested |= unofficial_napi_env_hook_context_token_assign;
  if (hooks->context_token_unassign_callback != NULL)
    requested |= unofficial_napi_env_hook_context_token_unassign;
  if (hooks->enqueue_foreground_task_callback != NULL)
    requested |= unofficial_napi_env_hook_enqueue_foreground_task;
  if (hooks->fatal_error_callback != NULL)
    requested |= unofficial_napi_env_hook_fatal_error;
  if (hooks->oom_error_callback != NULL)
    requested |= unofficial_napi_env_hook_oom_error;
  return requested;
}

NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_create_env(
    int32_t module_api_version,
    const unofficial_napi_env_create_options* options_or_null,
    napi_env* env_out,
    unofficial_napi_env_owner* owner_out);
NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_attach_env(
    napi_env env,
    const unofficial_napi_env_hooks* hooks,
    uint64_t* accepted_hooks_out);
NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_release_env(
    unofficial_napi_env_owner owner,
    struct uv_loop_s* loop_or_null);

NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_collect_garbage(
    napi_env env);
NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_set_prepare_stack_trace_callback(
    napi_env env,
    napi_value callback);

typedef enum unofficial_napi_event_loop_checkpoint_mode {
  // Drain promise/microtask work without admitting a host task turn.
  unofficial_napi_event_loop_checkpoint_microtasks = 0,
  // Admit a host task turn as well as draining engine work. Host-JavaScript
  // providers suspend through JSPI. Synchronous providers report that no host
  // task was admitted so the runtime can wait on its native event source.
  unofficial_napi_event_loop_checkpoint_host_tasks = 1,
} unofficial_napi_event_loop_checkpoint_mode;

typedef enum unofficial_napi_event_loop_checkpoint_state {
  unofficial_napi_event_loop_checkpoint_state_none = 0,
  // The provider still owns work which can make JavaScript runnable.
  unofficial_napi_event_loop_checkpoint_state_pending_provider_work = 1 << 0,
  // The checkpoint admitted a host task turn. When this bit is absent, the
  // runtime remains responsible for waiting on its native event source.
  unofficial_napi_event_loop_checkpoint_state_host_tasks_admitted = 1 << 1,
} unofficial_napi_event_loop_checkpoint_state;

// Complete one provider-owned event-loop checkpoint. The mode describes Node
// semantics, while the provider owns how those semantics are implemented. The
// returned state distinguishes an asynchronous host turn from a synchronous
// engine checkpoint without requiring a separate provider-kind query.
NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_event_loop_checkpoint(
    napi_env env,
    unofficial_napi_event_loop_checkpoint_mode mode,
    bool has_runnable_work,
    uint32_t* state_out);
// Acquires an exact byte range for native access. The returned pointer remains
// valid until release, including across asynchronous native work. Readable
// ranges are copied from JavaScript on acquire; writable ranges are published
// back to JavaScript on release. This avoids treating every raw N-API pointer
// as a dirty copy of the value's entire backing store.
typedef enum unofficial_napi_buffer_access_mode {
  unofficial_napi_buffer_access_read = 1,
  unofficial_napi_buffer_access_write = 2,
  unofficial_napi_buffer_access_readwrite = 3,
} unofficial_napi_buffer_access_mode;
// Opaque ownership token for an exact native byte range. The token retains the
// JavaScript value and any provider-owned snapshot until release; callers must
// not derive the token from the returned data pointer or inspect its contents.
typedef struct unofficial_napi_buffer_lease__* unofficial_napi_buffer_lease;
NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_acquire_buffer_lease(
    napi_env env,
    napi_value value,
    size_t byte_offset,
    size_t byte_length,
    unofficial_napi_buffer_access_mode mode,
    unofficial_napi_buffer_lease* lease,
    void** data);
NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_release_buffer_lease(
    napi_env env, unofficial_napi_buffer_lease lease, bool modified);
// Creates a TypedArray whose backing store is guest WebAssembly memory. This
// is for native/JavaScript control blocks that require true shared visibility;
// bulk host-owned data should use scoped buffer access instead.
NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_create_guest_backed_typedarray(
    napi_env env,
    napi_typedarray_type type,
    size_t length,
    void** data,
    napi_value* result);
// Creates an ArrayBuffer using the provider's native ownership policy without
// exposing a raw pointer to Edge. Embedded providers may adopt an uninitialized
// native allocation; host-JavaScript providers allocate in the host engine and
// therefore may return zeroed storage when the engine has no unsafe allocator.
NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_create_uninitialized_arraybuffer(
    napi_env env,
    size_t length,
    bool zero_fill,
    napi_value* result);

// Unofficial helper. Terminates current JS execution in the env's engine.
// This is used for worker-style shutdown semantics where the process must
// survive but the current env must stop executing JS immediately.
NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_terminate_execution(napi_env env);
// Clears a previously requested engine termination on the current env. This is
// used when embedder code intentionally stops a worker but still needs the
// current JS stack to unwind normally.
NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_cancel_terminate_execution(napi_env env);

typedef void (*unofficial_napi_interrupt_callback)(napi_env env, void* data);

// Unofficial helper. Requests execution of a callback on the target env's
// engine thread at the next interrupt point. The callback runs entered into
// that env's isolate/context.
NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_request_interrupt(
    napi_env env,
    unofficial_napi_interrupt_callback callback,
    void* data);

// Unofficial helper. Enqueues a JS function into V8 microtask queue.
NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_enqueue_microtask(napi_env env, napi_value callback);

// Unofficial helper. Sets the per-env PromiseReject callback used by
// internal/process/promises via internalBinding('task_queue').
NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_set_promise_reject_callback(napi_env env,
                                                                    napi_value callback);

// Unofficial helper. Sets the per-env Promise lifecycle hooks used by
// internal/promise_hooks via internalBinding('async_wrap').
NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_set_promise_hooks(napi_env env,
                                                          napi_value init,
                                                          napi_value before,
                                                          napi_value after,
                                                          napi_value resolve);

typedef size_t (*unofficial_napi_near_heap_limit_callback)(
    napi_env env,
    void* data,
    size_t current_heap_limit,
    size_t initial_heap_limit);

// Atomically configures the environment's one near-heap-limit callback slot.
// A non-null callback installs or replaces the slot and requires
// `restored_heap_limit` to be zero. A null callback removes the slot, requires
// `data` to be null, and restores the provider heap limit to the supplied
// value.
NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_configure_near_heap_limit_callback(
    napi_env env,
    unofficial_napi_near_heap_limit_callback callback_or_null,
    void* data,
    size_t restored_heap_limit);
// Unofficial helpers used by util/options parity work in edge.
// These expose engine-specific data that is not available in the public N-API.
NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_get_promise_details(napi_env env,
                                                            napi_value promise,
                                                            int32_t* state_out,
                                                            napi_value* result_out,
                                                            bool* has_result_out);

typedef enum {
  unofficial_napi_error_metadata_current = 0,
  unofficial_napi_error_metadata_take_preserved = 1,
  unofficial_napi_error_metadata_positions_only = 2,
  // Return only the provider stack's "Thrown at" text. Unlike `current`, this
  // mode must not request source-map formatting or invoke embedder JavaScript.
  unofficial_napi_error_metadata_thrown_at_only = 3,
} unofficial_napi_error_metadata_mode;

typedef struct {
  napi_value source_line;
  napi_value script_resource_name;
  napi_value stderr_line;
  napi_value thrown_at;
  int32_t line_number;
  int32_t start_column;
  int32_t end_column;
} unofficial_napi_error_metadata;

// Unofficial helpers for Node-style exception/message parity.
// These expose engine message/source metadata that is not available in the
// public Node-API.
NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_get_error_metadata(
    napi_env env,
    napi_value error,
    unofficial_napi_error_metadata_mode mode,
    unofficial_napi_error_metadata* out);

// Preserve the current engine-generated source arrow/message for an Error
// object so later rethrows do not overwrite it with the rethrow callsite.
NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_preserve_error_source_message(
    napi_env env,
    napi_value error);
NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_configure_source_maps(
    napi_env env,
    bool enabled,
    napi_value callback);

// Unofficial helper used by module_wrap parity paths to tell the runtime's
// PromiseReject callback machinery that a rejected promise is being handled
// synchronously, matching Node's native ThrowIfPromiseRejected() helper.
NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_mark_promise_as_handled(
    napi_env env,
    napi_value promise);

NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_get_proxy_details(napi_env env,
                                                          napi_value proxy,
                                                          napi_value* target_out,
                                                          napi_value* handler_out);

NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_preview_entries(napi_env env,
                                                        napi_value value,
                                                        napi_value* entries_out,
                                                        bool* is_key_value_out);

NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_get_call_sites(napi_env env,
                                                       uint32_t frames,
                                                       napi_value* callsites_out);

NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_arraybuffer_view_has_buffer(napi_env env,
                                                                    napi_value value,
                                                                    bool* result_out);

NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_get_constructor_name(napi_env env,
                                                             napi_value value,
                                                             napi_value* name_out);

// Unofficial helper for Node's internalBinding('util').privateSymbols.
// Returns a JS-visible private symbol value backed by the engine's hidden
// private property machinery.
NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_create_private_symbol(napi_env env,
                                                              const char* utf8description,
                                                              size_t length,
                                                              napi_value* result_out);

// Unofficial helper for internalBinding('messaging').structuredClone().
// This mirrors the engine's structured clone path closely enough to preserve
// SharedArrayBuffer backing stores during clone/deserialization.
NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_structured_clone(
    napi_env env,
    napi_value value,
    napi_value transfer_list_or_null,
    napi_value* result_out);

// Opaque provider-owned message which may cross N-API environments. A message
// is consumed by message_take on both success and failure, or explicitly
// destroyed with message_drop while it is still queued.
typedef struct unofficial_napi_message__* unofficial_napi_message;

NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_message_create(
    napi_env env,
    napi_value value,
    unofficial_napi_message* message_out);

NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_message_take(
    napi_env env,
    unofficial_napi_message message,
    napi_value* result_out);

NAPI_EXTENSION_WASMER_EXTERN void unofficial_napi_message_drop(unofficial_napi_message message);

// Returns own property keys while filtering indexed elements inside the
// provider. This bulk operation avoids materializing every array index and
// crossing the guest/host boundary once per key.
NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_get_own_non_index_properties(
    napi_env env,
    napi_value value,
    uint32_t filter_bits,
    napi_value* result_out);

// Unofficial helper for Node's internalBinding('v8').getHashSeed().
NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_get_hash_seed(napi_env env,
                                                      uint64_t* hash_seed_out);

#define UNOFFICIAL_NAPI_HEAP_SPACE_NAME_MAX_LENGTH 64

typedef enum {
  unofficial_napi_heap_stat_total_heap_size = 1u << 0,
  unofficial_napi_heap_stat_total_heap_size_executable = 1u << 1,
  unofficial_napi_heap_stat_total_physical_size = 1u << 2,
  unofficial_napi_heap_stat_total_available_size = 1u << 3,
  unofficial_napi_heap_stat_used_heap_size = 1u << 4,
  unofficial_napi_heap_stat_heap_size_limit = 1u << 5,
  unofficial_napi_heap_stat_does_zap_garbage = 1u << 6,
  unofficial_napi_heap_stat_malloced_memory = 1u << 7,
  unofficial_napi_heap_stat_peak_malloced_memory = 1u << 8,
  unofficial_napi_heap_stat_number_of_native_contexts = 1u << 9,
  unofficial_napi_heap_stat_number_of_detached_contexts = 1u << 10,
  unofficial_napi_heap_stat_total_global_handles_size = 1u << 11,
  unofficial_napi_heap_stat_used_global_handles_size = 1u << 12,
  unofficial_napi_heap_stat_external_memory = 1u << 13,
  unofficial_napi_heap_stat_array_buffer_memory = 1u << 14,
  unofficial_napi_heap_stat_all = (1u << 15) - 1,
} unofficial_napi_heap_stat_field;

enum { UNOFFICIAL_NAPI_HEAP_STATISTICS_VERSION = 1 };

typedef struct {
  uint32_t size;
  uint32_t version;
  uint64_t valid_fields;
  uint64_t total_heap_size;
  uint64_t total_heap_size_executable;
  uint64_t total_physical_size;
  uint64_t total_available_size;
  uint64_t used_heap_size;
  uint64_t heap_size_limit;
  uint64_t does_zap_garbage;
  uint64_t malloced_memory;
  uint64_t peak_malloced_memory;
  uint64_t number_of_native_contexts;
  uint64_t number_of_detached_contexts;
  uint64_t total_global_handles_size;
  uint64_t used_global_handles_size;
  uint64_t external_memory;
  uint64_t array_buffer_memory;
} unofficial_napi_heap_statistics;

static inline void unofficial_napi_heap_statistics_init(
    unofficial_napi_heap_statistics* stats) {
  if (stats == NULL) return;
#ifdef __cplusplus
  *stats = {};
#else
  *stats = (unofficial_napi_heap_statistics){0};
#endif
  stats->size = sizeof(*stats);
  stats->version = UNOFFICIAL_NAPI_HEAP_STATISTICS_VERSION;
}

// Providers identify measured fields through `valid_fields`; unsupported
// fields have no provider-neutral meaning. Consumers that expose a dense
// Node-compatible object should normalize once at the boundary instead of
// accidentally treating provider scratch values as observations.
static inline void unofficial_napi_heap_statistics_normalize(
    unofficial_napi_heap_statistics* stats) {
  if (stats == NULL) return;
#define UNOFFICIAL_NAPI_NORMALIZE_HEAP_FIELD(bit, field) \
  do {                                                   \
    if ((stats->valid_fields & (bit)) == 0) {           \
      stats->field = 0;                                 \
    }                                                    \
  } while (0)
  UNOFFICIAL_NAPI_NORMALIZE_HEAP_FIELD(
      unofficial_napi_heap_stat_total_heap_size, total_heap_size);
  UNOFFICIAL_NAPI_NORMALIZE_HEAP_FIELD(
      unofficial_napi_heap_stat_total_heap_size_executable,
      total_heap_size_executable);
  UNOFFICIAL_NAPI_NORMALIZE_HEAP_FIELD(
      unofficial_napi_heap_stat_total_physical_size, total_physical_size);
  UNOFFICIAL_NAPI_NORMALIZE_HEAP_FIELD(
      unofficial_napi_heap_stat_total_available_size, total_available_size);
  UNOFFICIAL_NAPI_NORMALIZE_HEAP_FIELD(
      unofficial_napi_heap_stat_used_heap_size, used_heap_size);
  UNOFFICIAL_NAPI_NORMALIZE_HEAP_FIELD(
      unofficial_napi_heap_stat_heap_size_limit, heap_size_limit);
  UNOFFICIAL_NAPI_NORMALIZE_HEAP_FIELD(
      unofficial_napi_heap_stat_does_zap_garbage, does_zap_garbage);
  UNOFFICIAL_NAPI_NORMALIZE_HEAP_FIELD(
      unofficial_napi_heap_stat_malloced_memory, malloced_memory);
  UNOFFICIAL_NAPI_NORMALIZE_HEAP_FIELD(
      unofficial_napi_heap_stat_peak_malloced_memory, peak_malloced_memory);
  UNOFFICIAL_NAPI_NORMALIZE_HEAP_FIELD(
      unofficial_napi_heap_stat_number_of_native_contexts,
      number_of_native_contexts);
  UNOFFICIAL_NAPI_NORMALIZE_HEAP_FIELD(
      unofficial_napi_heap_stat_number_of_detached_contexts,
      number_of_detached_contexts);
  UNOFFICIAL_NAPI_NORMALIZE_HEAP_FIELD(
      unofficial_napi_heap_stat_total_global_handles_size,
      total_global_handles_size);
  UNOFFICIAL_NAPI_NORMALIZE_HEAP_FIELD(
      unofficial_napi_heap_stat_used_global_handles_size,
      used_global_handles_size);
  UNOFFICIAL_NAPI_NORMALIZE_HEAP_FIELD(
      unofficial_napi_heap_stat_external_memory, external_memory);
  UNOFFICIAL_NAPI_NORMALIZE_HEAP_FIELD(
      unofficial_napi_heap_stat_array_buffer_memory, array_buffer_memory);
  stats->valid_fields &= unofficial_napi_heap_stat_all;
#undef UNOFFICIAL_NAPI_NORMALIZE_HEAP_FIELD
}

typedef struct {
  char space_name[UNOFFICIAL_NAPI_HEAP_SPACE_NAME_MAX_LENGTH];
  uint64_t space_size;
  uint64_t space_used_size;
  uint64_t space_available_size;
  uint64_t physical_space_size;
} unofficial_napi_heap_space_statistics;

typedef struct {
  uint64_t code_and_metadata_size;
  uint64_t bytecode_and_metadata_size;
  uint64_t external_script_source_size;
  uint64_t cpu_profiler_metadata_size;
} unofficial_napi_heap_code_statistics;

typedef struct unofficial_napi_profile__* unofficial_napi_profile;

typedef enum {
  unofficial_napi_profile_cpu = 1,
  unofficial_napi_profile_heap = 2,
} unofficial_napi_profile_kind;

typedef enum {
  unofficial_napi_profile_start_ok = 0,
  unofficial_napi_profile_start_busy = 1,
} unofficial_napi_profile_start_result;

typedef struct {
  bool expose_internals;
  bool expose_numeric_values;
} unofficial_napi_heap_snapshot_options;

NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_get_heap_statistics(
    napi_env env,
    unofficial_napi_heap_statistics* stats_out);

// Takes one provider snapshot, writes at most `capacity` entries, and reports
// the snapshot's full entry count through `count_out`. A null `stats_out` is
// valid only when `capacity` is zero, allowing callers to query capacity.
NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_get_heap_space_statistics(
    napi_env env,
    unofficial_napi_heap_space_statistics* stats_out,
    uint32_t capacity,
    uint32_t* count_out);

NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_get_heap_code_statistics(
    napi_env env,
    unofficial_napi_heap_code_statistics* stats_out);

// Unofficial helpers for worker-thread profiling/snapshot support. These must
// be called on the target env's engine thread, typically from
// unofficial_napi_request_interrupt(). A successful start returns one opaque,
// env-owned session. Stop leaves the session active when it returns
// napi_cannot_run_js, so the caller can retry from the target engine thread.
// Once stop accepts the thread/env preconditions it consumes the session even
// if producing the final result fails. Diagnostic JSON is returned as UTF-8
// bytes in a Uint8Array whose backing store is outside the inspected heap.
// Sessions still active at env teardown are stopped and released by the
// provider.
NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_profile_start(
    napi_env env,
    unofficial_napi_profile_kind kind,
    unofficial_napi_profile_start_result* result_out,
    unofficial_napi_profile* profile_out);

NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_profile_stop(
    napi_env env,
    unofficial_napi_profile profile,
    napi_value* utf8_json_out);

NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_take_heap_snapshot(
    napi_env env,
    const unofficial_napi_heap_snapshot_options* options,
    napi_value* utf8_json_out);

// Unofficial helpers for Node's async_context_frame parity. These expose the
// engine continuation-preserved embedder data used by AsyncContextFrame.
NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_get_continuation_preserved_embedder_data(
    napi_env env,
    napi_value* result_out);

NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_set_continuation_preserved_embedder_data(
    napi_env env,
    napi_value value);

// Unofficial helper. Refreshes V8 date/timezone configuration after TZ changes.
NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_notify_datetime_configuration_change(napi_env env);

// Unofficial helper. Creates the native internalBinding('serdes') object
// containing Serializer and Deserializer constructors.
NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_create_serdes_binding(napi_env env,
                                                              napi_value* result_out);

// Unofficial helpers for implementing internalBinding('contextify') on embedders.
// These are engine-specific APIs and are not part of the public Node-API.
NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_contextify_make_context(
    napi_env env,
    napi_value sandbox_or_symbol,
    napi_value name,
    napi_value origin_or_undefined,
    bool allow_code_gen_strings,
    bool allow_code_gen_wasm,
    bool own_microtask_queue,
    napi_value host_defined_option_id,
    napi_value* result_out);

// Provider-owned compiled JavaScript. The handle is bound to its creating
// environment and must be released explicitly.
typedef struct unofficial_napi_bytecode__* unofficial_napi_bytecode;

// A tagged JS source for compile/eval APIs. Providers reject descriptors whose
// selected field is null or whose unselected field is non-null.
typedef enum {
  unofficial_napi_js_source_text = 0,
  unofficial_napi_js_source_bytecode = 1,
} unofficial_napi_js_source_kind;

typedef struct unofficial_napi_js_source {
  int32_t kind;
  napi_value text;
  unofficial_napi_bytecode bytecode;
} unofficial_napi_js_source;

static inline bool unofficial_napi_js_source_is_valid(
    const unofficial_napi_js_source* source) {
  return source != NULL &&
         ((source->kind == unofficial_napi_js_source_text &&
           source->text != NULL && source->bytecode == NULL) ||
          (source->kind == unofficial_napi_js_source_bytecode &&
           source->text == NULL && source->bytecode != NULL));
}

static inline unofficial_napi_js_source unofficial_napi_js_source_from_text(
    napi_value text) {
  unofficial_napi_js_source source = {
      unofficial_napi_js_source_text, text, NULL};
  return source;
}

static inline unofficial_napi_js_source unofficial_napi_js_source_from_bytecode(
    unofficial_napi_bytecode bytecode) {
  unofficial_napi_js_source source = {
      unofficial_napi_js_source_bytecode, NULL, bytecode};
  return source;
}

// Compile shape of a bytecode artifact; bytecode is only usable by APIs that
// compile the same shape.
typedef enum {
  unofficial_napi_bytecode_shape_script = 0,        // whole-script eval
  unofficial_napi_bytecode_shape_cjs_function = 1,  // function compiled with params
  unofficial_napi_bytecode_shape_module = 2,        // ES module
} unofficial_napi_bytecode_shape;

// Versioned input for opening a compiled artifact. When `has_cache` is nonzero,
// the provider first validates the supplied bytes against every compile input.
// `cache_policy` determines whether a rejected cache is atomically replaced
// by compiling source or reported without the discarded fallback compile.
typedef enum {
  unofficial_napi_bytecode_cache_compile_on_reject = 0,
  unofficial_napi_bytecode_cache_validate_only = 1,
} unofficial_napi_bytecode_cache_policy;
#define UNOFFICIAL_NAPI_BYTECODE_OPEN_OPTIONS_VERSION 1u
typedef struct unofficial_napi_bytecode_open_options {
  uint32_t size;
  uint32_t version;
  napi_value source_text;
  napi_value filename;
  int32_t shape;
  napi_value params_or_undefined;
  napi_value host_defined_option_id;
  int32_t line_offset;
  int32_t column_offset;
  const uint8_t* cache_bytes;
  size_t cache_byte_length;
  uint8_t has_cache;
  uint8_t cache_policy;
} unofficial_napi_bytecode_open_options;

typedef struct unofficial_napi_bytecode_open_result {
  unofficial_napi_bytecode bytecode;
  uint8_t cache_rejected;
  uint8_t can_parse_as_module;
} unofficial_napi_bytecode_open_result;

NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_bytecode_open(
    napi_env env,
    const unofficial_napi_bytecode_open_options* options,
    unofficial_napi_bytecode_open_result* result);

// Engine bytes for persistence, as a Uint8Array (V8: raw CachedData;
// QuickJS: self-validating QJSB header [shape, source, params, filename,
// payload hashes] + JS_WriteObject output).
NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_bytecode_serialize(
    napi_env env,
    unofficial_napi_bytecode bytecode,
    napi_value* buffer_out);

NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_bytecode_release(
    napi_env env,
    unofficial_napi_bytecode bytecode);

NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_contextify_run_script(
    napi_env env,
    napi_value sandbox_or_null,
    const unofficial_napi_js_source* source,
    napi_value filename,
    int32_t line_offset,
    int32_t column_offset,
    int64_t timeout,
    bool display_errors,
    bool break_on_sigint,
    bool break_on_first_line,
    napi_value host_defined_option_id,
    napi_value* result_out);

NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_contextify_compile_function(
    napi_env env,
    const unofficial_napi_js_source* source,
    napi_value filename,
    int32_t line_offset,
    int32_t column_offset,
    napi_value parsing_context_or_undefined,
    napi_value context_extensions_or_undefined,
    napi_value params_or_undefined,
    napi_value host_defined_option_id,
    napi_value* result_out);

NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_contextify_contains_module_syntax(
    napi_env env,
    napi_value code,
    napi_value filename,
    napi_value resource_name_or_undefined,
    bool cjs_var_in_scope,
    bool* result_out);

// Unofficial helpers for implementing internalBinding('module_wrap') on embedders.
// These keep V8 module objects behind an opaque native handle so bindings stay N-API only.
typedef struct unofficial_napi_module__* unofficial_napi_module;

// Versioned, tagged transaction for creating either kind of module. Keeping
// creation behind one descriptor gives providers one validation boundary and
// lets the ABI grow without adding one import per module kind.
#define UNOFFICIAL_NAPI_MODULE_CREATE_OPTIONS_VERSION 1u

typedef enum {
  unofficial_napi_module_source_text = 1,
  unofficial_napi_module_synthetic = 2,
} unofficial_napi_module_kind;

typedef struct {
  const unofficial_napi_js_source* source;
  int32_t line_offset;
  int32_t column_offset;
  napi_value host_defined_option_id;
} unofficial_napi_source_text_module_options;

typedef struct {
  napi_value export_names;
  napi_value synthetic_evaluation_steps;
} unofficial_napi_synthetic_module_options;

typedef struct {
  size_t size;
  uint32_t version;
  unofficial_napi_module_kind kind;
  napi_value wrapper;
  napi_value url;
  napi_value context_or_undefined;
  union {
    unofficial_napi_source_text_module_options source_text;
    unofficial_napi_synthetic_module_options synthetic;
  } payload;
} unofficial_napi_module_create_options;

// Immutable metadata produced by the same transaction that creates a module.
// The layout is selected by options.version, so adding fields requires a new
// create-options version rather than another query function.
typedef struct {
  unofficial_napi_module module;
  napi_value module_requests;
  bool has_top_level_await;
} unofficial_napi_module_create_result;

NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_module_wrap_create(
    napi_env env,
    const unofficial_napi_module_create_options* options,
    unofficial_napi_module_create_result* result_out);

NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_module_wrap_destroy(
    napi_env env,
    unofficial_napi_module module);

NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_module_wrap_link(
    napi_env env,
    unofficial_napi_module module,
    size_t count,
    const unofficial_napi_module* linked_modules);

NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_module_wrap_instantiate(
    napi_env env,
    unofficial_napi_module module);

NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_module_wrap_evaluate(
    napi_env env,
    unofficial_napi_module module,
    int64_t timeout,
    bool break_on_sigint,
    napi_value* result_out);

NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_module_wrap_evaluate_sync(
    napi_env env,
    unofficial_napi_module module,
    napi_value filename,
    napi_value parent_filename,
    napi_value* result_out);

NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_module_wrap_get_namespace(
    napi_env env,
    unofficial_napi_module module,
    napi_value* result_out);

// Returns the requested fields from one observation of the provider-owned
// module record. At least one output must be non-null. Expensive fields are
// computed only when requested; has_async_graph is false before instantiation.
NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_module_wrap_get_state(
    napi_env env,
    unofficial_napi_module module,
    int32_t* status_out,
    napi_value* error_out,
    bool* has_async_graph_out);

NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_module_wrap_check_unsettled_top_level_await(
    napi_env env,
    unofficial_napi_module module,
    bool warnings,
    bool* settled_out);

NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_module_wrap_set_export(
    napi_env env,
    unofficial_napi_module module,
    napi_value export_name,
    napi_value export_value);

NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_module_wrap_set_module_source_object(
    napi_env env,
    unofficial_napi_module module,
    napi_value source_object);

NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_module_wrap_get_module_source_object(
    napi_env env,
    unofficial_napi_module module,
    napi_value* result_out);

NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_module_wrap_create_cached_data(
    napi_env env,
    unofficial_napi_module module,
    napi_value* result_out);

#define UNOFFICIAL_NAPI_MODULE_HOOKS_VERSION 1u

typedef struct {
  size_t size;
  uint32_t version;
  napi_value import_module_dynamically;
  napi_value initialize_import_meta_object;
} unofficial_napi_module_hooks;

NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_module_wrap_set_hooks(
    napi_env env,
    const unofficial_napi_module_hooks* hooks);

NAPI_EXTENSION_WASMER_EXTERN napi_status unofficial_napi_module_wrap_create_required_module_facade(
    napi_env env,
    unofficial_napi_module module,
    napi_value* result_out);

#include "unofficial_napi_wasm32_abi.h"

#if defined(__wasm32__)
#if defined(__cplusplus)
static_assert(sizeof(unofficial_napi_env_create_options) ==
              sizeof(unofficial_napi_wasm32_env_create_options_v1));
static_assert(sizeof(unofficial_napi_runtime_options) ==
              sizeof(unofficial_napi_wasm32_runtime_options_v1));
static_assert(sizeof(unofficial_napi_env_hooks) ==
              sizeof(unofficial_napi_wasm32_env_hooks_v1));
static_assert(sizeof(unofficial_napi_js_source) ==
              sizeof(unofficial_napi_wasm32_js_source));
static_assert(sizeof(unofficial_napi_bytecode_open_options) ==
              sizeof(unofficial_napi_wasm32_bytecode_open_options_v1));
static_assert(sizeof(unofficial_napi_module_create_options) ==
              sizeof(unofficial_napi_wasm32_module_create_options_v1));
static_assert(sizeof(unofficial_napi_module_hooks) ==
              sizeof(unofficial_napi_wasm32_module_hooks_v1));
#else
_Static_assert(sizeof(unofficial_napi_env_create_options) ==
                   sizeof(unofficial_napi_wasm32_env_create_options_v1),
               "public env-create layout differs from its wasm32 wire ABI");
_Static_assert(sizeof(unofficial_napi_runtime_options) ==
                   sizeof(unofficial_napi_wasm32_runtime_options_v1),
               "public runtime-options layout differs from its wasm32 wire ABI");
_Static_assert(sizeof(unofficial_napi_env_hooks) ==
                   sizeof(unofficial_napi_wasm32_env_hooks_v1),
               "public env-hooks layout differs from its wasm32 wire ABI");
_Static_assert(sizeof(unofficial_napi_js_source) ==
                   sizeof(unofficial_napi_wasm32_js_source),
               "public JS-source layout differs from its wasm32 wire ABI");
_Static_assert(sizeof(unofficial_napi_bytecode_open_options) ==
                   sizeof(unofficial_napi_wasm32_bytecode_open_options_v1),
               "public bytecode-open layout differs from its wasm32 wire ABI");
_Static_assert(sizeof(unofficial_napi_module_create_options) ==
                   sizeof(unofficial_napi_wasm32_module_create_options_v1),
               "public module-create layout differs from its wasm32 wire ABI");
_Static_assert(sizeof(unofficial_napi_module_hooks) ==
                   sizeof(unofficial_napi_wasm32_module_hooks_v1),
               "public module-hooks layout differs from its wasm32 wire ABI");
#endif
#endif

#ifdef __cplusplus
}  // extern "C"
#endif

#endif  // UNOFFICIAL_NAPI_H_
