#ifndef NAPI_QUICKJS_INTERNAL_NAPI_PROMISES_H_
#define NAPI_QUICKJS_INTERNAL_NAPI_PROMISES_H_

#include "../../../include/js_native_api.h"
#include "../../../include/node_api_types.h"

#include <quickjs.h>

#include <array>
#include <unordered_map>
#include <vector>

class napi_promises__
{
public:
  napi_promises__(napi_env env, JSContext *context);
  ~napi_promises__();

  void teardown();

  void attach_runtime_hooks();
  void clear_runtime_hooks();
  void update_rejection_tracker();

  napi_status set_reject_callback(napi_value callback);
  bool has_reject_callback() const;
  JSValue dup_reject_callback() const;

  napi_status set_hooks(napi_value init,
                        napi_value before,
                        napi_value after,
                        napi_value resolve);
  JSValue dup_hook(size_t index) const;

  JSValueConst continuation_preserved_embedder_data() const;
  void set_continuation_preserved_embedder_data(JSValueConst value);
  void capture_context_frame(JSValueConst promise);
  void enter_context_frame(JSValueConst promise);
  void leave_context_frame(JSValueConst promise);
  void release_context_frame(JSValueConst promise);

  static JSValue microtask_job(JSContext *ctx, int argc, JSValueConst *argv);
  static void promise_hook(JSContext *ctx,
                           JSPromiseHookType type,
                           JSValueConst promise,
                           JSValueConst parent_promise,
                           void *opaque);
  static void rejection_tracker(JSContext *ctx,
                                JSValueConst promise,
                                JSValueConst reason,
                                bool is_handled,
                                void *opaque);

private:
  napi_status set_optional_function(napi_value value, JSValue *target);
  void replace_stored_value(JSValue *target, JSValueConst value);
  void clear_stored_values();
  void call_hook(JSValueConst hook, int argc, JSValueConst *argv);
  void clear_pending_exception_if_any();
  bool is_active() const;

  // Owning environment and QuickJS context.
  napi_env env_ = nullptr;
  JSContext *context_ = nullptr;

  // Promise reject callback and lifecycle hooks.
  JSValue promise_reject_callback_;
  std::array<JSValue, 4> promise_hooks_;

  // Continuation and async context tracking.
  JSValue continuation_preserved_embedder_data_;
  std::unordered_map<void *, JSValue> promise_context_frames_;
  std::vector<JSValue> promise_context_frame_stack_;

  // Subsystem lifecycle.
  bool torn_down_ = false;
};

#endif // NAPI_QUICKJS_INTERNAL_NAPI_PROMISES_H_
