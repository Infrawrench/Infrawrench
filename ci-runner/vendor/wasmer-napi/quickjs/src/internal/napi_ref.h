#ifndef NAPI_QUICKJS_REF_H_
#define NAPI_QUICKJS_REF_H_

#include "../../../include/js_native_api.h"

#include <cstddef>
#include <cstdint>
#include <quickjs.h>

struct napi_ref__
{
  napi_ref__(napi_env env, JSValueConst value, uint32_t initial_ref_count);
  ~napi_ref__();

  napi_ref__(const napi_ref__ &) = delete;
  napi_ref__(napi_ref__ &&other) = delete;
  napi_ref__ &operator=(const napi_ref__ &) = delete;
  napi_ref__ &operator=(napi_ref__ &&other) = delete;

  bool is_active() const;
  uint32_t add_ref();
  uint32_t rem_ref();
  uint32_t ref_count() const;
  bool is_empty() const;
  bool is_weak() const;
  napi_env env() const;
  JSContext *context() const;
  JSValueConst get_inner() const;
  JSValue dup_inner() const;
  void clear_for_teardown();

private:
  static void weak_target_finalized(JSRuntime *rt, void *opaque);

  void clear_weak_target();
  void delete_weak_handle();
  bool make_weak();

  // Owning environment and referenced QuickJS value.
  napi_env env_ = nullptr;
  JSContext *context_ = nullptr;
  JSValue value_ = JS_UNDEFINED;
  JSNativeWeakRefLink weak_link_{};

  // N-API logical reference count returned by napi_reference_ref/unref.
  // This is intentionally separate from QuickJS's total JSValue ref count.
  uint32_t ref_count_ = 0;
};

napi_ref__ *napi_quickjs_ref_slot(napi_env env, napi_ref ref);

#endif // NAPI_QUICKJS_REF_H_
