#ifndef NAPI_QUICKJS_UTIL_H_
#define NAPI_QUICKJS_UTIL_H_

#include "../../../include/js_native_api.h"

#include <cstdint>
#include <filesystem>
#include <string>
#include <string_view>
#include <vector>
#include <quickjs.h>

class napi_util__
{
public:
  static bool check_env(napi_env env);
  static bool check_value(napi_env env, napi_value value);
  static JSContext *context(napi_env env);
  static JSRuntime *runtime(napi_env env);

  static void clear_last_exception(napi_env env);
  static void set_last_exception(napi_env env, JSValue exception);
  static bool rethrow_last_exception(napi_env env, JSContext *ctx);
  static napi_status return_pending_if_caught(napi_env env, JSContext *ctx, const char *message);
  static napi_status return_pending_if_caught(napi_env env, const char *message);
  static napi_status invalid_arg(napi_env env);

  static std::filesystem::path strip_file_url(std::string_view value);
  static std::filesystem::path resolve_symlink_components(const std::filesystem::path &path);
  static std::string read_text_file(const std::filesystem::path &path);
  static std::filesystem::path normalize_resolved_path(const std::filesystem::path &path);
  static bool is_regular_file_following_symlinks(const std::filesystem::path &candidate,
                                                 std::filesystem::path *out);
  static bool is_directory_following_symlinks(const std::filesystem::path &candidate,
                                              std::filesystem::path *out);
  static std::string to_utf8(napi_env env, napi_value value);
  static std::string to_utf8(JSContext *ctx, JSValueConst value);
  static void set_string_property(JSContext *ctx,
                                  JSValueConst object,
                                  const char *name,
                                  const std::string &value);
  static bool is_truthy_property(napi_env env, napi_value object, const char *name);
  static napi_status wrap_owned(napi_env env, JSValue value, napi_value *result);
  static napi_status wrap_dup(napi_env env, JSValueConst value, napi_value *result);
  static napi_status create_empty_array(napi_env env, napi_value *result);
  static napi_status create_undefined(napi_env env, napi_value *result);
  static napi_value undefined_value(napi_env env);
  static bool is_callable(napi_env env, napi_value value);
  static std::vector<JSValue> prepare_call_args(napi_env env, size_t argc, const napi_value *argv);
  static napi_status run_pending_jobs(napi_env env);
  static JSValue get_constructor_name_value(napi_env env, JSValueConst value);
  static napi_status unsupported_if_valid_env(napi_env env);

  static bool bigint_fits_signed64(JSContext *ctx, JSValueConst value);
  static bool bigint_fits_unsigned64(JSContext *ctx, JSValueConst value);
  static std::vector<uint64_t> bigint_words_from_decimal(JSContext *ctx, JSValueConst value, bool *negative);
  static std::vector<char> utf8_to_latin1(const char *str, size_t len);
  static size_t complete_utf8_prefix_length(const char *str, size_t len);

  static JSTypedArrayEnum to_quickjs_array_type(napi_typedarray_type type);
  static bool from_quickjs_array_type(int type, napi_typedarray_type *out);

  static void free_array_buffer_data(JSRuntime *rt, void *opaque, void *ptr);

  static int key_filter_to_gpn(napi_key_filter key_filter);
  static napi_status get_property_names(napi_env env,
                                        napi_value object,
                                        napi_key_collection_mode key_mode,
                                        napi_key_filter key_filter,
                                        napi_key_conversion key_conversion,
                                        napi_value *result);

  static JSValue create_plain_error(JSContext *ctx, const char *msg);
  static napi_status create_plain_error_common(napi_env env,
                                               napi_value code,
                                               napi_value msg,
                                               napi_value *result);
  static JSValue create_error_object(JSContext *ctx,
                                     JSValue (*factory)(JSContext *, const char *, ...),
                                     const char *code,
                                     const char *msg);
  static napi_status create_error_common(napi_env env,
                                         JSValue (*factory)(JSContext *, const char *, ...),
                                         napi_value code,
                                         napi_value msg,
                                         napi_value *result);

private:
  static bool decimal_digits_fit(const char *value, const char *max);
};

#endif // NAPI_QUICKJS_UTIL_H_
