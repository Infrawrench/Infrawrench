#ifndef NAPI_QUICKJS_FUNCTION_H_
#define NAPI_QUICKJS_FUNCTION_H_

#include "../../../include/js_native_api.h"

#include <quickjs.h>

class napi_function__
{
public:
  static JSValue create_internal(napi_env env,
                                 const char *utf8name,
                                 napi_callback cb,
                                 void *data);

  static JSValue trampoline(JSContext *ctx,
                            JSValueConst this_val,
                            int argc,
                            JSValueConst *argv,
                            int magic,
                            JSValue *func_data);

  static napi_status make_constructible(napi_env env, JSValue fn);

  static napi_status create(napi_env env,
                            const char *utf8name,
                            size_t length,
                            napi_callback cb,
                            void *data,
                            int magic,
                            napi_value *result);
};

#endif // NAPI_QUICKJS_FUNCTION_H_
