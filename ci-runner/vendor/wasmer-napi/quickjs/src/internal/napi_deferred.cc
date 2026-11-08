#include "internal/napi_deferred.h"

#include "internal/napi_env.h"
#include "internal/napi_value.h"

napi_deferred__::napi_deferred__(napi_env env, JSContext *context, JSValue resolve, JSValue reject)
    : env_{env},
      context_{context},
      resolve_{resolve},
      reject_{reject}
{
}

napi_deferred__::~napi_deferred__()
{
  if (env_ == nullptr)
    return;

  napi_env env = env_;
  JSContext *context = context_;
  JSValue resolve = resolve_;
  JSValue reject = reject_;
  env_ = nullptr;
  context_ = nullptr;
  resolve_ = JS_UNDEFINED;
  reject_ = JS_UNDEFINED;

  if (env != nullptr && context != nullptr)
  {
    JS_FreeValue(context, resolve);
    JS_FreeValue(context, reject);
  }
}

napi_env napi_deferred__::env() const
{
  return env_;
}

JSContext *napi_deferred__::context() const
{
  return context_;
}

napi_deferred__ *napi_deferred__::create(napi_env env, JSContext *context, JSValue resolve, JSValue reject)
{
  if (env == nullptr || context == nullptr)
    return nullptr;
  return env->create_deferred(context, resolve, reject);
}

void napi_deferred__::destroy(napi_deferred__ *deferred)
{
  if (deferred == nullptr)
    return;

  napi_env env = deferred->env_;
  if (env != nullptr)
    env->destroy_deferred(deferred);
}

JSValue napi_deferred__::call_resolve(napi_value resolution)
{
  JSValue arg = napi_quickjs_value_inner(env_, resolution);
  return JS_Call(context_, resolve_, JS_UNDEFINED, 1, &arg);
}

JSValue napi_deferred__::call_reject(napi_value rejection)
{
  JSValue arg = napi_quickjs_value_inner(env_, rejection);
  return JS_Call(context_, reject_, JS_UNDEFINED, 1, &arg);
}
