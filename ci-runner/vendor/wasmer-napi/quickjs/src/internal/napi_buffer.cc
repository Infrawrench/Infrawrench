#include "internal/napi_buffer.h"

#include "internal/napi_env.h"

#include <utility>

namespace
{
bool same_object_identity(JSValueConst left, JSValueConst right)
{
  return JS_IsObject(left) && JS_IsObject(right) &&
         JS_VALUE_GET_PTR(left) == JS_VALUE_GET_PTR(right);
}
} // namespace

napi_buffer__::napi_buffer__(napi_env env, JSContext *context)
    : env_{env},
      context_{context},
      buffer_prototype_{JS_UNDEFINED}
{
}

napi_buffer__::~napi_buffer__()
{
  teardown();
}

void napi_buffer__::teardown()
{
  if (torn_down_)
    return;
  clear_native_buffers();
  if (context_ != nullptr)
    JS_FreeValue(context_, buffer_prototype_);
  buffer_prototype_ = JS_UNDEFINED;
  torn_down_ = true;
}

bool napi_buffer__::has_cached_prototype() const
{
  return context_ != nullptr && JS_IsObject(buffer_prototype_);
}

bool napi_buffer__::lookup_global_buffer_prototype(JSValue *prototype_out) const
{
  if (prototype_out == nullptr)
    return false;
  *prototype_out = JS_UNDEFINED;
  if (context_ == nullptr)
    return false;

  JSValue global = JS_GetGlobalObject(context_);
  if (JS_IsException(global))
  {
    clear_pending_exception_if_any();
    return false;
  }

  JSValue buffer = JS_GetPropertyStr(context_, global, "Buffer");
  JS_FreeValue(context_, global);
  if (JS_IsException(buffer))
  {
    clear_pending_exception_if_any();
    return false;
  }
  if (!JS_IsObject(buffer))
  {
    JS_FreeValue(context_, buffer);
    return false;
  }

  JSValue prototype = JS_GetPropertyStr(context_, buffer, "prototype");
  JS_FreeValue(context_, buffer);
  if (JS_IsException(prototype))
  {
    clear_pending_exception_if_any();
    return false;
  }
  if (!JS_IsObject(prototype))
  {
    JS_FreeValue(context_, prototype);
    return false;
  }

  *prototype_out = prototype;
  return true;
}

bool napi_buffer__::refresh_global_buffer_prototype()
{
  if (has_cached_prototype())
    return true;

  JSValue prototype = JS_UNDEFINED;
  if (!lookup_global_buffer_prototype(&prototype))
    return false;

  JS_FreeValue(context_, buffer_prototype_);
  buffer_prototype_ = JS_DupValue(context_, prototype);
  JS_FreeValue(context_, prototype);

  if (!native_buffers_.empty())
    update_tracked_native_buffer_prototypes();
  return has_cached_prototype();
}

void napi_buffer__::clear_pending_exception_if_any() const
{
  if (context_ == nullptr || !JS_HasException(context_))
    return;
  JSValue exc = JS_GetException(context_);
  JS_FreeValue(context_, exc);
}

bool napi_buffer__::has_typed_array_backing(JSValueConst value) const
{
  if (context_ == nullptr || !JS_IsObject(value))
    return false;

  JSValue arraybuffer = JS_GetTypedArrayBuffer(context_, value, nullptr, nullptr, nullptr);
  if (JS_IsException(arraybuffer))
  {
    clear_pending_exception_if_any();
    return false;
  }

  const bool has_backing = !JS_IsUndefined(arraybuffer) && !JS_IsNull(arraybuffer);
  JS_FreeValue(context_, arraybuffer);
  return has_backing;
}

