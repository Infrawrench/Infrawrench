#include "internal/napi_promises.h"

#include "internal/napi_env.h"
#include "internal/napi_value.h"

namespace
{
void *js_identity(JSValueConst value)
{
  return JS_IsObject(value) ? JS_VALUE_GET_PTR(value) : nullptr;
}

bool is_same_runtime(napi_env env, JSContext *ctx)
{
  return env != nullptr &&
         ctx != nullptr &&
         env->main_context() != nullptr &&
         JS_GetRuntime(ctx) == JS_GetRuntime(env->main_context());
}
}

napi_promises__::napi_promises__(napi_env env, JSContext *context)
    : env_{env},
      context_{context},
      promise_reject_callback_{JS_UNDEFINED},
      promise_hooks_{JS_UNDEFINED, JS_UNDEFINED, JS_UNDEFINED, JS_UNDEFINED},
      continuation_preserved_embedder_data_{JS_UNDEFINED}
{
}

napi_promises__::~napi_promises__()
{
  teardown();
}

void napi_promises__::teardown()
{
  if (torn_down_)
    return;
  clear_runtime_hooks();
  clear_stored_values();
  torn_down_ = true;
}

bool napi_promises__::is_active() const
{
  return !torn_down_ && env_ != nullptr && context_ != nullptr;
}

void napi_promises__::attach_runtime_hooks()
{
  if (!is_active())
    return;
  JSRuntime *runtime = JS_GetRuntime(context_);
  JS_SetPromiseHook(runtime, napi_promises__::promise_hook, env_);
}

void napi_promises__::clear_runtime_hooks()
{
  if (context_ == nullptr)
    return;
  JSRuntime *runtime = JS_GetRuntime(context_);
  JS_SetPromiseHook(runtime, nullptr, nullptr);
  JS_SetHostPromiseRejectionTracker(runtime, nullptr, nullptr);
}

void napi_promises__::update_rejection_tracker()
{
  if (!is_active())
    return;
  JS_SetHostPromiseRejectionTracker(
      JS_GetRuntime(context_),
      has_reject_callback() ? napi_promises__::rejection_tracker : nullptr,
      env_);
}

napi_status napi_promises__::set_optional_function(napi_value value, JSValue *target)
{
  if (target == nullptr)
    return napi_invalid_arg;

  if (value != nullptr &&
      !JS_IsUndefined(napi_quickjs_value_inner(env_, value)) &&
      !JS_IsNull(napi_quickjs_value_inner(env_, value)) &&
      !JS_IsFunction(context_, napi_quickjs_value_inner(env_, value)))
  {
    return napi_function_expected;
  }

  JSValue replacement = JS_UNDEFINED;
  if (value != nullptr &&
      !JS_IsUndefined(napi_quickjs_value_inner(env_, value)) &&
      !JS_IsNull(napi_quickjs_value_inner(env_, value)))
  {
    replacement = JS_DupValue(context_, napi_quickjs_value_inner(env_, value));
  }

  JS_FreeValue(context_, *target);
  *target = replacement;
  return napi_ok;
}

void napi_promises__::replace_stored_value(JSValue *target, JSValueConst value)
{
  JS_FreeValue(context_, *target);
  *target = JS_DupValue(context_, value);
}

void napi_promises__::clear_stored_values()
{
  JS_FreeValue(context_, promise_reject_callback_);
  promise_reject_callback_ = JS_UNDEFINED;

  for (auto &hook : promise_hooks_)
  {
    JS_FreeValue(context_, hook);
    hook = JS_UNDEFINED;
  }

  JS_FreeValue(context_, continuation_preserved_embedder_data_);
  continuation_preserved_embedder_data_ = JS_UNDEFINED;

  for (auto &entry : promise_context_frames_)
    JS_FreeValue(context_, entry.second);
  promise_context_frames_.clear();

  for (auto &frame : promise_context_frame_stack_)
    JS_FreeValue(context_, frame);
  promise_context_frame_stack_.clear();
}

void napi_promises__::clear_pending_exception_if_any()
{
  if (context_ == nullptr || !JS_HasException(context_))
    return;
  JSValue exception = JS_GetException(context_);
  JS_FreeValue(context_, exception);
}

void napi_promises__::call_hook(JSValueConst hook, int argc, JSValueConst *argv)
{
  if (context_ == nullptr || !JS_IsFunction(context_, hook))
    return;

  JSValue global = JS_GetGlobalObject(context_);
  JSValue ret = JS_Call(context_, hook, global, argc, argv);
  JS_FreeValue(context_, global);
  if (JS_IsException(ret))
  {
    clear_pending_exception_if_any();
    return;
  }
  JS_FreeValue(context_, ret);
}

napi_status napi_promises__::set_reject_callback(napi_value callback)
{
  return set_optional_function(callback, &promise_reject_callback_);
}

bool napi_promises__::has_reject_callback() const
{
  return JS_IsFunction(context_, promise_reject_callback_);
}

JSValue napi_promises__::dup_reject_callback() const
{
  if (!has_reject_callback())
    return JS_UNDEFINED;
  return JS_DupValue(context_, promise_reject_callback_);
}

