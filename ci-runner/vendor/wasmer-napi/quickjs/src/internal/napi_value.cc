#include "internal/napi_value.h"

#include "internal/napi_env.h"
#include "internal/napi_scope.h"

napi_value__::napi_value__(napi_env env, JSValue value, bool owned)
    : napi_value__{env, env == nullptr ? nullptr : env->context(), value, owned}
{
}

napi_value__::napi_value__(napi_env env, JSContext *context, JSValue value, bool owned)
    : env_{env},
      context_{context},
      value_{owned ? value : JS_DupValue(context, value)}
{
}

napi_value__::~napi_value__()
{
  if (env_ == nullptr)
    return;

  napi_env env = env_;
  JSContext *context = context_;
  JSValue value = value_;
  env_ = nullptr;
  context_ = nullptr;
  value_ = JS_UNDEFINED;

  if (env != nullptr && context != nullptr)
    JS_FreeValue(context, value);
}

bool napi_value__::is_active() const
{
  return env_ != nullptr;
}

napi_env napi_value__::env() const
{
  return env_;
}

JSContext *napi_value__::context() const
{
  return context_;
}

JSValueConst napi_value__::get_inner() const
{
  return value_;
}

JSValueConst napi_quickjs_value_inner(napi_env env, napi_value value)
{
  assert(env != nullptr);
  assert(value != nullptr);

  napi_value__ *data = env->value_from_handle(value);
  return data->get_inner();
}

JSContext *napi_quickjs_value_context(napi_env env, napi_value value)
{
  assert(env != nullptr);
  assert(value != nullptr);

  napi_value__ *data = env->value_from_handle(value);
  return data->context();
}
