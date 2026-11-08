#ifndef NAPI_QUICKJS_EXTERNAL_H_
#define NAPI_QUICKJS_EXTERNAL_H_

#include "../../../include/js_native_api.h"
#include "../../../include/node_api_types.h"
#include "napi_external_backing_store_hint.h"

#include <quickjs.h>

class napi_external__
{
public:
  static int register_class(JSRuntime *rt);
  static JSClassID class_id();
  static JSClassID record_class_id();
  static bool is_external(JSValueConst value);
  static void *get_value(JSValueConst value);
  static napi_external_backing_store_hint__ *get_wrap_record(JSContext *ctx, JSValueConst object);

  static const char *type_tag_property();
  static const char *wrap_property();
  static const char *finalizer_property();

  static void free_external_array_buffer_data(JSRuntime *rt, void *opaque, void *ptr);

private:
  static void finalizer(JSRuntime *rt, JSValue value);
};

#endif // NAPI_QUICKJS_EXTERNAL_H_
