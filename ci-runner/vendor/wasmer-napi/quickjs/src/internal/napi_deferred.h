#ifndef NAPI_QUICKJS_DEFERRED_H_
#define NAPI_QUICKJS_DEFERRED_H_

#include "../../../include/js_native_api.h"

#include <quickjs.h>

struct napi_deferred__
{
  napi_deferred__(napi_env env, JSContext *context, JSValue resolve, JSValue reject);
  static napi_deferred__ *create(napi_env env, JSContext *context, JSValue resolve, JSValue reject);
  static void destroy(napi_deferred__ *deferred);

  ~napi_deferred__();
  napi_deferred__(const napi_deferred__ &) = delete;
  napi_deferred__(napi_deferred__ &&other) = delete;
  napi_deferred__ &operator=(const napi_deferred__ &) = delete;
  napi_deferred__ &operator=(napi_deferred__ &&other) = delete;

  napi_env env() const;
  JSContext *context() const;
  JSValue call_resolve(napi_value resolution);
  JSValue call_reject(napi_value rejection);

private:
  // Owning environment and stored promise callbacks.
  napi_env env_ = nullptr;
  JSContext *context_ = nullptr;
  JSValue resolve_ = JS_UNDEFINED;
  JSValue reject_ = JS_UNDEFINED;
};

#endif // NAPI_QUICKJS_DEFERRED_H_
