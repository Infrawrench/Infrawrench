#include "unofficial_napi.h"

#include <cstdint>
#include <new>

struct unofficial_napi_buffer_lease__ {
  napi_ref value_ref = nullptr;
};

namespace {

size_t TypedArrayElementSize(napi_typedarray_type type) {
  switch (type) {
  case napi_float16_array:
  case napi_int16_array:
  case napi_uint16_array:
    return 2;
  case napi_int32_array:
  case napi_uint32_array:
  case napi_float32_array:
    return 4;
  case napi_float64_array:
  case napi_bigint64_array:
  case napi_biguint64_array:
    return 8;
  default:
    return 1;
  }
}

napi_status GetLeaseByteView(napi_env env, napi_value value, uint8_t **data,
                             size_t *length) {
  bool matches = false;
  napi_status status = napi_is_typedarray(env, value, &matches);
  if (status != napi_ok)
    return status;
  if (matches) {
    napi_typedarray_type type;
    size_t element_length = 0;
    void *raw_data = nullptr;
    napi_value arraybuffer;
    size_t byte_offset = 0;
    status = napi_get_typedarray_info(env, value, &type, &element_length,
                                      &raw_data, &arraybuffer, &byte_offset);
    if (status != napi_ok)
      return status;
    const size_t element_size = TypedArrayElementSize(type);
    if (element_length > SIZE_MAX / element_size)
      return napi_invalid_arg;
    *data = static_cast<uint8_t *>(raw_data);
    *length = element_length * element_size;
    return napi_ok;
  }

  status = napi_is_dataview(env, value, &matches);
  if (status != napi_ok)
    return status;
  if (matches) {
    void *raw_data = nullptr;
    napi_value arraybuffer;
    size_t byte_offset = 0;
    status = napi_get_dataview_info(env, value, length, &raw_data, &arraybuffer,
                                    &byte_offset);
    *data = static_cast<uint8_t *>(raw_data);
    return status;
  }

  status = napi_is_arraybuffer(env, value, &matches);
  if (status != napi_ok)
    return status;
  // napi_get_arraybuffer_info also accepts SharedArrayBuffer. Standard N-API
  // has no non-experimental SharedArrayBuffer predicate, so let the byte-view
  // operation perform the final validation.
  return napi_get_arraybuffer_info(env, value, reinterpret_cast<void **>(data),
                                   length);
}

} // namespace

extern "C" {

napi_status NAPI_CDECL unofficial_napi_acquire_buffer_lease(
    napi_env env, napi_value value, size_t byte_offset, size_t byte_length,
    unofficial_napi_buffer_access_mode mode,
    unofficial_napi_buffer_lease *lease_out, void **data_out) {
  if (env == nullptr || value == nullptr || lease_out == nullptr ||
      data_out == nullptr || mode < unofficial_napi_buffer_access_read ||
      mode > unofficial_napi_buffer_access_readwrite) {
    return napi_invalid_arg;
  }

  uint8_t *base = nullptr;
  size_t length = 0;
  napi_status status = GetLeaseByteView(env, value, &base, &length);
  if (status != napi_ok)
    return status;
  if (byte_offset > length || byte_length > length - byte_offset) {
    return napi_invalid_arg;
  }

  auto *lease = new (std::nothrow) unofficial_napi_buffer_lease__;
  if (lease == nullptr)
    return napi_generic_failure;
  status = napi_create_reference(env, value, 1, &lease->value_ref);
  if (status != napi_ok) {
    delete lease;
    return status;
  }

  *lease_out = lease;
  *data_out = base == nullptr ? nullptr : base + byte_offset;
  return napi_ok;
}

napi_status NAPI_CDECL unofficial_napi_release_buffer_lease(
    napi_env env, unofficial_napi_buffer_lease lease, bool modified) {
  (void)modified;
  if (env == nullptr || lease == nullptr)
    return napi_invalid_arg;
  napi_status status = napi_delete_reference(env, lease->value_ref);
  delete lease;
  return status;
}

} // extern "C"
