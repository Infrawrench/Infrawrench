#include "internal/napi_function.h"

#include "internal/napi_callback_info.h"
#include "internal/napi_env.h"
#include "internal/napi_external.h"
#include "internal/napi_util.h"
#include "internal/napi_value.h"

#include <cstring>

namespace
{
class quickjs_callback_handle_scope__
{
public:
  explicit quickjs_callback_handle_scope__(napi_env env)
      : env_{env},
        parent_{env != nullptr ? env->current_scope() : nullptr},
        scope_{env != nullptr ? env->create_scope(parent_) : nullptr}
  {
    if (scope_ != nullptr)
      env_->set_current_scope(scope_);
  }

  ~quickjs_callback_handle_scope__()
  {
    if (scope_ == nullptr || env_ == nullptr)
      return;

    if (env_->is_current_scope(scope_))
      env_->set_current_scope(parent_);
    env_->destroy_scope(scope_);
  }

  bool is_open() const
  {
    return scope_ != nullptr;
  }

private:
  napi_env env_ = nullptr;
  napi_handle_scope parent_ = nullptr;
  napi_handle_scope scope_ = nullptr;
};
} // namespace

JSValue napi_function__::create_internal(napi_env env,
                                         const char *utf8name,
                                         napi_callback cb,
                                         void *data)
{
  napi_value fn_val;
  napi_status status = napi_create_function(env, utf8name, NAPI_AUTO_LENGTH, cb, data, &fn_val);
  if (status != napi_ok)
    return JS_EXCEPTION;

  return JS_DupValue(env->context(), napi_quickjs_value_inner(env, fn_val));
}

JSValue napi_function__::trampoline(JSContext *ctx,
                                    JSValueConst this_val,
                                    int argc,
                                    JSValueConst *argv,
                                    int magic,
                                    JSValue *func_data)
{
  auto env = static_cast<napi_env>(JS_GetContextOpaque(ctx));
  if (!napi_util__::check_env(env))
    return JS_ThrowReferenceError(ctx, "Null NAPI env");

  auto cb_ptr = napi_external__::get_value(func_data[0]);
  if (cb_ptr == nullptr)
    return JS_ThrowReferenceError(ctx, "Null NAPI callback data");

  auto cb = reinterpret_cast<napi_callback>(cb_ptr);
  auto user_data = napi_external__::get_value(func_data[1]);
  napi_env_context_scope__ context_scope{env, ctx};
  quickjs_callback_handle_scope__ callback_scope{env};
  if (!callback_scope.is_open())
    return JS_ThrowOutOfMemory(ctx);

  JSValue effective_this = this_val;
  JSValue new_target = JS_UNDEFINED;
  bool called_as_constructor =
      magic == JS_CFUNC_constructor_magic ||
      (magic == 0 && JS_IsConstructor(ctx, this_val));

  if (called_as_constructor)
  {
    JSValue proto = JS_GetPropertyStr(ctx, this_val, "prototype");
    effective_this = JS_NewObjectProto(ctx, proto);
    JS_FreeValue(ctx, proto);

    if (JS_IsException(effective_this))
      return effective_this;

    new_target = this_val;
  }

  auto info = napi_callback_info__{env, effective_this, new_target, argc, argv, user_data};
  auto result = cb(env, reinterpret_cast<napi_callback_info>(&info));

  if (napi_util__::rethrow_last_exception(env, ctx))
  {
    if (called_as_constructor)
      JS_FreeValue(ctx, effective_this);
    return JS_EXCEPTION;
  }

  JSValue returned = JS_UNDEFINED;
  if (called_as_constructor)
  {
    if (result != nullptr)
    {
      JS_FreeValue(ctx, effective_this);
      returned = JS_DupValue(ctx, napi_quickjs_value_inner(env, result));
      env->delete_value_from_current_scope(result);
    }
    else
    {
      returned = effective_this;
    }
  }
  else if (result != nullptr)
  {
    returned = JS_DupValue(ctx, napi_quickjs_value_inner(env, result));
    env->delete_value_from_current_scope(result);
  }

  return returned;
}

napi_status napi_function__::make_constructible(napi_env env, JSValue fn)
{
  JSValue proto = JS_NewObject(env->context());
  if (JS_IsException(proto))
    return napi_util__::return_pending_if_caught(env, "Failed to create function prototype");

  JS_SetConstructor(env->context(), fn, proto);
  JS_SetConstructorBit(env->context(), fn, true);
  JS_FreeValue(env->context(), proto);
  return napi_ok;
}

napi_status napi_function__::create(napi_env env,
                                    const char *utf8name,
                                    size_t length,
                                    napi_callback cb,
                                    void *data,
                                    int magic,
                                    napi_value *result)
{
  if (!napi_util__::check_env(env) || cb == nullptr || result == nullptr)
    return napi_util__::invalid_arg(env);

  JSValue data_values[2];
  data_values[0] = env->wrap_external_data(reinterpret_cast<void *>(cb));
  if (JS_IsException(data_values[0]))
  {
    return napi_util__::return_pending_if_caught(env, "Failed to create function data");
  }
  data_values[1] = env->wrap_external_data(data);
  if (JS_IsException(data_values[1]))
  {
    JS_FreeValue(env->context(), data_values[0]);
    return napi_util__::return_pending_if_caught(env, "Failed to create function data");
  }

  JSValue fn = JS_NewCFunctionData(env->context(), trampoline, 0, magic, 2, data_values);
  JS_FreeValue(env->context(), data_values[0]);
  JS_FreeValue(env->context(), data_values[1]);

  if (JS_IsException(fn))
    return napi_util__::return_pending_if_caught(env, "Failed to create function");

  if (utf8name != nullptr)
  {
    JS_DefinePropertyValueStr(env->context(), fn, "name",
                              JS_NewStringLen(env->context(), utf8name,
                                              (length == NAPI_AUTO_LENGTH) ? std::strlen(utf8name) : length),
                              JS_PROP_CONFIGURABLE);
  }

  *result = env->wrap_value_in_current_scope(fn, true);
  return (*result == nullptr) ? napi_generic_failure : napi_ok;
}
