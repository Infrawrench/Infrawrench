#ifndef NAPI_QUICKJS_ENV_H_
#define NAPI_QUICKJS_ENV_H_

#include "../../../include/js_native_api.h"
#include "../../../include/node_api_types.h"
#include "../../../include/unofficial_napi.h"
#include "napi_callback_info.h"
#include "napi_buffer.h"
#include "napi_contextify.h"
#include "napi_deferred.h"
#include "napi_env_cleanup_hook.h"
#include "napi_external_backing_store_hint.h"
#include "napi_module_wrap.h"
#include "napi_promises.h"
#include "napi_ref.h"
#include "napi_scope.h"
#include "napi_value.h"
#include "napi_error_state.h"
#include "napi_periodic_gate.h"

#include <cstdint>
#include <string>
#include <utility>
#include <vector>
#include <quickjs.h>

struct napi_external_backing_store_hint__;

struct napi_env__
{
  explicit napi_env__(JSContext *context, int32_t module_api_version);
  ~napi_env__();

  void prepare_teardown();
  void finalize_instance_data();

  JSContext *context() const;
  JSContext *main_context() const;
  JSContext *current_context() const;
  void set_current_context(JSContext *context);
  int32_t module_api_version() const;

  napi_handle_scope root_scope() const;
  napi_handle_scope current_scope() const;
  napi_handle_scope create_scope(napi_handle_scope parent);
  void destroy_scope(napi_handle_scope scope);
  napi_scope__ *scope_from_handle(napi_handle_scope scope) const;
  napi_value wrap_value_in_current_scope(JSValue value, bool owned);
  napi_value wrap_value_in_current_scope(JSContext *context, JSValue value, bool owned);
  JSValue wrap_external_data(void *data);
  JSValue wrap_external_data(void *data, node_api_basic_finalize finalize_cb, void *finalize_hint);
  napi_value__ *value_from_handle(napi_value value);
  void delete_value_from_current_scope(napi_value value);
  napi_ref wrap_ref_in_root_scope(JSValueConst value, uint32_t initial_ref_count);
  void delete_ref_from_root_scope(napi_ref ref);
  napi_ref__ *ref_from_handle(napi_ref ref);
  size_t ref_storage_slot_count() const;
  size_t active_ref_count() const;
  bool is_current_scope(napi_handle_scope scope) const;
  void set_current_scope(napi_handle_scope scope);
  size_t scope_storage_slot_count() const;
  size_t active_scope_count() const;

  template <typename Fn>
  void for_each_active_scope(Fn fn) const
  {
    for (const auto &scope : scopes_)
      fn(scope);
  }

  template <typename Fn>
  void for_each_active_ref(Fn fn) const
  {
    for (const auto &ref : refs_)
      fn(ref);
  }

#if defined(NAPI_ENABLE_LIFETIME_TRACKER) && defined(NAPI_ENABLE_LIFETIME_PERIODIC_STATS)
  bool should_dump_lifetime_stats(int64_t now_ms);
  bool should_dump_lifetime_string_symbol_values(int64_t now_ms);
#endif

  const napi_extended_error_info *last_error_info() const;
  napi_status set_last_error(napi_status status, const char *message);
  napi_status clear_last_error();

  bool has_last_exception() const;
  void clear_last_exception();
  void set_last_exception(JSValue exception);
  JSValue take_last_exception();

  void *instance_data() const;
  void set_instance_data(void *data, napi_finalize finalize_cb, void *finalize_hint);

  napi_status add_cleanup_hook(napi_cleanup_hook hook, void *arg);
  napi_status remove_cleanup_hook(napi_cleanup_hook hook, void *arg);
  napi_env_cleanup_hook__ *create_cleanup_hook(napi_cleanup_hook hook, void *arg);
  void destroy_cleanup_hook(napi_env_cleanup_hook__ *entry);
  napi_deferred__ *create_deferred(JSContext *context, JSValue resolve, JSValue reject);
  void destroy_deferred(napi_deferred__ *deferred);
  napi_external_backing_store_hint__ *create_external_backing_store(
      void *external_data,
      node_api_basic_finalize finalize_cb,
      void *finalize_hint);
  void destroy_external_backing_store(napi_external_backing_store_hint__ *hint);
  int64_t adjust_external_memory(int64_t change_in_bytes);

