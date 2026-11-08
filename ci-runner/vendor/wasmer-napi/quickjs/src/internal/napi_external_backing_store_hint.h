#ifndef NAPI_QUICKJS_EXTERNAL_BACKING_STORE_HINT_H_
#define NAPI_QUICKJS_EXTERNAL_BACKING_STORE_HINT_H_

#include "../../../include/js_native_api.h"
#include "../../../include/node_api_types.h"

#include <quickjs.h>

typedef struct napi_external_backing_store_hint__ *napi_external_backing_store_hint;

struct napi_external_backing_store_hint__
{
  napi_external_backing_store_hint__(napi_env env,
                                     void *external_data,
                                     node_api_basic_finalize finalize_cb,
                                     void *finalize_hint);
  static napi_external_backing_store_hint__ *create(
      napi_env env,
      void *external_data,
      node_api_basic_finalize finalize_cb,
      void *finalize_hint);
  static void destroy(napi_external_backing_store_hint__ *hint);
  static void destroy_with_runtime(JSRuntime *rt, napi_external_backing_store_hint__ *hint);
  ~napi_external_backing_store_hint__();
  napi_external_backing_store_hint__(const napi_external_backing_store_hint__ &) = delete;
  napi_external_backing_store_hint__(napi_external_backing_store_hint__ &&other) = delete;
  napi_external_backing_store_hint__ &operator=(const napi_external_backing_store_hint__ &) = delete;
  napi_external_backing_store_hint__ &operator=(napi_external_backing_store_hint__ &&other) = delete;

  void invoke_finalizer();
  void begin_detach();
  void end_detach();
  bool is_detaching() const;
  napi_env env() const;
  JSRuntime *runtime() const;
  void *external_data() const;
  JSValue weak_target() const;
  JSValue finalizer_target(JSValue fallback) const;
  void set_weak_target(JSValue weak_target);

private:
  // Owning runtime state.
  napi_env env_ = nullptr;
  JSRuntime *rt_ = nullptr;

  // Embedder backing store and finalizer.
  void *external_data_ = nullptr;
  node_api_basic_finalize finalize_cb_ = nullptr;
  void *finalize_hint_ = nullptr;
  bool finalize_invoked_ = false;

  // Detach/finalizer coordination.
  bool detaching_ = false;
  JSValue weak_target_ = JS_UNDEFINED;
};

#endif // NAPI_QUICKJS_EXTERNAL_BACKING_STORE_HINT_H_
