#include "internal/napi_env.h"
#include "internal/napi_external.h"
#include "internal/napi_external_backing_store_hint.h"
#include "internal/napi_function.h"
#include "internal/napi_set_property.h"
#include "internal/napi_shared_array_buffer.h"
#include "internal/napi_util.h"
#include <climits>
#include <cmath>
#include <cstdio>
#include <cstdint>
#include <cstring>
#include <limits>
#include <string>
#include <vector>

using namespace quickjs::detail;

namespace {

JSValue JS_NewStringLenNodeUtf8(JSContext *ctx, const char *str, size_t length)
{
  std::vector<uint16_t> utf16;
  utf16.reserve(length);

  size_t i = 0;
  auto append_replacement = [&]() {
    utf16.push_back(static_cast<uint16_t>(0xFFFD));
  };
  auto append_code_point = [&](uint32_t cp) {
    if (cp <= 0xFFFF)
    {
      utf16.push_back(static_cast<uint16_t>(cp));
      return;
    }
    cp -= 0x10000;
    utf16.push_back(static_cast<uint16_t>(0xD800 + ((cp >> 10) & 0x3FF)));
    utf16.push_back(static_cast<uint16_t>(0xDC00 + (cp & 0x3FF)));
  };

  while (i < length)
  {
    const uint8_t b0 = static_cast<uint8_t>(str[i]);
    if (b0 < 0x80)
    {
      utf16.push_back(static_cast<uint16_t>(b0));
      ++i;
      continue;
    }

    size_t needed = 0;
    uint32_t cp = 0;
    uint32_t min_cp = 0;
    if (b0 >= 0xC2 && b0 <= 0xDF)
    {
      needed = 1;
      cp = b0 & 0x1F;
      min_cp = 0x80;
    }
    else if (b0 >= 0xE0 && b0 <= 0xEF)
    {
      needed = 2;
      cp = b0 & 0x0F;
      min_cp = 0x800;
    }
    else if (b0 >= 0xF0 && b0 <= 0xF4)
    {
      needed = 3;
      cp = b0 & 0x07;
      min_cp = 0x10000;
    }
    else
    {
      append_replacement();
      ++i;
      continue;
    }

    size_t j = 1;
    for (; j <= needed && i + j < length; ++j)
    {
      const uint8_t bx = static_cast<uint8_t>(str[i + j]);
      if ((bx & 0xC0) != 0x80)
        break;
      cp = (cp << 6) | (bx & 0x3F);
    }

    if (j <= needed)
    {
      append_replacement();
      bool prefix_invalid = false;
      if (j > 1)
      {
        const uint8_t b1 = static_cast<uint8_t>(str[i + 1]);
        if (needed == 2 && b0 == 0xE0 && b1 < 0xA0)
          prefix_invalid = true;
        if (needed == 2 && b0 == 0xED && b1 > 0x9F)
          prefix_invalid = true;
        if (needed == 3 && b0 == 0xF0 && b1 < 0x90)
          prefix_invalid = true;
        if (needed == 3 && b0 == 0xF4 && b1 > 0x8F)
          prefix_invalid = true;
      }
      i += prefix_invalid ? 1 : j;
      continue;
    }

    bool valid = true;
    if (cp < min_cp || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF))
      valid = false;
    if (needed == 2 && b0 == 0xE0 && static_cast<uint8_t>(str[i + 1]) < 0xA0)
      valid = false;
    if (needed == 2 && b0 == 0xED && static_cast<uint8_t>(str[i + 1]) > 0x9F)
      valid = false;
    if (needed == 3 && b0 == 0xF0 && static_cast<uint8_t>(str[i + 1]) < 0x90)
      valid = false;
    if (needed == 3 && b0 == 0xF4 && static_cast<uint8_t>(str[i + 1]) > 0x8F)
      valid = false;

    if (!valid)
    {
      append_replacement();
      ++i;
      continue;
    }

    append_code_point(cp);
    i += needed + 1;
  }

  return JS_NewStringUTF16(ctx, utf16.data(), utf16.size());
}

}

