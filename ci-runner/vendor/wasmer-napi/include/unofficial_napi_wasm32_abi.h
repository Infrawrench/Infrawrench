#ifndef UNOFFICIAL_NAPI_WASM32_ABI_H_
#define UNOFFICIAL_NAPI_WASM32_ABI_H_

#include <stddef.h>
#include <stdint.h>

// Fixed-width representations observed by Wasmer when Edge is compiled for
// wasm32. These are a wire contract, not native provider implementation types.
// Every pointer and size_t in the public C API is represented by one u32 here.
typedef struct {
  uint32_t size;
  uint32_t version;
  uint32_t engine_flags;
  uint32_t engine_flags_length;
} unofficial_napi_wasm32_runtime_options_v1;

typedef struct {
  uint32_t size;
  uint32_t version;
  uint64_t total_memory;
  uint64_t constrained_memory;
  uint32_t max_young_generation_size_in_bytes;
  uint32_t max_old_generation_size_in_bytes;
  uint32_t code_range_size_in_bytes;
  uint32_t stack_limit;
  uint32_t guest_heap;
} unofficial_napi_wasm32_env_create_options_v1;

typedef struct {
  uint32_t size;
  uint32_t version;
  uint32_t data;
  uint32_t context_token_assign_callback;
  uint32_t context_token_unassign_callback;
  uint32_t enqueue_foreground_task_callback;
  uint32_t fatal_error_callback;
  uint32_t oom_error_callback;
} unofficial_napi_wasm32_env_hooks_v1;

typedef struct {
  int32_t kind;
  uint32_t text;
  uint32_t bytecode;
} unofficial_napi_wasm32_js_source;

typedef struct {
  uint32_t size;
  uint32_t version;
  uint32_t source_text;
  uint32_t filename;
  int32_t shape;
  uint32_t params_or_undefined;
  uint32_t host_defined_option_id;
  int32_t line_offset;
  int32_t column_offset;
  uint32_t cache_bytes;
  uint32_t cache_byte_length;
  uint8_t has_cache;
  uint8_t cache_policy;
  uint8_t reserved[2];
} unofficial_napi_wasm32_bytecode_open_options_v1;

typedef struct {
  uint32_t size;
  uint32_t version;
  int32_t kind;
  uint32_t wrapper;
  uint32_t url;
  uint32_t context_or_undefined;
  uint8_t payload[16];
} unofficial_napi_wasm32_module_create_options_v1;

typedef struct {
  uint32_t size;
  uint32_t version;
  uint32_t import_module_dynamically;
  uint32_t initialize_import_meta_object;
} unofficial_napi_wasm32_module_hooks_v1;

#if defined(__cplusplus)
static_assert(sizeof(unofficial_napi_wasm32_runtime_options_v1) == 16);
static_assert(sizeof(unofficial_napi_wasm32_env_create_options_v1) == 48);
static_assert(sizeof(unofficial_napi_wasm32_env_hooks_v1) == 32);
static_assert(sizeof(unofficial_napi_wasm32_js_source) == 12);
static_assert(sizeof(unofficial_napi_wasm32_bytecode_open_options_v1) == 48);
static_assert(sizeof(unofficial_napi_wasm32_module_create_options_v1) == 40);
static_assert(sizeof(unofficial_napi_wasm32_module_hooks_v1) == 16);
#else
_Static_assert(sizeof(unofficial_napi_wasm32_runtime_options_v1) == 16,
               "wasm32 runtime-options wire layout changed");
_Static_assert(sizeof(unofficial_napi_wasm32_env_create_options_v1) == 48,
               "wasm32 env-create wire layout changed");
_Static_assert(sizeof(unofficial_napi_wasm32_env_hooks_v1) == 32,
               "wasm32 env-hooks wire layout changed");
_Static_assert(sizeof(unofficial_napi_wasm32_js_source) == 12,
               "wasm32 JS-source wire layout changed");
_Static_assert(sizeof(unofficial_napi_wasm32_bytecode_open_options_v1) == 48,
               "wasm32 bytecode-open wire layout changed");
_Static_assert(sizeof(unofficial_napi_wasm32_module_create_options_v1) == 40,
               "wasm32 module-create wire layout changed");
_Static_assert(sizeof(unofficial_napi_wasm32_module_hooks_v1) == 16,
               "wasm32 module-hooks wire layout changed");
#endif

#endif  // UNOFFICIAL_NAPI_WASM32_ABI_H_
