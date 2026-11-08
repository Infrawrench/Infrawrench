#ifndef NAPI_QUICKJS_SCOPE_H_
#define NAPI_QUICKJS_SCOPE_H_

#include "../../../include/js_native_api.h"
#include "napi_allocator.h"
#include "napi_lifetime_tracker.h"
#include "napi_value.h"

#include <cstdint>
#include <vector>
#include <quickjs.h>

struct napi_scope__
{
  napi_scope__(napi_env env, napi_handle_scope parent);
  ~napi_scope__();

  bool is_active() const;
  size_t level() const;

  napi_value wrap_value(JSValue value, bool owned);
  napi_value wrap_value(JSContext *context, JSValue value, bool owned);
  napi_value escape_value(napi_value value);
  void delete_value(napi_value value);

  void close();

  size_t value_slot_count() const;
  size_t value_storage_slot_count() const;
  size_t active_value_count() const;
  napi_handle_scope parent_handle() const;
  napi_scope__ *parent() const;
  napi_env env() const;
  bool has_escaped() const;
  void mark_escaped();

  template <typename Fn>
  void for_each_active_value(Fn fn) const
  {
    for (const auto &value : values_)
      fn(value);
  }

  napi_scope__(const napi_scope__ &) = delete;
  napi_scope__(napi_scope__ &&other) = delete;
  napi_scope__ &operator=(const napi_scope__ &) = delete;
  napi_scope__ &operator=(napi_scope__ &&other) = delete;

  typedef napi_allocator__<napi_value__, napi_scope__> ValuesAllocator;

private:
  // Scope hierarchy.
  napi_env env_ = nullptr;
  size_t level_ = 0;
  napi_handle_scope parent_ = nullptr;

  // Local value storage.
  ValuesAllocator values_;

  // Scope lifecycle flags.
  bool closed_ = false;
  bool escaped_ = false;
};

#endif // NAPI_QUICKJS_SCOPE_H_
