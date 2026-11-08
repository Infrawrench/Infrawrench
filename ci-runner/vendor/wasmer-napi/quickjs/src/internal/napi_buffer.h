#ifndef NAPI_QUICKJS_INTERNAL_NAPI_BUFFER_H_
#define NAPI_QUICKJS_INTERNAL_NAPI_BUFFER_H_

#include "../../../include/js_native_api.h"

#include <quickjs.h>

#include <vector>

class napi_buffer__
{
public:
  napi_buffer__(napi_env env, JSContext *context);
  ~napi_buffer__();

  void teardown();

  napi_status adopt_native_buffer(JSValueConst value);
  bool is_buffer(JSValueConst value);
  napi_status get_buffer_info(JSValueConst value, void **data, size_t *length);

private:
  bool refresh_global_buffer_prototype();
  bool lookup_global_buffer_prototype(JSValue *prototype_out) const;
  bool has_cached_prototype() const;
  bool has_typed_array_backing(JSValueConst value) const;
  bool prototype_chain_contains_cached_prototype(JSValueConst value) const;
  bool is_tracked_native_buffer(JSValueConst value) const;
  bool set_cached_prototype(JSValueConst value) const;
  void clear_pending_exception_if_any() const;
  void update_tracked_native_buffer_prototypes();
  void clear_native_buffers();

  napi_env env_ = nullptr;
  JSContext *context_ = nullptr;
  JSValue buffer_prototype_;
  std::vector<JSValue> native_buffers_;
  bool torn_down_ = false;
};

#endif // NAPI_QUICKJS_INTERNAL_NAPI_BUFFER_H_