napi_status napi_promises__::set_hooks(napi_value init,
                                       napi_value before,
                                       napi_value after,
                                       napi_value resolve)
{
  napi_value callbacks[] = {init, before, after, resolve};
  JSValue replacements[4] = {JS_UNDEFINED, JS_UNDEFINED, JS_UNDEFINED, JS_UNDEFINED};

  for (size_t i = 0; i < 4; ++i)
  {
    napi_value callback = callbacks[i];
    if (callback == nullptr ||
        JS_IsUndefined(napi_quickjs_value_inner(env_, callback)) ||
        JS_IsNull(napi_quickjs_value_inner(env_, callback)))
    {
      continue;
    }
    if (!JS_IsFunction(context_, napi_quickjs_value_inner(env_, callback)))
    {
      for (JSValue replacement : replacements)
        JS_FreeValue(context_, replacement);
      return napi_function_expected;
    }
    replacements[i] = JS_DupValue(context_, napi_quickjs_value_inner(env_, callback));
  }

  for (size_t i = 0; i < 4; ++i)
  {
    JS_FreeValue(context_, promise_hooks_[i]);
    promise_hooks_[i] = replacements[i];
  }
  return napi_ok;
}

JSValue napi_promises__::dup_hook(size_t index) const
{
  if (index >= promise_hooks_.size() || !JS_IsFunction(context_, promise_hooks_[index]))
    return JS_UNDEFINED;
  return JS_DupValue(context_, promise_hooks_[index]);
}

JSValueConst napi_promises__::continuation_preserved_embedder_data() const
{
  return continuation_preserved_embedder_data_;
}

void napi_promises__::set_continuation_preserved_embedder_data(JSValueConst value)
{
  replace_stored_value(&continuation_preserved_embedder_data_, value);
}

void napi_promises__::capture_context_frame(JSValueConst promise)
{
  void *identity = js_identity(promise);
  if (identity == nullptr || JS_IsUndefined(continuation_preserved_embedder_data_))
    return;

  JSValue frame = JS_DupValue(context_, continuation_preserved_embedder_data_);
  auto it = promise_context_frames_.find(identity);
  if (it != promise_context_frames_.end())
  {
    JS_FreeValue(context_, it->second);
    it->second = frame;
    return;
  }
  promise_context_frames_.emplace(identity, frame);
}

void napi_promises__::enter_context_frame(JSValueConst promise)
{
  promise_context_frame_stack_.push_back(
      JS_DupValue(context_, continuation_preserved_embedder_data_));

  JSValueConst frame = JS_UNDEFINED;
  void *identity = js_identity(promise);
  if (identity != nullptr)
  {
    auto it = promise_context_frames_.find(identity);
    if (it != promise_context_frames_.end())
      frame = it->second;
  }
  replace_stored_value(&continuation_preserved_embedder_data_, frame);
}

void napi_promises__::leave_context_frame(JSValueConst promise)
{
  if (!promise_context_frame_stack_.empty())
  {
    JSValue previous = promise_context_frame_stack_.back();
    promise_context_frame_stack_.pop_back();
    JS_FreeValue(context_, continuation_preserved_embedder_data_);
    continuation_preserved_embedder_data_ = previous;
  }

  (void)promise;
}

void napi_promises__::release_context_frame(JSValueConst promise)
{
  void *identity = js_identity(promise);
  if (identity == nullptr)
    return;

  auto it = promise_context_frames_.find(identity);
  if (it != promise_context_frames_.end())
  {
    JS_FreeValue(context_, it->second);
    promise_context_frames_.erase(it);
  }
}

JSValue napi_promises__::microtask_job(JSContext *ctx, int argc, JSValueConst *argv)
{
  if (argc < 1 || !JS_IsFunction(ctx, argv[0]))
    return JS_UNDEFINED;
  return JS_Call(ctx, argv[0], JS_UNDEFINED, 0, nullptr);
}

void napi_promises__::promise_hook(JSContext *ctx,
                                   JSPromiseHookType type,
                                   JSValueConst promise,
                                   JSValueConst parent_promise,
                                   void *opaque)
{
  napi_env env = static_cast<napi_env>(opaque);
  if (!is_same_runtime(env, ctx))
    return;

  napi_promises__ &promises = env->promises();
  if (type == JS_PROMISE_HOOK_INIT)
    promises.capture_context_frame(promise);
  else if (type == JS_PROMISE_HOOK_BEFORE)
    promises.enter_context_frame(promise);

  size_t hook_index = static_cast<size_t>(type);
  JSValue hook = promises.dup_hook(hook_index);
  if (JS_IsFunction(promises.context_, hook))
  {
    if (type == JS_PROMISE_HOOK_INIT)
    {
      JSValueConst argv[] = {promise, parent_promise};
      promises.call_hook(hook, 2, argv);
    }
    else
    {
      JSValueConst argv[] = {promise};
      promises.call_hook(hook, 1, argv);
    }
  }
  JS_FreeValue(promises.context_, hook);

  if (type == JS_PROMISE_HOOK_AFTER)
    promises.leave_context_frame(promise);
  else if (type == JS_PROMISE_HOOK_RESOLVE)
    promises.release_context_frame(promise);
}

void napi_promises__::rejection_tracker(JSContext *ctx,
                                        JSValueConst promise,
                                        JSValueConst reason,
                                        bool is_handled,
                                        void *opaque)
{
  napi_env env = static_cast<napi_env>(opaque);
  if (!is_same_runtime(env, ctx))
    return;

  napi_promises__ &promises = env->promises();
  promises.release_context_frame(promise);

  JSValue callback = promises.dup_reject_callback();
  if (!JS_IsFunction(promises.context_, callback))
  {
    JS_FreeValue(promises.context_, callback);
    return;
  }

  JSValue event_type = JS_NewInt32(promises.context_, is_handled ? 1 : 0);
  JSValueConst rejection_value = is_handled ? JS_UNDEFINED : reason;
  JSValueConst argv[] = {event_type, promise, rejection_value};
  promises.call_hook(callback, 3, argv);
  JS_FreeValue(promises.context_, event_type);
  JS_FreeValue(promises.context_, callback);
}