  napi_promises__ &promises();
  const napi_promises__ &promises() const;
  napi_buffer__ &buffers();
  const napi_buffer__ &buffers() const;
  quickjs::detail::napi_contextify__ &contextify();
  const quickjs::detail::napi_contextify__ &contextify() const;
  quickjs::detail::napi_module_wrap__ &module_wrap();
  const quickjs::detail::napi_module_wrap__ &module_wrap() const;

  bool attach_embedder_hooks(const unofficial_napi_env_hooks &hooks)
  {
    if (embedder_hooks_attached_)
      return false;
    embedder_hooks_ = hooks;
    embedder_hooks_attached_ = true;
    return true;
  }

private:
  void clear_refs_for_teardown();

  // QuickJS contexts and API version.
  JSContext *main_context_;
  JSContext *current_context_;
  int32_t module_api_version_ = 8;

  // Last native/JS error state.
  napi::error_state__ error_state_;
  JSContext *last_exception_context_ = nullptr;
  JSValue last_exception_;
  bool has_last_exception_ = false;

  // Instance data finalizer.
  void *instance_data_ = nullptr;
  napi_finalize instance_data_finalize_cb_ = nullptr;
  void *instance_data_finalize_hint_ = nullptr;

  // Cleanup hooks in registration order.
  std::vector<napi_env_cleanup_hook__ *> env_cleanup_hooks_;

  // Scope stack.
  napi_handle_scope root_scope_ = nullptr;
  napi_handle_scope current_scope_ = nullptr;

  // Env-owned slot allocators.
  napi_allocator__<napi_scope__, napi_env__> scopes_;
  napi_allocator__<napi_ref__, napi_env__> refs_;
  napi_allocator__<napi_env_cleanup_hook__, napi_env__> cleanup_hooks_;
  napi_allocator__<napi_deferred__, napi_env__> deferreds_;
  napi_allocator__<napi_external_backing_store_hint__, napi_env__> external_backing_stores_;

#if defined(NAPI_ENABLE_LIFETIME_TRACKER) && defined(NAPI_ENABLE_LIFETIME_PERIODIC_STATS)
  // Periodic lifetime dump scheduling.
  napi::periodic_gate__ lifetime_stats_gate_{2000};
  napi::periodic_gate__ lifetime_string_symbol_values_gate_{10000};
#endif

  // External memory accounting.
  int64_t external_memory_ = 0;

  // Env-owned subsystems.
  napi_buffer__ buffers_;
  napi_promises__ promises_;
  quickjs::detail::napi_contextify__ contextify_;
  quickjs::detail::napi_module_wrap__ module_wrap_;

  // Env teardown state.
  bool torn_down_ = false;
  bool clearing_refs_for_teardown_ = false;
  bool embedder_hooks_attached_ = false;
  unofficial_napi_env_hooks embedder_hooks_{};
};

class napi_env_context_scope__
{
public:
  napi_env_context_scope__(napi_env env, JSContext *context);
  ~napi_env_context_scope__();

  napi_env_context_scope__(const napi_env_context_scope__ &) = delete;
  napi_env_context_scope__ &operator=(const napi_env_context_scope__ &) = delete;

private:
  napi_env env_ = nullptr;
  JSContext *previous_ = nullptr;
};

napi_status napi_quickjs_set_last_error(napi_env env,
                                        napi_status status,
                                        const char *message);

napi_status napi_quickjs_clear_last_error(napi_env env);

#endif // NAPI_QUICKJS_ENV_H_
