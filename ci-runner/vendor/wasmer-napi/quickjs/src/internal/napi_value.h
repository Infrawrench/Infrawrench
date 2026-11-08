#ifndef NAPI_QUICKJS_VALUE_H_
#define NAPI_QUICKJS_VALUE_H_

#include "../../../include/js_native_api.h"

#include <cstddef>
#include <quickjs.h>

struct napi_value__
{
  napi_value__(napi_env env, JSValue value, bool owned);
  napi_value__(napi_env env, JSContext *context, JSValue value, bool owned);
  ~napi_value__();

  napi_value__(const napi_value__ &) = delete;
  napi_value__(napi_value__ &&other) = delete;
  napi_value__ &operator=(const napi_value__ &) = delete;
  napi_value__ &operator=(napi_value__ &&other) = delete;

  bool is_active() const;
  napi_env env() const;
  JSContext *context() const;
  JSValueConst get_inner() const;

private:
  // Owning environment and wrapped QuickJS value.
  napi_env env_ = nullptr;
  JSContext *context_ = nullptr;
  JSValue value_ = JS_UNDEFINED;
};

JSValueConst napi_quickjs_value_inner(napi_env env, napi_value value);
JSContext *napi_quickjs_value_context(napi_env env, napi_value value);

#endif // NAPI_QUICKJS_VALUE_H_