extern "C"
{
  napi_status NAPI_CDECL napi_get_last_error_info(
      node_api_basic_env env, const napi_extended_error_info **result)
  {
    if (result == nullptr)
      return napi_invalid_arg;
    auto *napiEnv = const_cast<napi_env>(env);
    if (!napi_util__::check_env(napiEnv))
      return napi_invalid_arg;
    *result = napiEnv->last_error_info();
    return napi_ok;
  }

  napi_status NAPI_CDECL napi_get_undefined(napi_env env, napi_value *result)
  {
    if (!napi_util__::check_env(env) || result == nullptr)
      return napi_invalid_arg;
    *result = env->wrap_value_in_current_scope(JS_UNDEFINED, true);
    return (*result == nullptr) ? napi_generic_failure : napi_ok;
  }

  napi_status NAPI_CDECL napi_get_null(napi_env env, napi_value *result)
  {
    if (!napi_util__::check_env(env) || result == nullptr)
      return napi_invalid_arg;
    *result = env->wrap_value_in_current_scope(JS_NULL, true);
    return (*result == nullptr) ? napi_generic_failure : napi_ok;
  }

  napi_status NAPI_CDECL napi_get_global(napi_env env, napi_value *result)
  {
    if (!napi_util__::check_env(env) || result == nullptr)
      return napi_invalid_arg;
    auto context = env->context();
    *result = env->wrap_value_in_current_scope(JS_GetGlobalObject(context), true);
    return (*result == nullptr) ? napi_generic_failure : napi_ok;
  }

  napi_status NAPI_CDECL napi_get_boolean(napi_env env,
                                          bool value,
                                          napi_value *result)
  {
    if (!napi_util__::check_env(env) || result == nullptr)
      return napi_invalid_arg;
    *result = env->wrap_value_in_current_scope(JS_NewBool(env->context(), value), true);
    return (*result == nullptr) ? napi_generic_failure : napi_ok;
  }

  napi_status NAPI_CDECL napi_create_double(napi_env env,
                                            double value,
                                            napi_value *result)
  {
    if (!napi_util__::check_env(env) || result == nullptr)
      return napi_invalid_arg;
    *result = env->wrap_value_in_current_scope(JS_NewFloat64(env->context(), value), true);
    return (*result == nullptr) ? napi_generic_failure : napi_ok;
  }

  napi_status NAPI_CDECL napi_create_int32(napi_env env,
                                           int32_t value,
                                           napi_value *result)
  {
    if (!napi_util__::check_env(env) || result == nullptr)
      return napi_invalid_arg;
    *result = env->wrap_value_in_current_scope(JS_NewInt32(env->context(), value), true);
    return (*result == nullptr) ? napi_generic_failure : napi_ok;
  }

  napi_status NAPI_CDECL napi_create_int64(napi_env env,
                                           int64_t value,
                                           napi_value *result)
  {
    if (!napi_util__::check_env(env) || result == nullptr)
      return napi_invalid_arg;
    *result = env->wrap_value_in_current_scope(JS_NewInt64(env->context(), value), true);
    return (*result == nullptr) ? napi_generic_failure : napi_ok;
  }

  napi_status NAPI_CDECL napi_create_uint32(napi_env env,
                                            uint32_t value,
                                            napi_value *result)
  {
    if (!napi_util__::check_env(env) || result == nullptr)
      return napi_invalid_arg;
    *result = env->wrap_value_in_current_scope(JS_NewUint32(env->context(), value), true);
    return (*result == nullptr) ? napi_generic_failure : napi_ok;
  }

  napi_status NAPI_CDECL napi_create_bigint_int64(napi_env env,
                                                  int64_t value,
                                                  napi_value *result)
  {
    if (!napi_util__::check_env(env) || result == nullptr)
      return napi_invalid_arg;
    *result = env->wrap_value_in_current_scope(JS_NewBigInt64(env->context(), value), true);
    return (*result == nullptr) ? napi_generic_failure : napi_ok;
  }

  napi_status NAPI_CDECL napi_create_bigint_uint64(napi_env env,
                                                   uint64_t value,
                                                   napi_value *result)
  {
    if (!napi_util__::check_env(env) || result == nullptr)
      return napi_invalid_arg;
    *result = env->wrap_value_in_current_scope(JS_NewBigUint64(env->context(), value), true);
    return (*result == nullptr) ? napi_generic_failure : napi_ok;
  }

  napi_status NAPI_CDECL napi_create_bigint_words(napi_env env,
                                                  int sign_bit,
                                                  size_t word_count,
                                                  const uint64_t *words,
                                                  napi_value *result)
  {
    if (!napi_util__::check_env(env) || result == nullptr)
      return napi_invalid_arg;
    if ((sign_bit != 0 && sign_bit != 1) || word_count > static_cast<size_t>(INT_MAX))
    {
      return napi_quickjs_set_last_error(env, napi_invalid_arg, "Invalid argument");
    }
    if (word_count > 0 && words == nullptr)
    {
      return napi_quickjs_set_last_error(env, napi_invalid_arg, "Invalid argument");
    }

    if (word_count > 1024)
    {
      JS_ThrowRangeError(env->context(), "Maximum BigInt size exceeded");
      return napi_util__::return_pending_if_caught(env, "Maximum BigInt size exceeded");
    }

    size_t used_words = word_count;
    while (used_words > 0 && words[used_words - 1] == 0)
      --used_words;

    if (used_words == 0)
    {
      *result = env->wrap_value_in_current_scope(JS_NewBigInt64(env->context(), 0), true);
      return (*result == nullptr) ? napi_generic_failure : napi_ok;
    }

    std::string literal;
    if (sign_bit != 0)
      literal.push_back('-');
    literal += "0x";

    char chunk[17];
    std::snprintf(chunk, sizeof(chunk), "%llx",
                  static_cast<unsigned long long>(words[used_words - 1]));
    literal += chunk;

    for (size_t i = used_words - 1; i-- > 0;)
    {
      std::snprintf(chunk, sizeof(chunk), "%016llx",
                    static_cast<unsigned long long>(words[i]));
      literal += chunk;
    }

    literal.push_back('n');
    JSValue bigint = JS_Eval(env->context(), literal.c_str(), literal.size(),
                             "<napi_create_bigint_words>", JS_EVAL_TYPE_GLOBAL);

    if (JS_IsException(bigint))
      return napi_util__::return_pending_if_caught(env, "Failed to create BigInt from words");

    *result = env->wrap_value_in_current_scope(bigint, true);
    return (*result == nullptr) ? napi_generic_failure : napi_ok;
  }

  napi_status NAPI_CDECL napi_create_date(napi_env env, double time, napi_value *result)
  {
    if (!napi_util__::check_env(env) || result == nullptr)
      return napi_invalid_arg;
    auto out = JS_NewDate(env->context(), time); // TODO: Confirm that `time` is `epoch_ms`
    if (JS_IsException(out))
    {
      return napi_util__::return_pending_if_caught(env, "Failed to create date");
    }
    *result = env->wrap_value_in_current_scope(out, true);
    return (*result == nullptr) ? napi_generic_failure : napi_ok;
  }

  napi_status NAPI_CDECL napi_create_object(napi_env env, napi_value *result)
  {
    if (!napi_util__::check_env(env) || result == nullptr)
      return napi_invalid_arg;
    *result = env->wrap_value_in_current_scope(JS_NewObject(env->context()), true);
    return (*result == nullptr) ? napi_generic_failure : napi_ok;
  }

  napi_status NAPI_CDECL napi_create_array(napi_env env, napi_value *result)
  {
    if (!napi_util__::check_env(env) || result == nullptr)
      return napi_invalid_arg;
    *result = env->wrap_value_in_current_scope(JS_NewArray(env->context()), true);
    return (*result == nullptr) ? napi_generic_failure : napi_ok;
  }

  napi_status NAPI_CDECL napi_create_external(napi_env env,
                                              void *data,
                                              napi_finalize finalize_cb,
                                              void *finalize_hint,
                                              napi_value *result)
  {
    if (!napi_util__::check_env(env) || result == nullptr)
      return napi_invalid_arg;

    JSValue obj = env->wrap_external_data(data, finalize_cb, finalize_hint);
    if (JS_IsException(obj))
    {
      return napi_util__::return_pending_if_caught(env, "Failed to create external object");
    }

    *result = env->wrap_value_in_current_scope(obj, true);
    return (*result == nullptr) ? napi_generic_failure : napi_ok;
  }

  napi_status NAPI_CDECL napi_get_value_external(napi_env env,
                                                 napi_value value,
                                                 void **result)
  {
    if (!napi_util__::check_value(env, value) || result == nullptr)
      return napi_invalid_arg;

    JSValue local = napi_quickjs_value_inner(env, value);
    if (!napi_external__::is_external(local))
      return napi_util__::invalid_arg(env);

    *result = napi_external__::get_value(local);
    return napi_ok;
  }

  napi_status NAPI_CDECL napi_create_arraybuffer(napi_env env,
                                                 size_t byte_length,
                                                 void **data,
                                                 napi_value *result)
  {
    if (!napi_util__::check_env(env) || result == nullptr)
      return napi_invalid_arg;

    auto rt = JS_GetRuntime(env->context());
    auto buf = js_malloc_rt(rt, byte_length);
    if (data != nullptr)
    {
      *data = buf;
    }

    auto ab = JS_NewArrayBuffer(env->context(), reinterpret_cast<uint8_t *>(buf),
                                byte_length,
                                &napi_util__::free_array_buffer_data, nullptr,
                                false);
    if (JS_IsException(ab))
    {
      js_free_rt(rt, buf);
      return napi_util__::return_pending_if_caught(env, "Failed to create array buffer");
    }

    *result = env->wrap_value_in_current_scope(ab, true);
    return (*result == nullptr) ? napi_generic_failure : napi_ok;
  }

  napi_status NAPI_CDECL napi_create_external_arraybuffer(
      napi_env env,
      void *external_data,
      size_t byte_length,
      node_api_basic_finalize finalize_cb,
      void *finalize_hint,
      napi_value *result)
  {
    if (!napi_util__::check_env(env) || result == nullptr)
      return napi_invalid_arg;

    auto rt = JS_GetRuntime(env->context());
    JSValue out;
    if (external_data == nullptr && byte_length == 0)
    {
      uint8_t buf = {};
      out = JS_NewArrayBufferCopy(env->context(), &buf, 1);
      if (JS_IsException(out))
      {
        return napi_util__::return_pending_if_caught(env, "Failed to create detached array");
      }
      JS_DetachArrayBuffer(env->context(), out);
    }
    else
    {
      if (external_data == nullptr)
        return napi_invalid_arg;

      // TODO: Maybe instead allocate using js_rt_alloc()
      auto hint = napi_external_backing_store_hint__::create(env, external_data, finalize_cb, finalize_hint);
      if (hint == nullptr)
        return napi_generic_failure;

      out = JS_NewArrayBuffer(env->context(), reinterpret_cast<uint8_t *>(external_data),
                              byte_length,
                              &napi_external__::free_external_array_buffer_data,
                              hint,
                              false);

      if (JS_IsException(out))
      {
        napi_external_backing_store_hint__::destroy(hint);
        return napi_util__::return_pending_if_caught(env, "Failed to create external array");
      }
    }

    *result = env->wrap_value_in_current_scope(out, true);
    return (*result == nullptr) ? napi_generic_failure : napi_ok;
  }

  napi_status NAPI_CDECL napi_is_typedarray(napi_env env, napi_value value, bool *result)
  {
    if (!napi_util__::check_env(env) || value == nullptr || result == nullptr)
      return napi_invalid_arg;
    *result = JS_GetTypedArrayType(napi_quickjs_value_inner(env, value)) >= 0;
    return napi_quickjs_clear_last_error(env);
  }

  napi_status NAPI_CDECL napi_create_typedarray(napi_env env,
                                                napi_typedarray_type type,
                                                size_t length,
                                                napi_value arraybuffer,
                                                size_t byte_offset,
                                                napi_value *result)
  {
    if (!napi_util__::check_env(env) || arraybuffer == nullptr || result == nullptr)
      return napi_util__::invalid_arg(env);

    JSValue argv[] = {
        napi_quickjs_value_inner(env, arraybuffer),
        JS_NewInt64(env->context(), static_cast<int64_t>(byte_offset)),
        JS_NewInt64(env->context(), static_cast<int64_t>(length))};

    JSTypedArrayEnum array_type = napi_util__::to_quickjs_array_type(type);

    JSValue view = JS_NewTypedArray(env->context(), 3, argv, array_type);
    JS_FreeValue(env->context(), argv[1]);
    JS_FreeValue(env->context(), argv[2]);

    if (JS_IsException(view))
    {
      return napi_util__::return_pending_if_caught(env, "Failed to create TypedArray");
    }

    *result = env->wrap_value_in_current_scope(view, true);
    return (*result == nullptr) ? napi_generic_failure : napi_ok;
  }

  napi_status NAPI_CDECL napi_get_typedarray_info(napi_env env,
                                                  napi_value typedarray,
                                                  napi_typedarray_type *type,
                                                  size_t *length,
                                                  void **data,
                                                  napi_value *arraybuffer,
                                                  size_t *byte_offset)
  {
    if (!napi_util__::check_value(env, typedarray))
      return napi_util__::invalid_arg(env);

    JSValue local = napi_quickjs_value_inner(env, typedarray);
    int type_idx = JS_GetTypedArrayType(local);
    if (type_idx < 0)
      return napi_invalid_arg;

    if (type != nullptr)
    {
      if (!napi_util__::from_quickjs_array_type(type_idx, type))
        return napi_invalid_arg;
    }

    size_t byte_len;
    size_t offset;
    JSValue abuf = JS_GetTypedArrayBuffer(env->context(), local, &offset, &byte_len, nullptr);

    if (JS_IsException(abuf))
    {
      return napi_util__::return_pending_if_caught(env, "Failed to get typed array info");
    }

    if (length != nullptr)
    {
      // Node-API expects the number of elements, not byte length
      // We need to calculate it based on the element size
      int shift = 0;
      switch (type_idx)
      {
      case JS_TYPED_ARRAY_INT8:
      case JS_TYPED_ARRAY_UINT8:
      case JS_TYPED_ARRAY_UINT8C:
        shift = 0;
        break;
      case JS_TYPED_ARRAY_INT16:
      case JS_TYPED_ARRAY_UINT16:
      case JS_TYPED_ARRAY_FLOAT16:
        shift = 1;
        break;
      case JS_TYPED_ARRAY_INT32:
      case JS_TYPED_ARRAY_UINT32:
      case JS_TYPED_ARRAY_FLOAT32:
        shift = 2;
        break;
      case JS_TYPED_ARRAY_FLOAT64:
      case JS_TYPED_ARRAY_BIG_INT64:
      case JS_TYPED_ARRAY_BIG_UINT64:
        shift = 3;
        break;
      }
      *length = byte_len >> shift;
    }

    if (byte_offset != nullptr)
    {
      *byte_offset = offset;
    }

    if (data != nullptr)
    {
      size_t ab_len;
      uint8_t *ab_data = JS_GetArrayBuffer(env->context(), &ab_len, abuf);
      if (ab_data == nullptr)
      {
        JS_FreeValue(env->context(), abuf);
        return napi_util__::return_pending_if_caught(env, "Failed to get array buffer data");
      }
      *data = ab_data + offset;
    }

    if (arraybuffer != nullptr)
    {
      *arraybuffer = env->wrap_value_in_current_scope(abuf, true);
      if (*arraybuffer == nullptr)
      {
        JS_FreeValue(env->context(), abuf);
        return napi_generic_failure;
      }
    }
    else
    {
      JS_FreeValue(env->context(), abuf);
    }

    return napi_ok;
  }

  napi_status NAPI_CDECL napi_detach_arraybuffer(napi_env env, napi_value arraybuffer)
  {
    if (!napi_util__::check_value(env, arraybuffer))
      return napi_util__::invalid_arg(env);
    JSValue local = napi_quickjs_value_inner(env, arraybuffer);

    if (!JS_IsArrayBuffer(local))
      return napi_arraybuffer_expected;

    JSFreeArrayBufferDataFunc *free_func = nullptr;
    void *opaque = nullptr;
    napi_external_backing_store_hint__ *hint = nullptr;
    if (JS_GetArrayBufferFreeInfo(env->context(), local, &free_func, &opaque) &&
        free_func == &napi_external__::free_external_array_buffer_data)
    {
      hint = static_cast<napi_external_backing_store_hint__ *>(opaque);
    }
    if (hint != nullptr)
      hint->begin_detach();
    JS_DetachArrayBuffer(env->context(), local);
    if (hint != nullptr)
      hint->end_detach();
    return napi_ok;
  }

  napi_status NAPI_CDECL napi_is_detached_arraybuffer(napi_env env,
                                                      napi_value value,
                                                      bool *result)
  {
    if (!napi_util__::check_value(env, value) || result == nullptr)
      return napi_util__::invalid_arg(env);
    JSValue local = napi_quickjs_value_inner(env, value);

    if (JS_IsUndefined(local) || JS_IsNull(local))
    {
      *result = true;
      return napi_ok;
    }

    if (!JS_IsArrayBuffer(local))
    {
      if (JS_IsObject(local))
      {
        JSValue byte_len = JS_GetPropertyStr(env->context(), local, "byteLength");
        if (JS_IsException(byte_len))
        {
          JSValue exc = JS_GetException(env->context());
          JS_FreeValue(env->context(), exc);
        }
        else if (!JS_IsUndefined(byte_len))
        {
          JS_FreeValue(env->context(), byte_len);
          *result = true;
          return napi_ok;
        }
        else
        {
          JS_FreeValue(env->context(), byte_len);
        }
      }
      return napi_arraybuffer_expected;
    }

    size_t ab_len = 0;
    uint8_t *data = JS_GetArrayBuffer(env->context(), &ab_len, local);
    if (data == nullptr && JS_HasException(env->context()))
    {
      napi_util__::clear_last_exception(env);
      *result = true;
      return napi_ok;
    }

    *result = false;

    return napi_ok;
  }

  napi_status NAPI_CDECL napi_create_array_with_length(napi_env env,
                                                       size_t length,
                                                       napi_value *result)
  {
    if (!napi_util__::check_env(env) || result == nullptr)
      return napi_invalid_arg;

    JSValue arr = JS_NewArray(env->context());
    if (JS_IsException(arr))
    {
      return napi_util__::return_pending_if_caught(env, "Failed to create array");
    }

    if (length > 0)
    {
      // ES: Expextation is that length is capped at numerix limit of uint32_t
      int64_t length_i64 = static_cast<int64_t>(
          length > static_cast<size_t>(std::numeric_limits<uint32_t>::max())
              ? std::numeric_limits<uint32_t>::max()
              : length);

      if (JS_SetLength(env->context(), arr, length_i64) < 0)
      {
        JS_FreeValue(env->context(), arr);
        return napi_util__::return_pending_if_caught(env, "Failed to set array length");
      }
    }

    *result = env->wrap_value_in_current_scope(arr, true);
    return (*result == nullptr) ? napi_generic_failure : napi_ok;
  }

  napi_status NAPI_CDECL napi_create_string_utf8(napi_env env,
                                                 const char *str,
                                                 size_t length,
                                                 napi_value *result)
  {
    if (!napi_util__::check_env(env))
      return napi_invalid_arg;
    if (result == nullptr)
      return napi_quickjs_set_last_error(env, napi_invalid_arg, "Invalid argument");

    if (str == nullptr)
    {
      if (length != 0 && length != NAPI_AUTO_LENGTH)
        return napi_quickjs_set_last_error(env, napi_invalid_arg, "Invalid argument");
      str = "";
      length = 0;
    }

    if (length == NAPI_AUTO_LENGTH)
    {
      length = std::strlen(str);
    }
    if (length > static_cast<size_t>(std::numeric_limits<int>::max()))
      return napi_quickjs_set_last_error(env, napi_invalid_arg, "Invalid argument");

    JSValue out = JS_NewStringLenNodeUtf8(env->context(), str, length);
    if (JS_IsException(out))
    {
      return napi_util__::return_pending_if_caught(env, "Cannot create string");
    }

    *result = env->wrap_value_in_current_scope(out, true);
    return (*result == nullptr) ? napi_generic_failure : napi_quickjs_clear_last_error(env);
  }

  napi_status NAPI_CDECL napi_create_string_latin1(napi_env env,
                                                   const char *str,
                                                   size_t length,
                                                   napi_value *result)
  {
    // QuickJS JS_NewStringLen handles UTF-8.
    // For pure Latin-1 (ISO-8859-1), if the string contains characters > 0x7F,
    // they need to be converted to UTF-8 for QuickJS.
    if (!napi_util__::check_env(env))
      return napi_invalid_arg;
    if (result == nullptr)
      return napi_quickjs_set_last_error(env, napi_invalid_arg, "Invalid argument");

    if (str == nullptr)
    {
      if (length != 0 && length != NAPI_AUTO_LENGTH)
        return napi_quickjs_set_last_error(env, napi_invalid_arg, "Invalid argument");
      str = "";
      length = 0;
    }

    if (length == NAPI_AUTO_LENGTH)
    {
      length = std::strlen(str);
    }
    if (length > static_cast<size_t>(std::numeric_limits<int>::max()))
      return napi_quickjs_set_last_error(env, napi_invalid_arg, "Invalid argument");

    // Check if conversion to UTF-8 is needed
    bool needs_conversion = false;
    for (size_t i = 0; i < length; ++i)
    {
      if (static_cast<unsigned char>(str[i]) > 0x7F)
      {
        needs_conversion = true;
        break;
      }
    }

    JSValue out;
    if (!needs_conversion)
    {
      out = JS_NewStringLen(env->context(), str, length);
    }
    else
    {
      // Convert Latin1 to UTF-8
      size_t utf8_len = 0;
      for (size_t i = 0; i < length; ++i)
      {
        unsigned char c = str[i];
        utf8_len += (c < 0x80) ? 1 : 2;
      }

      char *utf8_str = static_cast<char *>(js_malloc(env->context(), utf8_len + 1));
      if (!utf8_str)
        return napi_generic_failure;

      size_t j = 0;
      for (size_t i = 0; i < length; ++i)
      {
        unsigned char c = str[i];
        if (c < 0x80)
        {
          utf8_str[j++] = c;
        }
        else
        {
          utf8_str[j++] = 0xC0 | (c >> 6);
          utf8_str[j++] = 0x80 | (c & 0x3F);
        }
      }
      utf8_str[j] = '\0';
      out = JS_NewStringLen(env->context(), utf8_str, utf8_len);
      js_free(env->context(), utf8_str);
    }

    if (JS_IsException(out))
    {
      return napi_util__::return_pending_if_caught(env, "Cannot create string");
    }

    *result = env->wrap_value_in_current_scope(out, true);
    return (*result == nullptr) ? napi_generic_failure : napi_quickjs_clear_last_error(env);
  }

  napi_status NAPI_CDECL napi_create_string_utf16(napi_env env,
                                                  const char16_t *str,
                                                  size_t length,
                                                  napi_value *result)
  {
    if (!napi_util__::check_env(env))
      return napi_invalid_arg;
    if (result == nullptr)
      return napi_quickjs_set_last_error(env, napi_invalid_arg, "Invalid argument");

    if (str == nullptr)
    {
      if (length != 0 && length != NAPI_AUTO_LENGTH)
        return napi_quickjs_set_last_error(env, napi_invalid_arg, "Invalid argument");
      static const char16_t empty[] = {0};
      str = empty;
      length = 0;
    }

    if (length == NAPI_AUTO_LENGTH)
    {
      const char16_t *p = str;
      while (*p != 0)
        ++p;
      length = static_cast<size_t>(p - str);
    }
    if (length > static_cast<size_t>(std::numeric_limits<int>::max()))
      return napi_quickjs_set_last_error(env, napi_invalid_arg, "Invalid argument");

    JSValue out = JS_NewStringUTF16(env->context(), reinterpret_cast<const uint16_t *>(str), length);

    if (JS_IsException(out))
    {
      return napi_util__::return_pending_if_caught(env, "Cannot create string");
    }

    *result = env->wrap_value_in_current_scope(out, true);
    return (*result == nullptr) ? napi_generic_failure : napi_quickjs_clear_last_error(env);
  }

  napi_status NAPI_CDECL node_api_create_external_string_latin1(
      napi_env env, char *str, size_t length,
      node_api_basic_finalize finalize_callback, void *finalize_hint,
      napi_value *result, bool *copied)
  {
    // QuickJS always copies string data, so finalize_callback/finalize_hint
    // are intentionally ignored — the caller retains ownership of str.
    (void)finalize_callback;
    (void)finalize_hint;
    if (copied != nullptr)
      *copied = false;
    napi_status status = napi_create_string_latin1(env, str, length, result);
    if (status == napi_ok && finalize_callback != nullptr)
      finalize_callback(env, str, finalize_hint);
    return status;
  }

  napi_status NAPI_CDECL node_api_create_external_string_utf16(
      napi_env env, char16_t *str, size_t length,
      node_api_basic_finalize finalize_callback, void *finalize_hint,
      napi_value *result, bool *copied)
  {
    (void)finalize_callback;
    (void)finalize_hint;
    if (copied != nullptr)
      *copied = false;
    napi_status status = napi_create_string_utf16(env, str, length, result);
    if (status == napi_ok && finalize_callback != nullptr)
      finalize_callback(env, str, finalize_hint);
    return status;
  }

  // Property keys in QuickJS are interned atoms. We create a regular string
  // which QuickJS will intern automatically when used as a property key.
  napi_status NAPI_CDECL node_api_create_property_key_latin1(
      napi_env env, const char *str, size_t length, napi_value *result)
  {
    if (!napi_util__::check_env(env) || result == nullptr)
      return napi_invalid_arg;
    if (str == nullptr)
    {
      if (length != 0)
        return napi_invalid_arg;
      str = "";
    }
    if (length == NAPI_AUTO_LENGTH)
      length = strlen(str);

    return napi_create_string_latin1(env, str, length, result);
  }

  napi_status NAPI_CDECL node_api_create_property_key_utf8(
      napi_env env, const char *str, size_t length, napi_value *result)
  {
    if (!napi_util__::check_env(env) || result == nullptr)
      return napi_invalid_arg;
    if (str == nullptr)
    {
      if (length != 0)
        return napi_invalid_arg;
      str = "";
    }
    if (length == NAPI_AUTO_LENGTH)
      length = strlen(str);

    *result = env->wrap_value_in_current_scope(JS_NewStringLen(env->context(), str, length), true);
    return (*result == nullptr) ? napi_generic_failure : napi_ok;
  }

  napi_status NAPI_CDECL node_api_create_property_key_utf16(
      napi_env env, const char16_t *str, size_t length, napi_value *result)
  {
    if (!napi_util__::check_env(env) || result == nullptr)
      return napi_invalid_arg;
    if (str == nullptr)
    {
      if (length != 0)
        return napi_invalid_arg;
      str = u"";
    }
    if (length == NAPI_AUTO_LENGTH)
    {
      const char16_t *p = str;
      while (*p != 0)
        ++p;
      length = static_cast<size_t>(p - str);
    }

    *result = env->wrap_value_in_current_scope(
        JS_NewStringUTF16(env->context(), reinterpret_cast<const uint16_t *>(str), length), true);
    return (*result == nullptr) ? napi_generic_failure : napi_ok;
  }

  napi_status NAPI_CDECL napi_create_symbol(napi_env env,
                                            napi_value description,
                                            napi_value *result)
  {
    if (!napi_util__::check_env(env) || result == nullptr)
      return napi_invalid_arg;

    const char *desc_str = nullptr;
    if (description != nullptr)
    {
      JSValue desc_val = napi_quickjs_value_inner(env, description);
      if (!JS_IsString(desc_val))
        return napi_string_expected;
      desc_str = JS_ToCString(env->context(), desc_val);
    }

    JSValue sym = JS_NewSymbol(env->context(), desc_str ? desc_str : "", false);

    if (desc_str != nullptr)
      JS_FreeCString(env->context(), desc_str);

    *result = env->wrap_value_in_current_scope(sym, true);
    return (*result == nullptr) ? napi_generic_failure : napi_ok;
  }

  napi_status NAPI_CDECL node_api_symbol_for(napi_env env,
                                             const char *utf8description,
                                             size_t length,
                                             napi_value *result)
  {
    if (!napi_util__::check_env(env) || result == nullptr)
      return napi_invalid_arg;
    if (utf8description == nullptr && length > 0)
      return napi_invalid_arg;

    const char *desc = (utf8description == nullptr) ? "" : utf8description;

    // JS_NewSymbol with is_global=true mirrors Symbol.for() — same key returns same symbol.
    JSValue sym = JS_NewSymbol(env->context(), desc, true);

    *result = env->wrap_value_in_current_scope(sym, true);
    return (*result == nullptr) ? napi_generic_failure : napi_ok;
  }

  napi_status NAPI_CDECL napi_typeof(napi_env env,
                                     napi_value value,
                                     napi_valuetype *result)
  {
    if (!napi_util__::check_value(env, value) || result == nullptr)
      return napi_invalid_arg;

    JSValue local = napi_quickjs_value_inner(env, value);

    if (JS_IsNumber(local))
    {
      *result = napi_number;
    }
    else if (JS_IsString(local))
    {
      *result = napi_string;
    }
    else if (JS_IsBool(local))
    {
      *result = napi_boolean;
    }
    else if (JS_IsNull(local))
    {
      *result = napi_null;
    }
    else if (JS_IsUndefined(local))
    {
      *result = napi_undefined;
    }
    else if (JS_IsSymbol(local))
    {
      *result = napi_symbol;
    }
    else if (JS_IsFunction(env->context(), local))
    {
      *result = napi_function;
    }
    else if (JS_IsBigInt(local))
    {
      *result = napi_bigint;
    }
    else if (JS_IsObject(local))
    {
      if (napi_external__::is_external(local))
      {
        *result = napi_external;
      }
      else
      {
        *result = napi_object;
      }
    }
    else
    {
      // Fallback
      *result = napi_object;
    }

    return napi_ok;
  }

  napi_status NAPI_CDECL napi_get_value_double(napi_env env,
                                               napi_value value,
                                               double *result)
  {
    if (!napi_util__::check_value(env, value) || result == nullptr)
    {
      return napi_quickjs_set_last_error(env, napi_invalid_arg, "Invalid argument");
    }
    JSValue local = napi_quickjs_value_inner(env, value);
    if (!JS_IsNumber(local))
    {
      return napi_quickjs_set_last_error(env, napi_number_expected, "A number was expected");
    }
    if (JS_ToFloat64(env->context(), result, local) < 0)
    {
      return napi_util__::return_pending_if_caught(env, "Exception during double coercion");
    }
    return napi_quickjs_clear_last_error(env);
  }

  napi_status NAPI_CDECL napi_get_value_uint32(napi_env env,
                                               napi_value value,
                                               uint32_t *result)
  {
    if (!napi_util__::check_value(env, value) || result == nullptr)
    {
      return napi_quickjs_set_last_error(env, napi_invalid_arg, "Invalid argument");
    }
    JSValue local = napi_quickjs_value_inner(env, value);
    if (!JS_IsNumber(local))
    {
      return napi_quickjs_set_last_error(env, napi_number_expected, "A number was expected");
    }
    if (JS_ToUint32(env->context(), result, local) < 0)
    {
      return napi_util__::return_pending_if_caught(env, "Exception during uint32 coercion");
    }
    return napi_quickjs_clear_last_error(env);
  }

  napi_status NAPI_CDECL napi_get_value_int32(napi_env env,
                                              napi_value value,
                                              int32_t *result)
  {
    if (!napi_util__::check_value(env, value) || result == nullptr)
    {
      return napi_quickjs_set_last_error(env, napi_invalid_arg, "Invalid argument");
    }
    JSValue local = napi_quickjs_value_inner(env, value);
    if (!JS_IsNumber(local))
    {
      return napi_quickjs_set_last_error(env, napi_number_expected, "A number was expected");
    }
    if (JS_ToInt32(env->context(), result, local) < 0)
    {
      return napi_util__::return_pending_if_caught(env, "Exception during int32 coercion");
    }
    return napi_quickjs_clear_last_error(env);
  }

  napi_status NAPI_CDECL napi_get_value_int64(napi_env env,
                                              napi_value value,
                                              int64_t *result)
  {
    if (!napi_util__::check_value(env, value) || result == nullptr)
    {
      return napi_quickjs_set_last_error(env, napi_invalid_arg, "Invalid argument");
    }
    JSValue local = napi_quickjs_value_inner(env, value);
    if (!JS_IsNumber(local))
    {
      return napi_quickjs_set_last_error(env, napi_number_expected, "A number was expected");
    }

    double number = 0;
    if (JS_ToFloat64(env->context(), &number, local) < 0)
    {
      return napi_util__::return_pending_if_caught(env, "Exception during int64 coercion");
    }

    if (!std::isfinite(number))
    {
      *result = 0;
    }
    else if (number >= 9223372036854775808.0)
    {
      *result = std::numeric_limits<int64_t>::max();
    }
    else if (number <= -9223372036854775808.0)
    {
      *result = std::numeric_limits<int64_t>::min();
    }
    else
    {
      *result = static_cast<int64_t>(number);
    }

    return napi_quickjs_clear_last_error(env);
  }

  napi_status NAPI_CDECL napi_get_value_bigint_int64(napi_env env,
                                                     napi_value value,
                                                     int64_t *result,
                                                     bool *lossless)
  {
    if (!napi_util__::check_env(env) || value == nullptr || result == nullptr || lossless == nullptr)
      return napi_invalid_arg;

    JSValue local = napi_quickjs_value_inner(env, value);
    if (!JS_IsBigInt(local))
      return napi_bigint_expected;

    int rc = JS_ToBigInt64(env->context(), result, local);
    *lossless = (rc == 0) && napi_util__::bigint_fits_signed64(env->context(), local);
    if (rc != 0)
    {
      // Clear the exception — lossless=false is the signal, not an error
      JSValue exc = JS_GetException(env->context());
      JS_FreeValue(env->context(), exc);
      // Saturate: re-extract as uint64 and reinterpret for the truncated bits
      uint64_t u = 0;
      JS_ToBigUint64(env->context(), &u, local);
      *result = static_cast<int64_t>(u);
    }
    return napi_ok;
  }

  napi_status NAPI_CDECL napi_get_value_bigint_uint64(napi_env env,
                                                      napi_value value,
                                                      uint64_t *result,
                                                      bool *lossless)
  {
    if (!napi_util__::check_env(env) || value == nullptr || result == nullptr || lossless == nullptr)
      return napi_invalid_arg;

    JSValue local = napi_quickjs_value_inner(env, value);
    if (!JS_IsBigInt(local))
      return napi_bigint_expected;

    int rc = JS_ToBigUint64(env->context(), result, local);
    *lossless = (rc == 0) && napi_util__::bigint_fits_unsigned64(env->context(), local);
    if (rc != 0)
    {
      JSValue exc = JS_GetException(env->context());
      JS_FreeValue(env->context(), exc);
      // Truncated bits via int64 reinterpret
      int64_t s = 0;
      JS_ToBigInt64(env->context(), &s, local);
      *result = static_cast<uint64_t>(s);
    }
    return napi_ok;
  }

  napi_status NAPI_CDECL napi_get_value_bigint_words(napi_env env,
                                                     napi_value value,
                                                     int *sign_bit,
                                                     size_t *word_count,
                                                     uint64_t *words)
  {
    if (!napi_util__::check_env(env) || value == nullptr || word_count == nullptr)
      return napi_invalid_arg;

    JSValue local = napi_quickjs_value_inner(env, value);
    if (!JS_IsBigInt(local))
      return napi_bigint_expected;

    bool negative = false;
    std::vector<uint64_t> bigint_words = napi_util__::bigint_words_from_decimal(env->context(), local, &negative);
    if (bigint_words.empty())
      bigint_words.push_back(0);

    if (sign_bit != nullptr)
      *sign_bit = negative ? 1 : 0;

    if (words == nullptr)
    {
      *word_count = bigint_words.size();
      return napi_ok;
    }

    size_t capacity = *word_count;
    size_t copied = (capacity < bigint_words.size()) ? capacity : bigint_words.size();
    for (size_t i = 0; i < copied; ++i)
    {
      words[i] = bigint_words[i];
    }
    *word_count = bigint_words.size();
    return napi_ok;
  }

  napi_status NAPI_CDECL napi_is_date(napi_env env, napi_value value, bool *is_date)
  {
    if (!napi_util__::check_value(env, value) || is_date == nullptr)
      return napi_invalid_arg;

    *is_date = JS_IsDate(napi_quickjs_value_inner(env, value));
    return napi_ok;
  }

  napi_status NAPI_CDECL napi_get_date_value(napi_env env, napi_value value, double *result)
  {
    if (!napi_util__::check_value(env, value) || result == nullptr)
      return napi_invalid_arg;

    JSValue local = napi_quickjs_value_inner(env, value);
    if (!JS_IsDate(local))
      return napi_date_expected;

    // No JS_GetDateValue in QuickJS — call .valueOf() which returns the epoch ms
    JSValue valueOf = JS_GetPropertyStr(env->context(), local, "valueOf");
    if (JS_IsException(valueOf))
      return napi_util__::return_pending_if_caught(env, "Failed to get Date.valueOf");

    JSValue ms = JS_Call(env->context(), valueOf, local, 0, nullptr);
    JS_FreeValue(env->context(), valueOf);

    if (JS_IsException(ms))
      return napi_util__::return_pending_if_caught(env, "Failed to call Date.valueOf");

    int rc = JS_ToFloat64(env->context(), result, ms);
    JS_FreeValue(env->context(), ms);

    if (rc != 0)
      return napi_util__::return_pending_if_caught(env, "Failed to convert Date value to float64");

    return napi_ok;
  }

  napi_status NAPI_CDECL napi_is_arraybuffer(napi_env env, napi_value value, bool *result)
  {
    if (!napi_util__::check_value(env, value) || result == nullptr)
      return napi_util__::invalid_arg(env);
    JSValue local = napi_quickjs_value_inner(env, value);
    if (JS_IsUndefined(local) || JS_IsNull(local))
    {
      *result = false;
      return napi_quickjs_clear_last_error(env);
    }
    *result = JS_IsArrayBuffer(local);
    return napi_quickjs_clear_last_error(env);
  }

  napi_status NAPI_CDECL napi_get_arraybuffer_info(napi_env env,
                                                   napi_value arraybuffer,
                                                   void **data,
                                                   size_t *byte_length)
  {
    if (!napi_util__::check_value(env, arraybuffer))
      return napi_util__::invalid_arg(env);

    size_t len = 0;
    uint8_t *ptr = JS_GetArrayBuffer(env->context(), &len, napi_quickjs_value_inner(env, arraybuffer));
    if (ptr == nullptr && len == 0 && JS_HasException(env->context()))
    {
      JSValue exc = JS_GetException(env->context());
      JS_FreeValue(env->context(), exc);
      return napi_quickjs_set_last_error(env, napi_invalid_arg, "Invalid argument");
    }

    if (data != nullptr)
      *data = ptr;
    if (byte_length != nullptr)
      *byte_length = len;
    return napi_quickjs_clear_last_error(env);
  }

  napi_status NAPI_CDECL node_api_is_sharedarraybuffer(napi_env env,
                                                       napi_value value,
                                                       bool *result)
  {
    if (!napi_util__::check_value(env, value) || result == nullptr)
      return napi_util__::invalid_arg(env);

    if (JS_IsArrayBuffer(napi_quickjs_value_inner(env, value)))
    {
      *result = false;
      return napi_quickjs_clear_last_error(env);
    }

    size_t len = 0;
    uint8_t *ptr = JS_GetArrayBuffer(env->context(), &len, napi_quickjs_value_inner(env, value));
    if (ptr == nullptr && len == 0 && JS_HasException(env->context()))
    {
      JSValue exc = JS_GetException(env->context());
      JS_FreeValue(env->context(), exc);
      *result = false;
      return napi_quickjs_clear_last_error(env);
    }
    *result = true;
    return napi_quickjs_clear_last_error(env);
  }

  napi_status NAPI_CDECL node_api_create_sharedarraybuffer(napi_env env,
                                                           size_t byte_length,
                                                           void **data,
                                                           napi_value *result)
  {
    if (!napi_util__::check_env(env) || result == nullptr)
      return napi_util__::invalid_arg(env);

    auto buf = static_cast<uint8_t *>(
        napi_shared_array_buffer__::alloc(nullptr, byte_length > 0 ? byte_length : 1));
    if (buf == nullptr)
      return napi_generic_failure;

    JSValue sab = JS_NewArrayBuffer(env->context(), buf, byte_length, nullptr, nullptr, true);
    if (JS_IsException(sab))
    {
      napi_shared_array_buffer__::free_data(buf);
      return napi_util__::return_pending_if_caught(env, "Failed to create SharedArrayBuffer");
    }

    if (data != nullptr)
      *data = buf;
    *result = env->wrap_value_in_current_scope(sab, true);
    return (*result == nullptr) ? napi_generic_failure : napi_quickjs_clear_last_error(env);
  }

  napi_status NAPI_CDECL napi_create_dataview(napi_env env,
                                              size_t length,
                                              napi_value arraybuffer,
                                              size_t byte_offset,
                                              napi_value *result)
  {
    if (!napi_util__::check_value(env, arraybuffer) || result == nullptr)
      return napi_util__::invalid_arg(env);

    size_t ab_len = 0;
    uint8_t *ab_data = JS_GetArrayBuffer(env->context(), &ab_len, napi_quickjs_value_inner(env, arraybuffer));
    if (ab_data == nullptr && ab_len == 0 && JS_HasException(env->context()))
      return napi_util__::return_pending_if_caught(env, "ArrayBuffer expected");

    JSValue global = JS_GetGlobalObject(env->context());
    JSValue ctor = JS_GetPropertyStr(env->context(), global, "DataView");
    JS_FreeValue(env->context(), global);
    if (JS_IsException(ctor))
      return napi_util__::return_pending_if_caught(env, "Failed to get DataView constructor");

    JSValue args[] = {
        napi_quickjs_value_inner(env, arraybuffer),
        JS_NewInt64(env->context(), static_cast<int64_t>(byte_offset)),
        JS_NewInt64(env->context(), static_cast<int64_t>(length))};
    JSValue view = JS_CallConstructor(env->context(), ctor, 3, args);
    JS_FreeValue(env->context(), args[1]);
    JS_FreeValue(env->context(), args[2]);
    JS_FreeValue(env->context(), ctor);
    if (JS_IsException(view))
      return napi_util__::return_pending_if_caught(env, "DataView construction threw");

    *result = env->wrap_value_in_current_scope(view, true);
    return (*result == nullptr) ? napi_generic_failure : napi_quickjs_clear_last_error(env);
  }

  napi_status NAPI_CDECL napi_is_dataview(napi_env env, napi_value value, bool *result)
  {
    if (!napi_util__::check_value(env, value) || result == nullptr)
      return napi_util__::invalid_arg(env);
    *result = JS_IsDataView(napi_quickjs_value_inner(env, value));
    return napi_quickjs_clear_last_error(env);
  }

  napi_status NAPI_CDECL napi_get_dataview_info(napi_env env,
                                                napi_value dataview,
                                                size_t *byte_length,
                                                void **data,
                                                napi_value *arraybuffer,
                                                size_t *byte_offset)
  {
    if (!napi_util__::check_value(env, dataview))
      return napi_util__::invalid_arg(env);
    JSValue view = napi_quickjs_value_inner(env, dataview);
    if (!JS_IsDataView(view))
      return napi_util__::invalid_arg(env);

    JSValue len_val = JS_GetPropertyStr(env->context(), view, "byteLength");
    JSValue offset_val = JS_GetPropertyStr(env->context(), view, "byteOffset");
    JSValue buffer_val = JS_GetPropertyStr(env->context(), view, "buffer");
    if (JS_IsException(len_val) || JS_IsException(offset_val) || JS_IsException(buffer_val))
    {
      JS_FreeValue(env->context(), len_val);
      JS_FreeValue(env->context(), offset_val);
      JS_FreeValue(env->context(), buffer_val);
      return napi_util__::return_pending_if_caught(env, "Failed to get DataView info");
    }

    uint32_t len = 0;
    uint32_t offset = 0;
    JS_ToUint32(env->context(), &len, len_val);
    JS_ToUint32(env->context(), &offset, offset_val);
    JS_FreeValue(env->context(), len_val);
    JS_FreeValue(env->context(), offset_val);

    if (byte_length != nullptr)
      *byte_length = len;
    if (byte_offset != nullptr)
      *byte_offset = offset;
    if (data != nullptr)
    {
      size_t ab_len = 0;
      uint8_t *ab_data = JS_GetArrayBuffer(env->context(), &ab_len, buffer_val);
      if (ab_data == nullptr && ab_len == 0 && JS_HasException(env->context()))
      {
        JS_FreeValue(env->context(), buffer_val);
        return napi_util__::return_pending_if_caught(env, "Failed to get DataView ArrayBuffer");
      }
      *data = ab_data + offset;
    }
    if (arraybuffer != nullptr)
    {
      *arraybuffer = env->wrap_value_in_current_scope(buffer_val, true);
      if (*arraybuffer == nullptr)
      {
        JS_FreeValue(env->context(), buffer_val);
        return napi_generic_failure;
      }
    }
    else
    {
      JS_FreeValue(env->context(), buffer_val);
    }
    return napi_quickjs_clear_last_error(env);
  }

  napi_status NAPI_CDECL napi_is_array(napi_env env, napi_value value, bool *result)
  {
    if (!napi_util__::check_value(env, value) || result == nullptr)
      return napi_invalid_arg;
    *result = JS_IsArray(napi_quickjs_value_inner(env, value));
    return napi_ok;
  }

  napi_status NAPI_CDECL napi_get_array_length(napi_env env,
                                               napi_value value,
                                               uint32_t *result)
  {
    if (!napi_util__::check_value(env, value) || result == nullptr)
      return napi_invalid_arg;
    JSValue local = napi_quickjs_value_inner(env, value);
    if (!JS_IsArray(local))
      return napi_array_expected;

    JSValue len_val = JS_GetPropertyStr(env->context(), local, "length");
    if (JS_IsException(len_val))
    {
      return napi_util__::return_pending_if_caught(env, "Exception getting array length");
    }

    if (JS_ToUint32(env->context(), result, len_val) < 0)
    {
      JS_FreeValue(env->context(), len_val);
      return napi_util__::return_pending_if_caught(env, "Exception parsing array length");
    }

    JS_FreeValue(env->context(), len_val);
    return napi_ok;
  }

  napi_status NAPI_CDECL napi_get_element(napi_env env,
                                          napi_value object,
                                          uint32_t index,
                                          napi_value *result)
  {
    if (!napi_util__::check_value(env, object) || result == nullptr)
      return napi_util__::invalid_arg(env);
    JSValue local = napi_quickjs_value_inner(env, object);
    if (!JS_IsObject(local))
      return napi_object_expected;

    JSValue out = JS_GetPropertyUint32(env->context(), local, index);
    if (JS_IsException(out))
    {
      return napi_util__::return_pending_if_caught(env, "Exception while getting element");
    }
    *result = env->wrap_value_in_current_scope(out, true);
    return (*result == nullptr) ? napi_generic_failure : napi_ok;
  }

  napi_status NAPI_CDECL napi_set_element(napi_env env,
                                          napi_value object,
                                          uint32_t index,
                                          napi_value value)
  {
    if (!napi_util__::check_value(env, object) || value == nullptr)
      return napi_util__::invalid_arg(env);
    JSValue local = napi_quickjs_value_inner(env, object);
    if (!JS_IsObject(local))
      return napi_object_expected;

    // JS_SetPropertyUint32 consumes the value, so we must duplicate it
    if (JS_SetPropertyUint32(env->context(), local, index, JS_DupValue(env->context(), napi_quickjs_value_inner(env, value))) < 0)
    {
      return napi_util__::return_pending_if_caught(env, "Exception while setting element");
    }
    return napi_ok;
  }

  napi_status NAPI_CDECL napi_instanceof(napi_env env,
                                         napi_value object,
                                         napi_value constructor,
                                         bool *result)
  {
    if (!napi_util__::check_value(env, object) || !napi_util__::check_value(env, constructor) || result == nullptr)
    {
      return napi_util__::invalid_arg(env);
    }

    JSValue val = napi_quickjs_value_inner(env, object);
    JSValue ctor = napi_quickjs_value_inner(env, constructor);

    // Node-API generally expects the constructor to be a function.
    // The commented-out V8 code in your file also performs this check.
    if (!JS_IsFunction(env->context(), ctor))
    {
      return napi_quickjs_set_last_error(env, napi_function_expected, "A function was expected for the constructor");
    }

    // JS_IsInstanceOf returns 1 (true), 0 (false), or -1 (exception)
    int res = JS_IsInstanceOf(env->context(), val, ctor);

    if (res < 0)
    {
      return napi_util__::return_pending_if_caught(env, "Exception during instanceof check");
    }

    *result = (res != 0);
    return napi_quickjs_clear_last_error(env);
  }

  napi_status NAPI_CDECL napi_has_element(napi_env env,
                                          napi_value object,
                                          uint32_t index,
                                          bool *result)
  {
    if (!napi_util__::check_value(env, object) || result == nullptr)
      return napi_util__::invalid_arg(env);
    JSValue local = napi_quickjs_value_inner(env, object);
    if (!JS_IsObject(local))
      return napi_object_expected;

    // QuickJS doesn't have a JS_HasPropertyUint32, so we convert index to atom
    JSAtom prop = JS_NewAtomUInt32(env->context(), index);
    if (prop == JS_ATOM_NULL)
      return napi_generic_failure;

    int has = JS_HasProperty(env->context(), local, prop);
    JS_FreeAtom(env->context(), prop);

    if (has < 0)
    {
      return napi_util__::return_pending_if_caught(env, "Exception while checking element");
    }
    *result = (has != 0);
    return napi_ok;
  }

  napi_status NAPI_CDECL napi_delete_element(napi_env env,
                                             napi_value object,
                                             uint32_t index,
                                             bool *result)
  {
    if (!napi_util__::check_value(env, object))
      return napi_util__::invalid_arg(env);
    JSValue local = napi_quickjs_value_inner(env, object);
    if (!JS_IsObject(local))
      return napi_object_expected;

    JSAtom prop = JS_NewAtomUInt32(env->context(), index);
    if (prop == JS_ATOM_NULL)
      return napi_generic_failure;

    int deleted = JS_DeleteProperty(env->context(), local, prop, 0);
    JS_FreeAtom(env->context(), prop);

    if (deleted < 0)
    {
      return napi_util__::return_pending_if_caught(env, "Exception while deleting element");
    }
    if (result != nullptr)
    {
      *result = (deleted != 0);
    }
    return napi_ok;
  }

  napi_status NAPI_CDECL napi_get_cb_info(napi_env env,
                                          napi_callback_info cbinfo,
                                          size_t *argc,
                                          napi_value *argv,
                                          napi_value *this_arg,
                                          void **data)
  {
    if (cbinfo == nullptr)
    {
      return napi_util__::invalid_arg(env);
    }

    // Cast the opaque pointer back to our internal structure
    auto *info = reinterpret_cast<napi_callback_info__ *>(cbinfo);

    // 1. Handle Arguments (argv) and Argument Count (argc)
    if (argc != nullptr)
    {
      if (argv != nullptr)
      {
        size_t i = 0;
        // Node-API Rule: Copy up to the size of the provided buffer (*argc)
        // or the actual number of arguments (info->argc).
        size_t count = (*argc < info->argc()) ? *argc : info->argc();

        for (i = 0; i < count; i++)
        {
          argv[i] = env->wrap_value_in_current_scope(info->arg(i), false);
        }

        // Node-API Rule: If the user provided a larger buffer than actual arguments,
        // fill the remaining slots with 'undefined'.
        for (; i < *argc; i++)
        {
          argv[i] = env->wrap_value_in_current_scope(JS_UNDEFINED, true);
        }
      }

      // Always update *argc to the actual number of arguments available.
      *argc = info->argc();
    }

    // 2. Handle the 'this' argument
    if (this_arg != nullptr)
    {
      *this_arg = env->wrap_value_in_current_scope(info->this_value(), false);
    }

    // 3. Handle the user data pointer
    if (data != nullptr)
    {
      *data = info->data();
    }

    return napi_ok;
  }

  napi_status napi_get_new_target(napi_env env,
                                  napi_callback_info cbinfo,
                                  napi_value *result)
  {
    if (env == nullptr || cbinfo == nullptr || result == nullptr)
    {
      return napi_invalid_arg;
    }

    // In Node-API, if the function was NOT called with 'new',
    // new_target should return NULL (nullptr).
    if (JS_IsUndefined(cbinfo->new_target()))
    {
      *result = nullptr;
    }
    else
    {
      *result = env->wrap_value_in_current_scope(cbinfo->new_target(), false);
    }

    return napi_ok;
  }

  napi_status NAPI_CDECL napi_open_handle_scope(napi_env env, napi_handle_scope *result)
  {
    if (!napi_util__::check_env(env) || result == nullptr)
      return napi_invalid_arg;

    napi_handle_scope scope = env->create_scope(env->current_scope());
    if (scope == nullptr)
      return napi_generic_failure;

    env->set_current_scope(scope);
    *result = scope;
    return napi_ok;
  }

  napi_status NAPI_CDECL napi_close_handle_scope(napi_env env, napi_handle_scope scope)
  {
    if (!napi_util__::check_env(env) || scope == nullptr)
      return napi_invalid_arg;
    if (!env->is_current_scope(scope))
      return napi_util__::invalid_arg(env);

    napi_scope__ *inner = env->scope_from_handle(scope);
    if (inner == nullptr)
      return napi_util__::invalid_arg(env);
    env->set_current_scope(inner->parent_handle());
    env->destroy_scope(scope);
    return napi_ok;
  }

  napi_status NAPI_CDECL napi_open_escapable_handle_scope(napi_env env,
                                                          napi_escapable_handle_scope *result)
  {
    if (!napi_util__::check_env(env) || result == nullptr)
      return napi_invalid_arg;

    napi_handle_scope scope = env->create_scope(env->current_scope());
    if (scope == nullptr)
      return napi_generic_failure;

    env->set_current_scope(scope);
    *result = reinterpret_cast<napi_escapable_handle_scope>(scope);
    return napi_ok;
  }

  napi_status NAPI_CDECL napi_close_escapable_handle_scope(napi_env env,
                                                           napi_escapable_handle_scope scope)
  {
    if (!napi_util__::check_env(env) || scope == nullptr)
      return napi_invalid_arg;
    napi_handle_scope handle = reinterpret_cast<napi_handle_scope>(scope);
    if (!env->is_current_scope(handle))
      return napi_util__::invalid_arg(env);

    napi_scope__ *inner = env->scope_from_handle(handle);
    if (inner == nullptr)
      return napi_util__::invalid_arg(env);
    env->set_current_scope(inner->parent_handle());
    env->destroy_scope(handle);
    return napi_ok;
  }

  napi_status NAPI_CDECL napi_escape_handle(napi_env env,
                                            napi_escapable_handle_scope scope,
                                            napi_value escapee,
                                            napi_value *result)
  {
    if (!napi_util__::check_env(env) || scope == nullptr || escapee == nullptr || result == nullptr)
      return napi_invalid_arg;

    napi_handle_scope handle = reinterpret_cast<napi_handle_scope>(scope);
    napi_scope__ *inner = env->scope_from_handle(handle);
    if (inner == nullptr)
      return napi_util__::invalid_arg(env);

    if (inner->has_escaped())
      return napi_escape_called_twice;

    inner->mark_escaped();
    *result = inner->escape_value(escapee);
    return (*result == nullptr) ? napi_generic_failure : napi_ok;
  }

  napi_status NAPI_CDECL napi_create_function(napi_env env,
                                              const char *utf8name,
                                              size_t length,
                                              napi_callback cb,
                                              void *data,
                                              napi_value *result)
  {
    return napi_function__::create(env, utf8name, length, cb, data, 0, result);
  }

  napi_status NAPI_CDECL napi_define_class(napi_env env,
                                           const char *utf8name,
                                           size_t length,
                                           napi_callback constructor,
                                           void *data,
                                           size_t property_count,
                                           const napi_property_descriptor *properties,
                                           napi_value *result)
  {
    if (env == nullptr)
      return napi_invalid_arg;
    if (utf8name == nullptr || constructor == nullptr || result == nullptr)
    {
      return napi_util__::invalid_arg(env);
    }
    if (property_count > 0 && properties == nullptr)
    {
      return napi_util__::invalid_arg(env);
    }

    JSContext *ctx = env->context();

    // 1. Create the constructor function
    // We reuse napi_create_function which handles the JS-to-C trampoline for Node-API.
    napi_value ctor_napi_value = nullptr;
    napi_status status = napi_function__::create(
        env, utf8name, length, constructor, data, 0, &ctor_napi_value);
    if (status != napi_ok)
      return status;

    // 2. Setup the prototype chain
    JSValue ctor = napi_quickjs_value_inner(env, ctor_napi_value);
    JSValue proto = JS_NewObject(ctx);

    JS_SetConstructor(ctx, ctor, proto);
    JS_SetConstructorBit(ctx, ctor, true);

    // 3. Iterate over the descriptors and define them
    for (size_t i = 0; i < property_count; ++i)
    {
      const napi_property_descriptor &desc = properties[i];

      // Target is Constructor for static methods, Prototype for instance methods
      JSValue target = (desc.attributes & napi_static) ? ctor : proto;

      // Resolve property key into a JSAtom
      JSAtom key;
      if (desc.utf8name != nullptr)
      {
        key = JS_NewAtom(ctx, desc.utf8name);
      }
      else if (desc.name != nullptr)
      {
        JSValue name_val = napi_quickjs_value_inner(env, desc.name);
        if (!JS_IsString(name_val) && !JS_IsSymbol(name_val))
        {
          JS_FreeValue(ctx, proto);
          return napi_name_expected;
        }
        key = JS_ValueToAtom(ctx, name_val);
      }
      else
      {
        JS_FreeValue(ctx, proto);
        return napi_name_expected;
      }

      // Map Node-API attributes to QuickJS internal property flags
      int base_flags = JS_PROP_HAS_CONFIGURABLE | JS_PROP_HAS_ENUMERABLE;
      if (desc.attributes & napi_enumerable)
        base_flags |= JS_PROP_ENUMERABLE;
      if (desc.attributes & napi_configurable)
        base_flags |= JS_PROP_CONFIGURABLE;

      if (desc.method != nullptr)
      {
        // --- Methods ---
        int method_flags = base_flags | JS_PROP_HAS_WRITABLE;
        if (desc.attributes & napi_writable)
          method_flags |= JS_PROP_WRITABLE;

        napi_value method_val = nullptr;
        status = napi_function__::create(
            env, desc.utf8name, NAPI_AUTO_LENGTH, desc.method, desc.data, JS_CFUNC_generic_magic, &method_val);

        if (status == napi_ok)
        {
          JS_DefinePropertyValue(ctx, target, key,
                                 JS_DupValue(ctx, napi_quickjs_value_inner(env, method_val)),
                                 method_flags);
        }
      }
      else if (desc.getter != nullptr || desc.setter != nullptr)
      {
        // --- Accessors (Getters / Setters) ---
        JSValue getter = JS_UNDEFINED;
        JSValue setter = JS_UNDEFINED;

        if (desc.getter != nullptr)
        {
          napi_value g_val = nullptr;
          if (napi_function__::create(env, desc.utf8name, NAPI_AUTO_LENGTH, desc.getter, desc.data, JS_CFUNC_getter_magic, &g_val) == napi_ok)
          {
            getter = JS_DupValue(ctx, napi_quickjs_value_inner(env, g_val));
          }
        }
        if (desc.setter != nullptr)
        {
          napi_value s_val = nullptr;
          if (napi_function__::create(env, desc.utf8name, NAPI_AUTO_LENGTH, desc.setter, desc.data, JS_CFUNC_setter_magic, &s_val) == napi_ok)
          {
            setter = JS_DupValue(ctx, napi_quickjs_value_inner(env, s_val));
          }
        }

        int accessor_flags = base_flags | JS_PROP_HAS_GET | JS_PROP_HAS_SET;
        JS_DefinePropertyGetSet(ctx, target, key, getter, setter, accessor_flags);
      }
      else if (desc.value != nullptr)
      {
        // --- Standard Values ---
        int value_flags = base_flags | JS_PROP_HAS_WRITABLE;
        if (desc.attributes & napi_writable)
          value_flags |= JS_PROP_WRITABLE;

        JSValue val = JS_DupValue(ctx, napi_quickjs_value_inner(env, desc.value));
        JS_DefinePropertyValue(ctx, target, key, val, value_flags);
      }

      JS_FreeAtom(ctx, key);

      // Fail out safely if property creation failed
      if (status != napi_ok)
      {
        JS_FreeValue(ctx, proto);
        return status;
      }
    }

    JS_FreeValue(ctx, proto);
    *result = ctor_napi_value;
    return napi_ok;
  }

  napi_status napi_new_instance(napi_env env,
                                napi_value constructor,
                                size_t argc,
                                const napi_value *argv,
                                napi_value *result)
  {
    // 1. Basic validation
    if (env == nullptr || constructor == nullptr || result == nullptr)
    {
      return napi_invalid_arg;
    }

    JSContext *ctx = napi_quickjs_value_context(env, constructor);
    if (ctx == nullptr)
    {
      return napi_invalid_arg;
    }
    napi_env_context_scope__ context_scope{env, ctx};

    // 2. Unwrap the constructor JSValue
    // Assuming 'unwrap_value' is your helper to get the JSValue from napi_value
    JSValue ctor_val = napi_quickjs_value_inner(env, constructor);

    // 3. Prepare the arguments
    // QuickJS's JS_CallConstructor expects an array of JSValue.
    // Since napi_value is usually a typedef for JSValue (or a pointer to it),
    // we can often cast the array if the memory layout matches,
    // but a safe stack allocation is better for compatibility.
    std::vector<JSValue> js_argv = napi_util__::prepare_call_args(env, argc, argv);

    // 4. Call the constructor
    const size_t js_argc = js_argv.size();
    const bool has_args = js_argc != 0;
    JSValue instance = has_args
                           ? JS_CallConstructor(ctx, ctor_val, (int)js_argc, js_argv.data())
                           : JS_CallConstructor(ctx, ctor_val, 0, nullptr);

    // 5. Check for exceptions
    if (JS_IsException(instance))
    {
      return napi_util__::return_pending_if_caught(env, ctx, "Exception during constructor call");
    }

    // 6. Wrap and return
    // 'wrap_value' converts the JSValue back into the napi_value handle
    *result = env->wrap_value_in_current_scope(ctx, instance, true);

    return napi_ok;
  }

  napi_status NAPI_CDECL napi_call_function(napi_env env,
                                            napi_value recv,
                                            napi_value func,
                                            size_t argc,
                                            const napi_value *argv,
                                            napi_value *result)
  {
    // 1. Basic Validation
    if (!napi_util__::check_env(env) || func == nullptr)
    {
      return napi_util__::invalid_arg(env);
    }
    if (argc > 0 && argv == nullptr)
    {
      return napi_util__::invalid_arg(env);
    }

    JSContext *ctx = napi_quickjs_value_context(env, func);
    if (ctx == nullptr)
    {
      return napi_util__::invalid_arg(env);
    }
    napi_env_context_scope__ context_scope{env, ctx};

    JSValue js_func = napi_quickjs_value_inner(env, func);

    // 2. Ensure the target is actually a function
    if (!JS_IsFunction(ctx, js_func))
    {
      return napi_quickjs_set_last_error(env, napi_function_expected, "Target is not a function");
    }

    // 3. Resolve the receiver ('this' object)
    // If recv is null, Node-API defaults to 'undefined'
    JSValue js_recv = (recv != nullptr) ? napi_quickjs_value_inner(env, recv) : JS_UNDEFINED;

    // 4. Prepare the arguments array
    std::vector<JSValue> js_argv = napi_util__::prepare_call_args(env, argc, argv);

    // 5. Perform the call
    const size_t js_argc = js_argv.size();
    const bool has_args = js_argc != 0;
    JSValue js_result = has_args
                            ? JS_Call(ctx, js_func, js_recv, (int)js_argc, js_argv.data())
                            : JS_Call(ctx, js_func, js_recv, 0, nullptr);

    // 6. Handle Exceptions
    if (JS_IsException(js_result))
    {
      return napi_util__::return_pending_if_caught(env, ctx, "Exception during function call");
    }

    // 7. Handle the Result
    if (result != nullptr)
    {
      // wrap the result; the current handle scope now owns the returned JSValue
      *result = env->wrap_value_in_current_scope(ctx, js_result, true);
    }
    else
    {
      // If the caller doesn't want the result, we must free it to avoid leaks
      JS_FreeValue(ctx, js_result);
    }

    return napi_ok;
  }

  napi_status NAPI_CDECL napi_define_properties(napi_env env,
                                                napi_value object,
                                                size_t property_count,
                                                const napi_property_descriptor *properties)
  {
    if (!napi_util__::check_value(env, object))
      return napi_util__::invalid_arg(env);

    if (property_count > 0 && properties == nullptr)
      return napi_util__::invalid_arg(env);

    JSValue obj = napi_quickjs_value_inner(env, object);
    if (!JS_IsObject(obj))
      return napi_object_expected;

    for (size_t i = 0; i < property_count; i++)
    {
      const napi_property_descriptor &p = properties[i];
      JSAtom prop_name = JS_ATOM_NULL;

      // 1. Resolve the Property Name (Atom)
      if (p.utf8name != nullptr)
      {
        prop_name = JS_NewAtom(env->context(), p.utf8name);
      }
      else if (p.name != nullptr)
      {
        JSValue name_val = napi_quickjs_value_inner(env, p.name);
        prop_name = JS_ValueToAtom(env->context(), name_val);
      }
      else
      {
        return napi_invalid_arg;
      }

      if (prop_name == JS_ATOM_NULL)
        return napi_util__::return_pending_if_caught(env, "Failed to create Atom");

      // 2. Map Node-API attributes to QuickJS flags
      int flags = JS_PROP_HAS_CONFIGURABLE | JS_PROP_HAS_ENUMERABLE;
      if (p.attributes & napi_enumerable)
        flags |= JS_PROP_ENUMERABLE;
      if (p.attributes & napi_configurable)
        flags |= JS_PROP_CONFIGURABLE;

      napi_status status = napi_ok;

      // 3. Define Accessors (Getter/Setter)
      if (p.getter != nullptr || p.setter != nullptr)
      {
        JSValue getter = JS_UNDEFINED;
        JSValue setter = JS_UNDEFINED;

        if (p.getter != nullptr)
        {
          getter = napi_function__::create_internal(env, p.utf8name, p.getter, p.data);
          if (JS_IsException(getter))
          {
            JS_FreeAtom(env->context(), prop_name);
            return napi_util__::return_pending_if_caught(env, "Failed to create getter");
          }
        }

        if (p.setter != nullptr)
        {
          setter = napi_function__::create_internal(env, p.utf8name, p.setter, p.data);
          if (JS_IsException(setter))
          {
            JS_FreeValue(env->context(), getter);
            JS_FreeAtom(env->context(), prop_name);
            return napi_util__::return_pending_if_caught(env, "Failed to create setter");
          }
        }

        if (JS_DefineProperty(env->context(), obj, prop_name, JS_UNDEFINED, getter, setter,
                              flags | JS_PROP_HAS_GET | JS_PROP_HAS_SET) < 0)
        {
          status = napi_util__::return_pending_if_caught(env, "Failed to define accessor");
        }

        JS_FreeValue(env->context(), getter);
        JS_FreeValue(env->context(), setter);
      }

      // 4. Define Methods
      else if (p.method != nullptr)
      {
        JSValue method_fn = napi_function__::create_internal(env, p.utf8name, p.method, p.data);
        if (JS_IsException(method_fn))
        {
          JS_FreeAtom(env->context(), prop_name);
          return napi_util__::return_pending_if_caught(env, "Failed to create method");
        }
        status = napi_function__::make_constructible(env, method_fn);
        if (status != napi_ok)
        {
          JS_FreeAtom(env->context(), prop_name);
          JS_FreeValue(env->context(), method_fn);
          return status;
        }

        int method_flags = flags | JS_PROP_HAS_VALUE;
        if (p.attributes & napi_writable)
          method_flags |= JS_PROP_WRITABLE | JS_PROP_HAS_WRITABLE;

        if (JS_DefinePropertyValue(env->context(), obj, prop_name, method_fn, method_flags) < 0)
        {
          status = napi_util__::return_pending_if_caught(env, "Failed to define method");
        }
      }

      // 5. Define Data Properties (Value)
      else
      {
        int data_flags = flags | JS_PROP_HAS_VALUE;
        if (p.attributes & napi_writable)
          data_flags |= JS_PROP_WRITABLE | JS_PROP_HAS_WRITABLE;

        JSValue value = JS_DupValue(env->context(), napi_quickjs_value_inner(env, p.value));
        if (JS_DefinePropertyValue(env->context(), obj, prop_name, value, data_flags) < 0)
        {
          status = napi_util__::return_pending_if_caught(env, "Failed to define data property");
        }
      }

      JS_FreeAtom(env->context(), prop_name);
      if (status != napi_ok)
        return status;
    }

    return napi_ok;
  }

  napi_status NAPI_CDECL napi_create_promise(napi_env env,
                                             napi_deferred *deferred,
                                             napi_value *promise)
  {
    if (!napi_util__::check_env(env) || deferred == nullptr || promise == nullptr)
      return napi_invalid_arg;

    JSContext *ctx = env->context();
    JSValue resolving_funcs[2];
    JSValue p = JS_NewPromiseCapability(ctx, resolving_funcs);
    if (JS_IsException(p))
      return napi_util__::return_pending_if_caught(env, ctx, "Failed to create Promise");

    auto *d = napi_deferred__::create(env, ctx, resolving_funcs[0], resolving_funcs[1]);
    if (d == nullptr)
    {
      JS_FreeValue(ctx, resolving_funcs[0]);
      JS_FreeValue(ctx, resolving_funcs[1]);
      JS_FreeValue(ctx, p);
      return napi_generic_failure;
    }

    *deferred = d;
    *promise = env->wrap_value_in_current_scope(ctx, p, true);
    return (*promise == nullptr) ? napi_generic_failure : napi_ok;
  }

  napi_status NAPI_CDECL napi_resolve_deferred(napi_env env,
                                               napi_deferred deferred,
                                               napi_value resolution)
  {
    if (!napi_util__::check_env(env) || deferred == nullptr || resolution == nullptr)
      return napi_invalid_arg;

    JSContext *ctx = deferred->context();
    if (ctx == nullptr)
      return napi_invalid_arg;

    napi_env_context_scope__ context_scope{env, ctx};
    JSValue ret = deferred->call_resolve(resolution);
    napi_deferred__::destroy(deferred);

    if (JS_IsException(ret))
      return napi_util__::return_pending_if_caught(env, ctx, "Failed to resolve promise");

    JS_FreeValue(ctx, ret);
    return napi_ok;
  }

  napi_status NAPI_CDECL napi_reject_deferred(napi_env env,
                                              napi_deferred deferred,
                                              napi_value rejection)
  {
    if (!napi_util__::check_env(env) || deferred == nullptr || rejection == nullptr)
      return napi_invalid_arg;

    JSContext *ctx = deferred->context();
    if (ctx == nullptr)
      return napi_invalid_arg;

    napi_env_context_scope__ context_scope{env, ctx};
    JSValue ret = deferred->call_reject(rejection);
    napi_deferred__::destroy(deferred);

    if (JS_IsException(ret))
      return napi_util__::return_pending_if_caught(env, ctx, "Failed to reject promise");

    JS_FreeValue(ctx, ret);
    return napi_ok;
  }

  napi_status NAPI_CDECL napi_is_promise(napi_env env, napi_value value, bool *is_promise)
  {
    if (!napi_util__::check_value(env, value) || is_promise == nullptr)
      return napi_invalid_arg;

    *is_promise = JS_IsPromise(napi_quickjs_value_inner(env, value));
    return napi_ok;
  }

  napi_status NAPI_CDECL napi_has_named_property(napi_env env,
                                                 napi_value object,
                                                 const char *utf8name,
                                                 bool *result)
  {
    if (!napi_util__::check_value(env, object) || utf8name == nullptr || result == nullptr)
    {
      return napi_util__::invalid_arg(env);
    }
    JSValue local = napi_quickjs_value_inner(env, object);
    if (!JS_IsObject(local))
      return napi_object_expected;

    JSAtom prop = JS_NewAtom(env->context(), utf8name);
    if (prop == JS_ATOM_NULL)
      return napi_generic_failure;

    int has = JS_HasProperty(env->context(), local, prop);
    JS_FreeAtom(env->context(), prop);

    if (has < 0)
    {
      return napi_util__::return_pending_if_caught(env, "Exception while checking named property");
    }
    *result = (has != 0);
    return napi_ok;
  }

  napi_status NAPI_CDECL napi_set_property(napi_env env,
                                           napi_value object,
                                           napi_value key,
                                           napi_value value)
  {
    if (!napi_util__::check_value(env, object) || !napi_util__::check_value(env, key) || !napi_util__::check_value(env, value))
    {
      return napi_util__::invalid_arg(env);
    }
    JSValue local = napi_quickjs_value_inner(env, object);
    if (!JS_IsObject(local))
      return napi_object_expected;

    JSValue key_value = napi_quickjs_value_inner(env, key);
    if (!JS_IsString(key_value) && !JS_IsSymbol(key_value))
      return napi_quickjs_set_last_error(env, napi_name_expected, "A string or symbol was expected");

    JSAtom prop = JS_ValueToAtom(env->context(), key_value);
    if (prop == JS_ATOM_NULL)
      return napi_util__::return_pending_if_caught(env, "Invalid key");

    int res = set_property_with_node_compat(env->context(), local, prop, napi_quickjs_value_inner(env, value));
    JS_FreeAtom(env->context(), prop);

    if (res < 0)
    {
      return napi_util__::return_pending_if_caught(env, "Exception while setting property");
    }
    return napi_ok;
  }

  napi_status NAPI_CDECL napi_get_property(napi_env env,
                                           napi_value object,
                                           napi_value key,
                                           napi_value *result)
  {
    if (!napi_util__::check_value(env, object) || !napi_util__::check_value(env, key) || result == nullptr)
    {
      return napi_util__::invalid_arg(env);
    }
    JSValue local = napi_quickjs_value_inner(env, object);
    if (!JS_IsObject(local))
      return napi_object_expected;

    JSValue key_value = napi_quickjs_value_inner(env, key);
    if (!JS_IsString(key_value) && !JS_IsSymbol(key_value))
      return napi_quickjs_set_last_error(env, napi_name_expected, "A string or symbol was expected");

    JSAtom prop = JS_ValueToAtom(env->context(), key_value);
    if (prop == JS_ATOM_NULL)
      return napi_util__::return_pending_if_caught(env, "Invalid key");

    JSValue out = JS_GetProperty(env->context(), local, prop);
    JS_FreeAtom(env->context(), prop);

    if (JS_IsException(out))
    {
      return napi_util__::return_pending_if_caught(env, "Exception while getting property");
    }
    *result = env->wrap_value_in_current_scope(out, true);
    return (*result == nullptr) ? napi_generic_failure : napi_ok;
  }

  napi_status NAPI_CDECL napi_has_property(napi_env env,
                                           napi_value object,
                                           napi_value key,
                                           bool *result)
  {
    if (!napi_util__::check_value(env, object) || !napi_util__::check_value(env, key) || result == nullptr)
    {
      return napi_util__::invalid_arg(env);
    }
    JSValue local = napi_quickjs_value_inner(env, object);
    if (!JS_IsObject(local))
      return napi_object_expected;

    JSValue key_value = napi_quickjs_value_inner(env, key);
    if (!JS_IsString(key_value) && !JS_IsSymbol(key_value))
      return napi_quickjs_set_last_error(env, napi_name_expected, "A string or symbol was expected");

    JSAtom prop = JS_ValueToAtom(env->context(), key_value);
    if (prop == JS_ATOM_NULL)
      return napi_util__::return_pending_if_caught(env, "Invalid key");

    int has = JS_HasProperty(env->context(), local, prop);
    JS_FreeAtom(env->context(), prop);

    if (has < 0)
    {
      return napi_util__::return_pending_if_caught(env, "Exception while checking property");
    }
    *result = (has != 0);
    return napi_ok;
  }

  napi_status NAPI_CDECL napi_delete_property(napi_env env,
                                              napi_value object,
                                              napi_value key,
                                              bool *result)
  {
    if (!napi_util__::check_value(env, object) || !napi_util__::check_value(env, key))
    {
      return napi_util__::invalid_arg(env);
    }
    JSValue local = napi_quickjs_value_inner(env, object);
    if (!JS_IsObject(local))
      return napi_object_expected;

    JSValue key_value = napi_quickjs_value_inner(env, key);
    if (!JS_IsString(key_value) && !JS_IsSymbol(key_value))
      return napi_quickjs_set_last_error(env, napi_name_expected, "A string or symbol was expected");

    JSAtom prop = JS_ValueToAtom(env->context(), key_value);
    if (prop == JS_ATOM_NULL)
      return napi_util__::return_pending_if_caught(env, "Invalid key");

    int deleted = JS_DeleteProperty(env->context(), local, prop, 0);
    JS_FreeAtom(env->context(), prop);

    if (deleted < 0)
    {
      return napi_util__::return_pending_if_caught(env, "Exception while deleting property");
    }
    if (result != nullptr)
    {
      *result = (deleted != 0);
    }
    return napi_ok;
  }

  napi_status NAPI_CDECL napi_has_own_property(napi_env env,
                                               napi_value object,
                                               napi_value key,
                                               bool *result)
  {
    if (!napi_util__::check_value(env, object) || !napi_util__::check_value(env, key) || result == nullptr)
    {
      return napi_util__::invalid_arg(env);
    }
    JSValue local = napi_quickjs_value_inner(env, object);
    if (!JS_IsObject(local))
      return napi_object_expected;

    JSValue key_value = napi_quickjs_value_inner(env, key);
    if (!JS_IsString(key_value) && !JS_IsSymbol(key_value))
      return napi_quickjs_set_last_error(env, napi_name_expected, "A string or symbol was expected");

    JSAtom prop = JS_ValueToAtom(env->context(), key_value);
    if (prop == JS_ATOM_NULL)
      return napi_util__::return_pending_if_caught(env, "Invalid key");

    // JS_GetOwnProperty returns 1 if present, 0 if not, -1 on error
    int has = JS_GetOwnProperty(env->context(), nullptr, local, prop);
    JS_FreeAtom(env->context(), prop);

    if (has < 0)
    {
      return napi_util__::return_pending_if_caught(env, "Exception while checking own property");
    }
    *result = (has != 0);
    return napi_ok;
  }

  napi_status NAPI_CDECL napi_get_property_names(napi_env env,
                                                 napi_value object,
                                                 napi_value *result)
  {
    return napi_util__::get_property_names(env,
                            object,
                            napi_key_include_prototypes,
                            static_cast<napi_key_filter>(napi_key_enumerable | napi_key_skip_symbols),
                            napi_key_numbers_to_strings,
                            result);
  }

  napi_status NAPI_CDECL napi_get_all_property_names(napi_env env,
                                                     napi_value object,
                                                     napi_key_collection_mode key_mode,
                                                     napi_key_filter key_filter,
                                                     napi_key_conversion key_conversion,
                                                     napi_value *result)
  {
    return napi_util__::get_property_names(env, object, key_mode, key_filter, key_conversion, result);
  }

  napi_status NAPI_CDECL napi_set_named_property(napi_env env,
                                                 napi_value object,
                                                 const char *utf8name,
                                                 napi_value value)
  {
    // 1. Basic Validation
    if (!napi_util__::check_env(env) || !napi_util__::check_value(env, object) || utf8name == nullptr || !napi_util__::check_value(env, value))
    {
      return napi_util__::invalid_arg(env);
    }

    JSValue obj = napi_quickjs_value_inner(env, object);

    // 2. Ensure the target is an object
    if (!JS_IsObject(obj))
    {
      return napi_quickjs_set_last_error(env, napi_object_expected, "Target is not an object");
    }

    // 3. unwrap the value to be set
    JSValue val = napi_quickjs_value_inner(env, value);

    // 4. Set the property.
    JSAtom key = JS_NewAtom(env->context(), utf8name);
    if (key == JS_ATOM_NULL)
      return napi_util__::return_pending_if_caught(env, "Invalid property name");
    int res = set_property_with_node_compat(env->context(), obj, key, val);
    JS_FreeAtom(env->context(), key);
    if (res < 0)
    {
      return napi_util__::return_pending_if_caught(env, "Failed to set named property");
    }

    return napi_quickjs_clear_last_error(env);
  }

  napi_status NAPI_CDECL napi_get_named_property(napi_env env,
                                                 napi_value object,
                                                 const char *utf8name,
                                                 napi_value *result)
  {
    if (!napi_util__::check_value(env, object) || utf8name == nullptr || result == nullptr)
    {
      return napi_util__::invalid_arg(env);
    }
    JSValue local = napi_quickjs_value_inner(env, object);
    if (!JS_IsObject(local))
      return napi_object_expected;

    JSValue prop = JS_GetPropertyStr(env->context(), local, utf8name);
    if (JS_IsException(prop))
    {
      return napi_util__::return_pending_if_caught(env, "Exception while getting named property");
    }
    *result = env->wrap_value_in_current_scope(prop, true);
    return (*result == nullptr) ? napi_generic_failure : napi_ok;
  }

  napi_status NAPI_CDECL napi_get_prototype(napi_env env,
                                            napi_value object,
                                            napi_value *result)
  {
    if (!napi_util__::check_value(env, object) || result == nullptr)
      return napi_util__::invalid_arg(env);

    JSValue target = napi_quickjs_value_inner(env, object);
    if (!JS_IsObject(target))
      return napi_object_expected;

    JSValue proto = JS_GetPrototype(env->context(), target);
    if (JS_IsException(proto))
      return napi_util__::return_pending_if_caught(env, "Exception while getting prototype");

    *result = env->wrap_value_in_current_scope(proto, true);
    return (*result == nullptr) ? napi_generic_failure : napi_ok;
  }

  napi_status NAPI_CDECL node_api_set_prototype(napi_env env,
                                                napi_value object,
                                                napi_value value)
  {
    if (!napi_util__::check_value(env, object) || !napi_util__::check_value(env, value))
      return napi_invalid_arg;

    JSValue target = napi_quickjs_value_inner(env, object);
    if (!JS_IsObject(target))
      return napi_object_expected;

    if (JS_SetPrototype(env->context(), target, napi_quickjs_value_inner(env, value)) < 0)
      return napi_util__::return_pending_if_caught(env, "Exception while setting prototype");

    return napi_ok;
  }

  napi_status NAPI_CDECL napi_get_value_bool(napi_env env,
                                             napi_value value,
                                             bool *result)
  {
    if (!napi_util__::check_value(env, value) || result == nullptr)
    {
      return napi_quickjs_set_last_error(env, napi_invalid_arg, "Invalid argument");
    }
    JSValue local = napi_quickjs_value_inner(env, value);
    if (!JS_IsBool(local))
    {
      return napi_quickjs_set_last_error(env, napi_boolean_expected, "A boolean was expected");
    }
    // JS_ToBool returns 1 for true, 0 for false, -1 for exception
    int res = JS_ToBool(env->context(), local);
    if (res < 0)
    {
      return napi_util__::return_pending_if_caught(env, "Exception during bool coercion");
    }
    *result = (res == 1);
    return napi_quickjs_clear_last_error(env);
  }

  napi_status NAPI_CDECL napi_get_value_string_utf8(
      napi_env env, napi_value value, char *buf, size_t bufsize, size_t *result)
  {
    if (!napi_util__::check_value(env, value))
    {
      return napi_quickjs_set_last_error(env, napi_invalid_arg, "Invalid argument");
    }
    JSValue local = napi_quickjs_value_inner(env, value);
    if (!JS_IsString(local))
    {
      return napi_quickjs_set_last_error(env, napi_string_expected, "A string was expected");
    }

    size_t len;
    const char *str = JS_ToCStringLen(env->context(), &len, local);
    if (!str)
    {
      return napi_util__::return_pending_if_caught(env, "Cannot get string value");
    }

    if (buf == nullptr)
    {
      if (result != nullptr)
      {
        *result = len;
      }
      else
      {
        JS_FreeCString(env->context(), str);
        return napi_util__::invalid_arg(env);
      }
    }
    else if (bufsize != 0)
    {
      size_t copied = napi_util__::complete_utf8_prefix_length(str, std::min(bufsize - 1, len));
      std::memcpy(buf, str, copied);
      buf[copied] = '\0';
      if (result != nullptr)
        *result = copied;
    }
    else if (result != nullptr)
    {
      *result = 0;
    }

    JS_FreeCString(env->context(), str);
    return napi_quickjs_clear_last_error(env);
  }

  napi_status NAPI_CDECL napi_get_value_string_latin1(
      napi_env env, napi_value value, char *buf, size_t bufsize, size_t *result)
  {
    if (!napi_util__::check_value(env, value))
      return napi_util__::invalid_arg(env);

    JSValue local = napi_quickjs_value_inner(env, value);
    if (!JS_IsString(local))
      return napi_quickjs_set_last_error(env, napi_string_expected, "A string was expected");

    // QuickJS strings are UTF-8 internally; for latin1 we get the UTF-8
    // and truncate to single bytes (values >0xFF become '?').
    size_t len;
    const char *str = JS_ToCStringLen(env->context(), &len, local);
    if (str == nullptr)
      return napi_util__::return_pending_if_caught(env, "Failed to convert string");

    std::vector<char> latin1 = napi_util__::utf8_to_latin1(str, len);

    if (buf == nullptr)
    {
      if (result == nullptr)
      {
        JS_FreeCString(env->context(), str);
        return napi_util__::invalid_arg(env);
      }
      *result = latin1.size();
    }
    else if (bufsize != 0)
    {
      size_t copy_len = std::min(bufsize - 1, latin1.size());
      memcpy(buf, latin1.data(), copy_len);
      buf[copy_len] = '\0';
      if (result != nullptr)
        *result = copy_len;
    }
    else if (result != nullptr)
    {
      *result = 0;
    }

    JS_FreeCString(env->context(), str);
    return napi_ok;
  }

  napi_status NAPI_CDECL napi_get_value_string_utf16(napi_env env,
                                                     napi_value value,
                                                     char16_t *buf,
                                                     size_t bufsize,
                                                     size_t *result)
  {
    if (!napi_util__::check_value(env, value))
      return napi_util__::invalid_arg(env);

    JSValue local = napi_quickjs_value_inner(env, value);
    if (!JS_IsString(local))
      return napi_quickjs_set_last_error(env, napi_string_expected, "A string was expected");

    size_t utf16_len;
    const uint16_t *utf16 = JS_ToCStringLenUTF16(env->context(), &utf16_len, local);
    if (utf16 == nullptr)
      return napi_util__::return_pending_if_caught(env, "Failed to convert string to UTF-16");

    if (buf == nullptr)
    {
      if (result == nullptr)
      {
        JS_FreeCString(env->context(), reinterpret_cast<const char *>(utf16));
        return napi_util__::invalid_arg(env);
      }
      *result = utf16_len;
    }
    else if (bufsize != 0)
    {
      size_t copy_len = std::min(bufsize - 1, utf16_len);
      memcpy(buf, utf16, copy_len * sizeof(char16_t));
      buf[copy_len] = u'\0';
      if (result != nullptr)
        *result = copy_len;
    }
    else if (result != nullptr)
    {
      *result = 0;
    }

    JS_FreeCString(env->context(), reinterpret_cast<const char *>(utf16));
    return napi_ok;
  }

  napi_status NAPI_CDECL napi_coerce_to_bool(napi_env env, napi_value value, napi_value *result)
  {
    if (!napi_util__::check_value(env, value) || result == nullptr)
      return napi_util__::invalid_arg(env);

    JSValue coerced = JS_ToBoolean(env->context(), napi_quickjs_value_inner(env, value));
    if (JS_IsException(coerced))
      return napi_util__::return_pending_if_caught(env, "Failed to coerce to bool");

    *result = env->wrap_value_in_current_scope(coerced, true);
    return (*result == nullptr) ? napi_generic_failure : napi_ok;
  }

  napi_status NAPI_CDECL napi_strict_equals(napi_env env, napi_value lhs, napi_value rhs, bool *result)
  {
    if (!napi_util__::check_value(env, lhs) || !napi_util__::check_value(env, rhs) || result == nullptr)
      return napi_invalid_arg;

    *result = JS_IsStrictEqual(env->context(), napi_quickjs_value_inner(env, lhs), napi_quickjs_value_inner(env, rhs));
    return napi_ok;
  }

  napi_status NAPI_CDECL napi_coerce_to_number(napi_env env, napi_value value, napi_value *result)
  {
    if (!napi_util__::check_value(env, value) || result == nullptr)
      return napi_util__::invalid_arg(env);

    double d;
    if (JS_ToFloat64(env->context(), &d, napi_quickjs_value_inner(env, value)) != 0)
      return napi_util__::return_pending_if_caught(env, "Failed to coerce to number");

    *result = env->wrap_value_in_current_scope(JS_NewFloat64(env->context(), d), true);
    return (*result == nullptr) ? napi_generic_failure : napi_ok;
  }

  napi_status NAPI_CDECL napi_coerce_to_object(napi_env env, napi_value value, napi_value *result)
  {
    if (!napi_util__::check_value(env, value) || result == nullptr)
      return napi_util__::invalid_arg(env);

    JSValue obj = JS_ToObject(env->context(), napi_quickjs_value_inner(env, value));
    if (JS_IsException(obj))
      return napi_util__::return_pending_if_caught(env, "Failed to coerce to object");

    *result = env->wrap_value_in_current_scope(obj, true);
    return (*result == nullptr) ? napi_generic_failure : napi_ok;
  }

  napi_status NAPI_CDECL napi_coerce_to_string(napi_env env, napi_value value, napi_value *result)
  {
    if (!napi_util__::check_value(env, value) || result == nullptr)
      return napi_util__::invalid_arg(env);

    JSValue str = JS_ToString(env->context(), napi_quickjs_value_inner(env, value));
    if (JS_IsException(str))
      return napi_util__::return_pending_if_caught(env, "Failed to coerce to string");

    *result = env->wrap_value_in_current_scope(str, true);
    return (*result == nullptr) ? napi_generic_failure : napi_ok;
  }

  napi_status NAPI_CDECL napi_create_reference(napi_env env, napi_value value, uint32_t initial_ref_count, napi_ref *result)
  {
    if (!napi_util__::check_value(env, value) || result == nullptr)
      return napi_invalid_arg;

    napi_env_context_scope__ context_scope{env, napi_quickjs_value_context(env, value)};
    *result = env->wrap_ref_in_root_scope(napi_quickjs_value_inner(env, value), initial_ref_count);
    if (*result == nullptr)
      return napi_generic_failure;

    return napi_ok;
  }

  napi_status NAPI_CDECL napi_delete_reference(napi_env env, napi_ref ref)
  {
    if (!napi_util__::check_env(env) || ref == nullptr)
      return napi_invalid_arg;

    env->delete_ref_from_root_scope(ref);
    return napi_ok;
  }

  napi_status NAPI_CDECL napi_reference_ref(napi_env env,
                                            napi_ref ref,
                                            uint32_t *result)
  {
    if (!napi_util__::check_env(env) || ref == nullptr)
      return napi_invalid_arg;

    napi_ref__ *slot = napi_quickjs_ref_slot(env, ref);
    if (slot == nullptr)
      return napi_invalid_arg;

    uint32_t count = slot->add_ref();

    if (result != nullptr)
      *result = count;

    return napi_ok;
  }

  napi_status NAPI_CDECL napi_reference_unref(napi_env env,
                                              napi_ref ref,
                                              uint32_t *result)
  {
    if (!napi_util__::check_env(env) || ref == nullptr)
      return napi_invalid_arg;

    napi_ref__ *slot = napi_quickjs_ref_slot(env, ref);
    if (slot == nullptr)
      return napi_invalid_arg;

    uint32_t count = slot->rem_ref();

    if (result != nullptr)
      *result = count;

    return napi_ok;
  }

  napi_status NAPI_CDECL napi_get_reference_value(napi_env env,
                                                  napi_ref ref,
                                                  napi_value *result)
  {
    if (!napi_util__::check_env(env) || ref == nullptr || result == nullptr)
      return napi_invalid_arg;
    napi_ref__ *slot = napi_quickjs_ref_slot(env, ref);
    if (slot == nullptr)
      return napi_invalid_arg;
    if (slot->is_empty())
    {
      *result = nullptr;
      return napi_ok;
    }
    *result = env->wrap_value_in_current_scope(slot->context(), slot->dup_inner(), true);
    return (*result == nullptr) ? napi_generic_failure : napi_ok;
  }

  napi_status napi_wrap(napi_env env, napi_value js_object,
                        void *native_object, napi_finalize finalize_cb,
                        void *finalize_hint, napi_ref *result)
  {
    if (!napi_util__::check_value(env, js_object))
      return napi_invalid_arg;

    auto obj = napi_quickjs_value_inner(env, js_object);
    if (!JS_IsObject(obj))
      return napi_object_expected;

    if (napi_external__::is_external(obj))
      return napi_util__::invalid_arg(env);

    if (napi_external__::get_wrap_record(env->context(), obj) != nullptr)
      return napi_util__::invalid_arg(env);

    auto *wrap = napi_external_backing_store_hint__::create(env, native_object, finalize_cb, finalize_hint);
    if (wrap == nullptr)
    {
      return napi_generic_failure;
    }

    if (JS_SetOpaque(obj, wrap) != 0)
    {
      JSValue stored = JS_NewObjectClass(env->context(), napi_external__::record_class_id());
      if (JS_IsException(stored))
      {
        napi_external_backing_store_hint__::destroy(wrap);
        return napi_util__::return_pending_if_caught(env, "Failed to create wrap record");
      }
      wrap->set_weak_target(obj);
      JS_SetOpaque(stored, wrap);
      if (JS_DefinePropertyValueStr(env->context(), obj, napi_external__::wrap_property(), stored,
                                    JS_PROP_CONFIGURABLE) < 0)
      {
        wrap->set_weak_target(JS_UNDEFINED);
        JS_SetOpaque(stored, nullptr);
        JS_FreeValue(env->context(), stored);
        napi_external_backing_store_hint__::destroy(wrap);
        return napi_util__::return_pending_if_caught(env, "Failed to attach wrap record");
      }
    }

    if (result != nullptr)
      return napi_create_reference(env, js_object, 0, result);

    return napi_ok;
  }

  napi_status napi_unwrap(napi_env env, napi_value js_object, void **result)
  {
    if (!napi_util__::check_value(env, js_object) || result == nullptr)
      return napi_invalid_arg;

    auto obj = napi_quickjs_value_inner(env, js_object);
    auto *wrap = napi_external__::get_wrap_record(env->context(), obj);
    if (wrap == nullptr)
      return napi_invalid_arg;

    *result = wrap->external_data();
    return napi_ok;
  }

  napi_status napi_remove_wrap(napi_env env, napi_value js_object, void **result)
  {
    if (!napi_util__::check_value(env, js_object) || result == nullptr)
      return napi_invalid_arg;

    auto obj = napi_quickjs_value_inner(env, js_object);
    if (!JS_IsObject(obj))
      return napi_object_expected;

    auto *wrap = napi_external__::get_wrap_record(env->context(), obj);
    if (wrap == nullptr)
      return napi_generic_failure;

    *result = wrap->external_data();

    if (JS_SetOpaque(obj, nullptr) != 0)
    {
      JSValue stored = JS_GetPropertyStr(env->context(), obj, napi_external__::wrap_property());
      if (JS_IsException(stored))
      {
        JSValue exc = JS_GetException(env->context());
        JS_FreeValue(env->context(), exc);
        return napi_util__::return_pending_if_caught(env, "Failed to get wrap record");
      }
      if (!JS_IsUndefined(stored))
      {
        JS_SetOpaque(stored, nullptr);
      }

      JSAtom key = JS_NewAtom(env->context(), napi_external__::wrap_property());
      if (JS_DeleteProperty(env->context(), obj, key, 0) < 0)
      {
        if (!JS_IsUndefined(stored))
        {
          JS_SetOpaque(stored, wrap);
        }
        JS_FreeValue(env->context(), stored);
        JS_FreeAtom(env->context(), key);
        return napi_util__::return_pending_if_caught(env, "Failed to remove wrap record");
      }
      JS_FreeValue(env->context(), stored);
      JS_FreeAtom(env->context(), key);
    }

    napi_external_backing_store_hint__::destroy(wrap);
    return napi_ok;
  }

  napi_status NAPI_CDECL napi_throw_error(napi_env env,
                                          const char *code,
                                          const char *msg)
  {
    if (!napi_util__::check_env(env))
    {
      return napi_invalid_arg;
    }

    JSValue error = napi_util__::create_plain_error(env->context(), msg);
    if (code != nullptr)
    {
      JS_SetPropertyStr(env->context(), error, "code",
                        JS_NewString(env->context(), code));
    }

    napi_util__::set_last_exception(env, error);

    return napi_ok;
  }

  napi_status NAPI_CDECL napi_throw(napi_env env, napi_value error)
  {
    if (!napi_util__::check_value(env, error))
      return napi_invalid_arg;
    napi_util__::set_last_exception(env, JS_DupValue(env->context(), napi_quickjs_value_inner(env, error)));
    return napi_pending_exception;
  }

  napi_status NAPI_CDECL napi_is_error(napi_env env, napi_value value, bool *result)
  {
    if (!napi_util__::check_value(env, value) || result == nullptr)
      return napi_invalid_arg;
    JSValue val = napi_quickjs_value_inner(env, value);
    JSAtom message_atom = JS_NewAtom(env->context(), "message");
    JSAtom stack_atom = JS_NewAtom(env->context(), "stack");
    *result = JS_IsObject(val) &&
              JS_HasProperty(env->context(), val, message_atom) &&
              JS_HasProperty(env->context(), val, stack_atom);
    JS_FreeAtom(env->context(), message_atom);
    JS_FreeAtom(env->context(), stack_atom);
    return napi_ok;
  }

  napi_status NAPI_CDECL napi_throw_type_error(napi_env env, const char *code, const char *msg)
  {
    if (!napi_util__::check_env(env))
      return napi_invalid_arg;
    napi_util__::set_last_exception(env, napi_util__::create_error_object(env->context(), JS_NewTypeError, code, msg));
    return napi_pending_exception;
  }

  napi_status NAPI_CDECL napi_throw_range_error(napi_env env, const char *code, const char *msg)
  {
    if (!napi_util__::check_env(env))
      return napi_invalid_arg;
    napi_util__::set_last_exception(env, napi_util__::create_error_object(env->context(), JS_NewRangeError, code, msg));
    return napi_pending_exception;
  }

  napi_status NAPI_CDECL node_api_throw_syntax_error(napi_env env, const char *code, const char *msg)
  {
    if (!napi_util__::check_env(env))
      return napi_invalid_arg;
    napi_util__::set_last_exception(env, napi_util__::create_error_object(env->context(), JS_NewSyntaxError, code, msg));
    return napi_pending_exception;
  }

  napi_status NAPI_CDECL napi_fatal_exception(napi_env env, napi_value err)
  {
    if (!napi_util__::check_env(env) || err == nullptr)
      return napi_invalid_arg;

    napi_util__::set_last_exception(env, JS_DupValue(env->context(), napi_quickjs_value_inner(env, err)));
    return napi_ok;
  }

  napi_status NAPI_CDECL napi_create_error(napi_env env, napi_value code, napi_value msg, napi_value *result)
  {
    return napi_util__::create_plain_error_common(env, code, msg, result);
  }

  napi_status NAPI_CDECL napi_create_type_error(napi_env env, napi_value code, napi_value msg, napi_value *result)
  {
    return napi_util__::create_error_common(env, JS_NewTypeError, code, msg, result);
  }

  napi_status NAPI_CDECL napi_create_range_error(napi_env env, napi_value code, napi_value msg, napi_value *result)
  {
    return napi_util__::create_error_common(env, JS_NewRangeError, code, msg, result);
  }

  napi_status NAPI_CDECL node_api_create_syntax_error(napi_env env, napi_value code, napi_value msg, napi_value *result)
  {
    return napi_util__::create_error_common(env, JS_NewSyntaxError, code, msg, result);
  }

  napi_status NAPI_CDECL napi_is_exception_pending(napi_env env, bool *result)
  {
    if (!napi_util__::check_env(env) || result == nullptr)
    {
      return napi_invalid_arg;
    }

    // Check both the engine state and our internal environment cache
    *result = JS_HasException(env->context()) || env->has_last_exception();

    return napi_ok;
  }

  napi_status NAPI_CDECL napi_get_and_clear_last_exception(napi_env env, napi_value *result)
  {
    if (!napi_util__::check_env(env) || result == nullptr)
      return napi_invalid_arg;

    if (!env->has_last_exception())
      return napi_generic_failure;

    // Take ownership of the exception before clearing
    JSValue ex = env->take_last_exception();

    *result = env->wrap_value_in_current_scope(ex, true);
    return (*result == nullptr) ? napi_generic_failure : napi_ok;
  }

  napi_status napi_set_instance_data(napi_env env,
                                     void *data,
                                     napi_finalize finalize_cb,
                                     void *finalize_hint)
  {
    if (env == nullptr)
      return napi_invalid_arg;

    // Node-API Requirement: If instance data was previously set,
    // the previous data's finalizer should be called before overwriting.
    env->set_instance_data(data, finalize_cb, finalize_hint);

    return napi_ok;
  }

  napi_status napi_get_instance_data(napi_env env, void **data)
  {
    if (env == nullptr || data == nullptr)
      return napi_invalid_arg;

    *data = env->instance_data();
    return napi_ok;
  }

  napi_status NAPI_CDECL napi_run_script(napi_env env,
                                         napi_value script,
                                         napi_value *result)
  {
    if (!napi_util__::check_value(env, script) || result == nullptr)
      return napi_invalid_arg;

    JSValue source = napi_quickjs_value_inner(env, script);
    if (!JS_IsString(source))
      return napi_string_expected;

    size_t len;
    const char *str = JS_ToCStringLen(env->context(), &len, source);
    if (str == nullptr)
      return napi_util__::return_pending_if_caught(env, "Failed to convert script to string");

    JSValue out = JS_Eval(env->context(), str, len, "<napi_run_script>", JS_EVAL_TYPE_GLOBAL);

    if (JS_IsException(out))
    {
      JSValue exc = JS_GetException(env->context());
      if (JS_IsObject(exc))
      {
        JSAtom arrow_atom = JS_NewAtom(env->context(), "node:arrowMessage");
        int has_arrow = JS_HasProperty(env->context(), exc, arrow_atom);
        if (has_arrow == 0)
        {
          JS_SetProperty(env->context(), exc, arrow_atom, JS_NewStringLen(env->context(), str, len));
        }
        JS_FreeAtom(env->context(), arrow_atom);
      }
      JS_FreeCString(env->context(), str);
      napi_util__::set_last_exception(env, exc);
      return napi_quickjs_set_last_error(env, napi_pending_exception, "Script evaluation failed");
    }

    JS_FreeCString(env->context(), str);

    *result = env->wrap_value_in_current_scope(out, true);
    return (*result == nullptr) ? napi_generic_failure : napi_ok;
  }

  napi_status NAPI_CDECL node_api_create_buffer_from_arraybuffer(
      napi_env env,
      napi_value arraybuffer,
      size_t byte_offset,
      size_t byte_length,
      napi_value *result);

  napi_status NAPI_CDECL napi_add_env_cleanup_hook(node_api_basic_env basic_env,
                                                   napi_cleanup_hook fun,
                                                   void *arg)
  {
    auto *env = const_cast<napi_env>(basic_env);
    if (!napi_util__::check_env(env) || fun == nullptr)
      return napi_invalid_arg;

    return env->add_cleanup_hook(fun, arg);
  }

  napi_status NAPI_CDECL napi_remove_env_cleanup_hook(node_api_basic_env basic_env,
                                                      napi_cleanup_hook fun,
                                                      void *arg)
  {
    auto *env = const_cast<napi_env>(basic_env);
    if (!napi_util__::check_env(env) || fun == nullptr)
      return napi_invalid_arg;

    return env->remove_cleanup_hook(fun, arg);
  }

  napi_status NAPI_CDECL napi_create_buffer(napi_env env,
                                            size_t length,
                                            void **data,
                                            napi_value *result)
  {
    if (!napi_util__::check_env(env) || data == nullptr || result == nullptr)
      return napi_util__::invalid_arg(env);

    napi_value arraybuffer = nullptr;
    napi_status status = napi_create_arraybuffer(env, length, data, &arraybuffer);
    if (status != napi_ok)
      return status;

    status = node_api_create_buffer_from_arraybuffer(env, arraybuffer, 0, length, result);
    return status;
  }

  napi_status NAPI_CDECL napi_create_buffer_copy(napi_env env,
                                                 size_t length,
                                                 const void *data,
                                                 void **result_data,
                                                 napi_value *result)
  {
    if (!napi_util__::check_env(env) || result == nullptr || (length > 0 && data == nullptr))
      return napi_util__::invalid_arg(env);

    void *out = nullptr;
    napi_status status = napi_create_buffer(env, length, &out, result);
    if (status != napi_ok)
      return status;

    if (length > 0)
      std::memcpy(out, data, length);
    if (result_data != nullptr)
      *result_data = out;
    return napi_ok;
  }

  napi_status NAPI_CDECL napi_create_external_buffer(napi_env env,
                                                     size_t length,
                                                     void *data,
                                                     node_api_basic_finalize finalize_cb,
                                                     void *finalize_hint,
                                                     napi_value *result)
  {
    if (!napi_util__::check_env(env) || result == nullptr || (length > 0 && data == nullptr))
      return napi_util__::invalid_arg(env);

    napi_value arraybuffer = nullptr;
    napi_status status = napi_create_external_arraybuffer(
        env, data, length, finalize_cb, finalize_hint, &arraybuffer);
    if (status != napi_ok)
      return status;

    return node_api_create_buffer_from_arraybuffer(env, arraybuffer, 0, length, result);
  }

  napi_status NAPI_CDECL napi_is_buffer(napi_env env, napi_value value, bool *result)
  {
    if (!napi_util__::check_value(env, value) || result == nullptr)
      return napi_util__::invalid_arg(env);
    *result = env->buffers().is_buffer(napi_quickjs_value_inner(env, value));
    return napi_quickjs_clear_last_error(env);
  }

  napi_status NAPI_CDECL napi_get_buffer_info(napi_env env,
                                              napi_value value,
                                              void **data,
                                              size_t *length)
  {
    if (!napi_util__::check_value(env, value))
      return napi_util__::invalid_arg(env);
    return env->buffers().get_buffer_info(napi_quickjs_value_inner(env, value), data, length);
  }

  napi_status NAPI_CDECL node_api_create_buffer_from_arraybuffer(
      napi_env env,
      napi_value arraybuffer,
      size_t byte_offset,
      size_t byte_length,
      napi_value *result)
  {
    if (!napi_util__::check_value(env, arraybuffer) || result == nullptr)
      return napi_util__::invalid_arg(env);

    size_t arraybuffer_length = 0;
    uint8_t *arraybuffer_data = JS_GetArrayBuffer(
        env->context(), &arraybuffer_length, napi_quickjs_value_inner(env, arraybuffer));
    if (arraybuffer_data == nullptr && JS_HasException(env->context()))
    {
      JSValue exc = JS_GetException(env->context());
      JS_FreeValue(env->context(), exc);
      return napi_quickjs_set_last_error(env, napi_invalid_arg, "Invalid argument");
    }
    if (byte_offset > arraybuffer_length || byte_length > arraybuffer_length - byte_offset)
      return napi_util__::invalid_arg(env);

    JSValue argv[] = {
        napi_quickjs_value_inner(env, arraybuffer),
        JS_NewInt64(env->context(), static_cast<int64_t>(byte_offset)),
        JS_NewInt64(env->context(), static_cast<int64_t>(byte_length))};
    JSValue buffer = JS_NewTypedArray(env->context(), 3, argv, JS_TYPED_ARRAY_UINT8);
    JS_FreeValue(env->context(), argv[1]);
    JS_FreeValue(env->context(), argv[2]);
    if (JS_IsException(buffer))
      return napi_util__::return_pending_if_caught(env, "Failed to create Buffer");

    napi_status status = env->buffers().adopt_native_buffer(buffer);
    if (status != napi_ok)
    {
      JS_FreeValue(env->context(), buffer);
      return status;
    }
    *result = env->wrap_value_in_current_scope(buffer, true);
    return (*result == nullptr) ? napi_generic_failure : napi_ok;
  }

  napi_status NAPI_CDECL napi_adjust_external_memory(
      node_api_basic_env basic_env, int64_t change_in_bytes, int64_t *adjusted_value)
  {
    auto *env = const_cast<napi_env>(basic_env);
    if (!napi_util__::check_env(env) || adjusted_value == nullptr)
      return napi_invalid_arg;

    *adjusted_value = env->adjust_external_memory(change_in_bytes);
    return napi_ok;
  }

  napi_status NAPI_CDECL napi_add_finalizer(napi_env env,
                                            napi_value js_object,
                                            void *finalize_data,
                                            node_api_basic_finalize finalize_cb,
                                            void *finalize_hint,
                                            napi_ref *result)
  {
    if (!napi_util__::check_value(env, js_object) || finalize_cb == nullptr)
      return napi_util__::invalid_arg(env);

    JSValue obj = napi_quickjs_value_inner(env, js_object);
    if (!JS_IsObject(obj))
      return napi_object_expected;

    auto *hint = napi_external_backing_store_hint__::create(env, finalize_data, finalize_cb, finalize_hint);
    if (hint == nullptr)
      return napi_generic_failure;
    hint->set_weak_target(obj);

    JSValue stored = JS_NewObjectClass(env->context(), napi_external__::record_class_id());
    if (JS_IsException(stored))
    {
      napi_external_backing_store_hint__::destroy(hint);
      return napi_util__::return_pending_if_caught(env, "Failed to create finalizer record");
    }

    JS_SetOpaque(stored, hint);
    if (JS_DefinePropertyValueStr(env->context(), obj, napi_external__::finalizer_property(), stored,
                                  JS_PROP_CONFIGURABLE) < 0)
    {
      JS_SetOpaque(stored, nullptr);
      JS_FreeValue(env->context(), stored);
      napi_external_backing_store_hint__::destroy(hint);
      return napi_util__::return_pending_if_caught(env, "Failed to attach finalizer record");
    }

    if (result != nullptr)
      return napi_create_reference(env, js_object, 0, result);

    return napi_ok;
  }

  napi_status NAPI_CDECL napi_get_version(node_api_basic_env env, uint32_t *result)
  {
    if (result == nullptr)
      return napi_invalid_arg;
    auto *napiEnv = const_cast<napi_env>(env);
    if (!napi_util__::check_env(napiEnv))
      return napi_invalid_arg;
    *result = 10;
    return napi_ok;
  }

  napi_status NAPI_CDECL napi_object_freeze(napi_env env, napi_value object)
  {
    if (!napi_util__::check_value(env, object))
      return napi_invalid_arg;

    JSValue target = napi_quickjs_value_inner(env, object);
    if (!JS_IsObject(target))
      return napi_object_expected;

    if (JS_FreezeObject(env->context(), target) < 0)
      return napi_util__::return_pending_if_caught(env, "Failed to freeze object");

    return napi_ok;
  }

  napi_status NAPI_CDECL napi_object_seal(napi_env env, napi_value object)
  {
    if (!napi_util__::check_value(env, object))
      return napi_invalid_arg;

    JSValue target = napi_quickjs_value_inner(env, object);
    if (!JS_IsObject(target))
      return napi_object_expected;

    if (JS_SealObject(env->context(), target) < 0)
      return napi_util__::return_pending_if_caught(env, "Failed to seal object");

    return napi_ok;
  }

  napi_status NAPI_CDECL napi_type_tag_object(napi_env env,
                                              napi_value value,
                                              const napi_type_tag *type_tag)
  {
    if (!napi_util__::check_value(env, value) || type_tag == nullptr)
      return napi_invalid_arg;

    JSValue target = napi_quickjs_value_inner(env, value);
    if (!JS_IsObject(target))
      return napi_invalid_arg;

    // Encode the two 64-bit halves as a single JS string "lower:upper"
    // so we don't need a separate allocation.
    char buf[64];
    snprintf(buf, sizeof(buf), "%llu:%llu",
             (unsigned long long)type_tag->lower,
             (unsigned long long)type_tag->upper);

    JS_DefinePropertyValueStr(env->context(), target, napi_external__::type_tag_property(),
                              JS_NewString(env->context(), buf),
                              JS_PROP_C_W_E); // not enumerable would be nicer but this is simplest
    return napi_ok;
  }

  napi_status NAPI_CDECL napi_check_object_type_tag(napi_env env,
                                                    napi_value value,
                                                    const napi_type_tag *type_tag,
                                                    bool *result)
  {
    if (!napi_util__::check_value(env, value) || type_tag == nullptr || result == nullptr)
      return napi_invalid_arg;

    *result = false;

    JSValue target = napi_quickjs_value_inner(env, value);
    if (!JS_IsObject(target))
      return napi_ok;

    JSValue tag_val = JS_GetPropertyStr(env->context(), target, napi_external__::type_tag_property());
    if (!JS_IsString(tag_val))
    {
      JS_FreeValue(env->context(), tag_val);
      return napi_ok;
    }

    const char *stored = JS_ToCString(env->context(), tag_val);
    JS_FreeValue(env->context(), tag_val);

    char expected[64];
    snprintf(expected, sizeof(expected), "%llu:%llu",
             (unsigned long long)type_tag->lower,
             (unsigned long long)type_tag->upper);

    *result = (strcmp(stored, expected) == 0);
    JS_FreeCString(env->context(), stored);
    return napi_ok;
  }

  napi_status NAPI_CDECL node_api_create_object_with_properties(napi_env env,
                                                                napi_value prototype_or_null,
                                                                napi_value *property_names,
                                                                napi_value *property_values,
                                                                size_t property_count,
                                                                napi_value *result)
  {
    if (!napi_util__::check_env(env) || result == nullptr)
      return napi_invalid_arg;
    if (property_count > 0 && (property_names == nullptr || property_values == nullptr))
      return napi_invalid_arg;

    JSContext *ctx = env->context();
    JSValue obj = JS_NewObject(ctx);
    if (JS_IsException(obj))
      return napi_util__::return_pending_if_caught(env, "Failed to create object");

    if (prototype_or_null != nullptr)
    {
      JSValue proto = napi_quickjs_value_inner(env, prototype_or_null);
      if (!JS_IsNull(proto) && !JS_IsObject(proto))
      {
        JS_FreeValue(ctx, obj);
        return napi_object_expected;
      }
      if (JS_SetPrototype(ctx, obj, proto) < 0)
      {
        JS_FreeValue(ctx, obj);
        return napi_util__::return_pending_if_caught(env, "Failed to set prototype");
      }
    }

    for (size_t i = 0; i < property_count; ++i)
    {
      if (property_names[i] == nullptr || property_values[i] == nullptr)
      {
        JS_FreeValue(ctx, obj);
        return napi_invalid_arg;
      }

      JSAtom key = JS_ValueToAtom(ctx, napi_quickjs_value_inner(env, property_names[i]));
      int rc = set_property_with_node_compat(ctx, obj, key, napi_quickjs_value_inner(env, property_values[i]));
      JS_FreeAtom(ctx, key);

      if (rc < 0)
      {
        JS_FreeValue(ctx, obj);
        return napi_util__::return_pending_if_caught(env, "Failed to set property");
      }
    }

    *result = env->wrap_value_in_current_scope(obj, true);
    return (*result == nullptr) ? napi_generic_failure : napi_ok;
  }

} // extern "C"