bool napi_buffer__::prototype_chain_contains_cached_prototype(JSValueConst value) const
{
  if (!has_cached_prototype() || !JS_IsObject(value))
    return false;

  JSValue prototype = JS_GetPrototype(context_, value);
  while (!JS_IsException(prototype) && JS_IsObject(prototype))
  {
    if (same_object_identity(prototype, buffer_prototype_))
    {
      JS_FreeValue(context_, prototype);
      return true;
    }

    JSValue next = JS_GetPrototype(context_, prototype);
    JS_FreeValue(context_, prototype);
    prototype = next;
  }

  if (JS_IsException(prototype))
    clear_pending_exception_if_any();
  else
    JS_FreeValue(context_, prototype);
  return false;
}

bool napi_buffer__::is_tracked_native_buffer(JSValueConst value) const
{
  if (!JS_IsObject(value))
    return false;
  for (JSValueConst native_buffer : native_buffers_)
  {
    if (same_object_identity(native_buffer, value))
      return true;
  }
  return false;
}

bool napi_buffer__::set_cached_prototype(JSValueConst value) const
{
  if (!has_cached_prototype() || !JS_IsObject(value))
    return false;
  if (JS_SetPrototype(context_, value, buffer_prototype_) == 0)
    return true;
  clear_pending_exception_if_any();
  return false;
}

void napi_buffer__::clear_native_buffers()
{
  if (context_ == nullptr)
  {
    native_buffers_.clear();
    return;
  }
  for (JSValue buffer : native_buffers_)
    JS_FreeValue(context_, buffer);
  native_buffers_.clear();
}

void napi_buffer__::update_tracked_native_buffer_prototypes()
{
  if (!has_cached_prototype())
    return;
  std::vector<JSValue> still_tracked;
  still_tracked.reserve(native_buffers_.size());
  for (JSValue buffer : native_buffers_)
  {
    if (!has_typed_array_backing(buffer))
    {
      JS_FreeValue(context_, buffer);
      continue;
    }

    if (prototype_chain_contains_cached_prototype(buffer) ||
        set_cached_prototype(buffer))
    {
      JS_FreeValue(context_, buffer);
      continue;
    }

    still_tracked.push_back(buffer);
  }
  native_buffers_ = std::move(still_tracked);
}

napi_status napi_buffer__::adopt_native_buffer(JSValueConst value)
{
  if (context_ == nullptr || !JS_IsObject(value))
    return napi_invalid_arg;
  if (!has_typed_array_backing(value))
    return napi_invalid_arg;
  if (refresh_global_buffer_prototype() && set_cached_prototype(value))
    return napi_ok;

  native_buffers_.push_back(JS_DupValue(context_, value));
  return napi_ok;
}

bool napi_buffer__::is_buffer(JSValueConst value)
{
  if (!has_typed_array_backing(value))
    return false;
  (void)refresh_global_buffer_prototype();
  return prototype_chain_contains_cached_prototype(value) ||
         is_tracked_native_buffer(value);
}

napi_status napi_buffer__::get_buffer_info(JSValueConst value, void **data, size_t *length)
{
  if (!is_buffer(value))
    return napi_quickjs_set_last_error(env_, napi_invalid_arg, "Invalid argument");

  size_t offset = 0;
  size_t byte_len = 0;
  JSValue arraybuffer = JS_GetTypedArrayBuffer(context_, value, &offset, &byte_len, nullptr);
  if (JS_IsException(arraybuffer))
  {
    clear_pending_exception_if_any();
    return napi_quickjs_set_last_error(env_, napi_invalid_arg, "Invalid argument");
  }

  size_t arraybuffer_len = 0;
  uint8_t *arraybuffer_data = JS_GetArrayBuffer(context_, &arraybuffer_len, arraybuffer);
  JS_FreeValue(context_, arraybuffer);
  if (arraybuffer_data == nullptr && JS_HasException(context_))
  {
    clear_pending_exception_if_any();
    return napi_quickjs_set_last_error(env_, napi_invalid_arg, "Invalid argument");
  }

  if (data != nullptr)
    *data = arraybuffer_data == nullptr ? nullptr : arraybuffer_data + offset;
  if (length != nullptr)
    *length = byte_len;
  return napi_quickjs_clear_last_error(env_);
}
