#include "internal/napi_util.h"

#include "internal/napi_env.h"
#include "internal/napi_value.h"
#include "napi_text.h"

#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <limits>
#include <sstream>
#include <unordered_set>

namespace
{
constexpr size_t kMaxSymlinkExpansions = 64;

bool starts_with(std::string_view value, std::string_view prefix)
{
  return value.substr(0, prefix.size()) == prefix;
}

int property_key_to_array_index(JSContext *ctx, JSValue key, uint32_t *index_out)
{
  if (JS_IsNumber(key))
    return JS_ToUint32(ctx, index_out, key) < 0 ? -1 : 1;

  if (!JS_IsString(key))
    return 0;

  size_t length = 0;
  const char *text = JS_ToCStringLen(ctx, &length, key);
  if (text == nullptr)
    return -1;

  bool is_index = length != 0 && length <= 10 &&
                  (length == 1 || text[0] != '0');
  uint64_t index = 0;
  for (size_t i = 0; is_index && i < length; ++i)
  {
    const char ch = text[i];
    if (ch < '0' || ch > '9')
    {
      is_index = false;
      break;
    }
    index = index * 10 + static_cast<uint64_t>(ch - '0');
  }
  JS_FreeCString(ctx, text);

  constexpr uint64_t kMaxArrayIndex =
      static_cast<uint64_t>(std::numeric_limits<uint32_t>::max()) - 1;
  if (!is_index || index > kMaxArrayIndex)
    return 0;

  *index_out = static_cast<uint32_t>(index);
  return 1;
}

int hex_digit_value(char ch)
{
  if (ch >= '0' && ch <= '9')
    return ch - '0';
  if (ch >= 'a' && ch <= 'f')
    return 10 + (ch - 'a');
  if (ch >= 'A' && ch <= 'F')
    return 10 + (ch - 'A');
  return -1;
}

std::string percent_decode(std::string_view input)
{
  std::string out;
  out.reserve(input.size());
  for (size_t i = 0; i < input.size(); ++i)
  {
    if (input[i] == '%' && i + 2 < input.size())
    {
      const int hi = hex_digit_value(input[i + 1]);
      const int lo = hex_digit_value(input[i + 2]);
      if (hi >= 0 && lo >= 0)
      {
        out.push_back(static_cast<char>((hi << 4) | lo));
        i += 2;
        continue;
      }
    }
    out.push_back(input[i]);
  }
  return out;
}
} // namespace

bool napi_util__::check_env(napi_env env)
{
  return env != nullptr && env->context() != nullptr;
}

bool napi_util__::check_value(napi_env env, napi_value value)
{
  return (check_env(env) && value != nullptr);
}

JSContext *napi_util__::context(napi_env env)
{
  return env->context();
}

JSRuntime *napi_util__::runtime(napi_env env)
{
  return JS_GetRuntime(context(env));
}

void napi_util__::clear_last_exception(napi_env env)
{
  if (env != nullptr)
    env->clear_last_exception();
}

void napi_util__::set_last_exception(napi_env env, JSValue exception)
{
  if (env != nullptr)
    env->set_last_exception(exception);
}

bool napi_util__::rethrow_last_exception(napi_env env, JSContext *ctx)
{
  if (!env->has_last_exception())
    return false;

  JS_Throw(ctx, env->take_last_exception());
  return true;
}

napi_status napi_util__::return_pending_if_caught(napi_env env, JSContext *ctx, const char *message)
{
  if (ctx != nullptr && JS_HasException(ctx))
  {
    auto exc = JS_GetException(ctx);
    napi_env_context_scope__ context_scope{env, ctx};
    set_last_exception(env, exc);
    return napi_quickjs_set_last_error(env, napi_pending_exception, message);
  }
  return napi_quickjs_set_last_error(env, napi_generic_failure, message);
}

napi_status napi_util__::return_pending_if_caught(napi_env env, const char *message)
{
  return return_pending_if_caught(env, env == nullptr ? nullptr : env->context(), message);
}

napi_status napi_util__::invalid_arg(napi_env env)
{
  if (check_env(env))
    return napi_quickjs_set_last_error(env, napi_invalid_arg, "Invalid argument");
  return napi_invalid_arg;
}

std::filesystem::path napi_util__::strip_file_url(std::string_view value)
{
  constexpr std::string_view kScheme = "file://";
  if (!starts_with(value, kScheme))
    return std::filesystem::path{std::string{value}};

  std::string rest{value.substr(kScheme.size())};
  if (starts_with(rest, "localhost/"))
  {
    rest.erase(0, std::string("localhost").size());
  }
  else if (!rest.empty() && rest[0] != '/')
  {
    const size_t slash = rest.find('/');
    if (slash == std::string::npos)
      return {};
    rest.erase(0, slash);
  }
  return std::filesystem::path{percent_decode(rest)};
}

std::filesystem::path napi_util__::resolve_symlink_components(const std::filesystem::path &path)
{
  std::filesystem::path current;
  size_t expansions = 0;
  std::unordered_set<std::string> seen;

  for (const std::filesystem::path &part : path.lexically_normal())
  {
    if (part == "." || part.empty())
      continue;
    if (part == "..")
    {
      current /= part;
      continue;
    }
    if (part == path.root_name() || part == path.root_directory())
    {
      current /= part;
      continue;
    }

    std::filesystem::path candidate = current.empty() ? part : current / part;
    std::error_code ec;
    if (std::filesystem::is_symlink(candidate, ec) && !ec)
    {
      const std::string key = candidate.lexically_normal().string();
      if (++expansions > kMaxSymlinkExpansions || !seen.insert(key).second)
      {
        current = candidate;
        continue;
      }
      std::filesystem::path target = std::filesystem::read_symlink(candidate, ec);
      if (!ec)
      {
        current = target.is_absolute() ? target : candidate.parent_path() / target;
        current = current.lexically_normal();
        continue;
      }
    }
    current = candidate;
  }
  return current.lexically_normal();
}

std::string napi_util__::read_text_file(const std::filesystem::path &path)
{
  std::ifstream in{path};
  if (!in.is_open())
  {
    const std::filesystem::path resolved = resolve_symlink_components(path);
    if (resolved != path.lexically_normal())
    {
      in.clear();
      in.open(resolved);
    }
  }
  if (!in.is_open())
    return {};
  std::ostringstream ss;
  ss << in.rdbuf();
  return ss.str();
}

std::filesystem::path napi_util__::normalize_resolved_path(const std::filesystem::path &path)
{
  std::error_code ec;
  std::filesystem::path absolute = path;
  if (!absolute.is_absolute())
  {
    absolute = std::filesystem::absolute(path, ec);
    if (ec)
    {
      absolute = path;
      ec.clear();
    }
  }
  std::filesystem::path canonical = std::filesystem::weakly_canonical(absolute, ec);
  if (!ec)
    return canonical.lexically_normal();
  std::filesystem::path resolved = resolve_symlink_components(absolute);
  if (resolved != absolute.lexically_normal())
    return resolved.lexically_normal();
  return absolute.lexically_normal();
}

bool napi_util__::is_regular_file_following_symlinks(const std::filesystem::path &candidate,
                                                     std::filesystem::path *out)
{
  std::error_code ec;
  if (std::filesystem::is_regular_file(candidate, ec) && !ec)
  {
    if (out != nullptr)
      *out = normalize_resolved_path(candidate);
    return true;
  }
  const std::filesystem::path resolved = resolve_symlink_components(candidate);
  if (resolved != candidate.lexically_normal())
  {
    ec.clear();
    if (std::filesystem::is_regular_file(resolved, ec) && !ec)
    {
      if (out != nullptr)
        *out = normalize_resolved_path(resolved);
      return true;
    }
  }
  return false;
}

bool napi_util__::is_directory_following_symlinks(const std::filesystem::path &candidate,
                                                  std::filesystem::path *out)
{
  std::error_code ec;
  if (std::filesystem::is_directory(candidate, ec) && !ec)
  {
    if (out != nullptr)
      *out = normalize_resolved_path(candidate);
    return true;
  }
  const std::filesystem::path resolved = resolve_symlink_components(candidate);
  if (resolved != candidate.lexically_normal())
  {
    ec.clear();
    if (std::filesystem::is_directory(resolved, ec) && !ec)
    {
      if (out != nullptr)
        *out = normalize_resolved_path(resolved);
      return true;
    }
  }
  return false;
}

std::string napi_util__::to_utf8(napi_env env, napi_value value)
{
  if (!check_env(env) || value == nullptr)
    return {};
  return to_utf8(context(env), napi_quickjs_value_inner(env, value));
}

std::string napi_util__::to_utf8(JSContext *ctx, JSValueConst value)
{
  if (ctx == nullptr)
    return {};
  const char *str = JS_ToCString(ctx, value);
  if (str == nullptr)
    return {};
  std::string out{str};
  JS_FreeCString(ctx, str);
  return out;
}

void napi_util__::set_string_property(JSContext *ctx,
                                      JSValueConst object,
                                      const char *name,
                                      const std::string &value)
{
  JS_SetPropertyStr(ctx, object, name, JS_NewStringLen(ctx, value.c_str(), value.size()));
}

bool napi_util__::is_truthy_property(napi_env env, napi_value object, const char *name)
{
  JSContext *ctx = context(env);
  JSValue prop = JS_GetPropertyStr(ctx, napi_quickjs_value_inner(env, object), name);
  if (JS_IsException(prop))
    return false;
  bool out = JS_ToBool(ctx, prop);
  JS_FreeValue(ctx, prop);
  return out;
}

napi_status napi_util__::wrap_owned(napi_env env, JSValue value, napi_value *result)
{
  if (result == nullptr)
  {
    JS_FreeValue(context(env), value);
    return napi_invalid_arg;
  }
  *result = env->wrap_value_in_current_scope(value, true);
  return (*result == nullptr) ? napi_generic_failure : napi_ok;
}

napi_status napi_util__::wrap_dup(napi_env env, JSValueConst value, napi_value *result)
{
  return wrap_owned(env, JS_DupValue(context(env), value), result);
}

napi_status napi_util__::create_empty_array(napi_env env, napi_value *result)
{
  return wrap_owned(env, JS_NewArray(context(env)), result);
}

napi_status napi_util__::create_undefined(napi_env env, napi_value *result)
{
  return wrap_owned(env, JS_UNDEFINED, result);
}

napi_value napi_util__::undefined_value(napi_env env)
{
  napi_value out = nullptr;
  napi_get_undefined(env, &out);
  return out;
}

bool napi_util__::is_callable(napi_env env, napi_value value)
{
  return value != nullptr && JS_IsFunction(context(env), napi_quickjs_value_inner(env, value));
}

std::vector<JSValue> napi_util__::prepare_call_args(napi_env env, size_t argc, const napi_value *argv)
{
  std::vector<JSValue> js_argv;
  js_argv.resize(argc);
  if (argc > 0)
  {
    std::transform(argv, argv + argc, js_argv.begin(), [env](napi_value value) {
      return napi_quickjs_value_inner(env, value);
    });
  }
  return js_argv;
}

napi_status napi_util__::run_pending_jobs(napi_env env)
{
  JSContext *job_ctx = nullptr;
  for (;;)
  {
    int rc = JS_ExecutePendingJob(runtime(env), &job_ctx);
    if (rc == 0)
      return napi_ok;
    if (rc < 0)
      return napi_pending_exception;
  }
}

JSValue napi_util__::get_constructor_name_value(napi_env env, JSValueConst value)
{
  JSContext *ctx = context(env);
  JSValue ctor = JS_GetPropertyStr(ctx, value, "constructor");
  if (JS_IsException(ctor))
    return JS_EXCEPTION;
  JSValue name = JS_UNDEFINED;
  if (JS_IsObject(ctor))
    name = JS_GetPropertyStr(ctx, ctor, "name");
  JS_FreeValue(ctx, ctor);
  if (JS_IsException(name))
    return JS_EXCEPTION;
  if (JS_IsUndefined(name))
    name = JS_NewString(ctx, "");
  return name;
}

napi_status napi_util__::unsupported_if_valid_env(napi_env env)
{
  return check_env(env) ? napi_generic_failure : napi_invalid_arg;
}

bool napi_util__::decimal_digits_fit(const char *value, const char *max)
{
  return napi::text::decimal_digits_fit(value, max);
}

bool napi_util__::bigint_fits_signed64(JSContext *ctx, JSValueConst value)
{
  const char *str = JS_ToCString(ctx, value);
  if (str == nullptr)
    return false;
  bool negative = str[0] == '-';
  bool fits = decimal_digits_fit(negative ? str + 1 : str,
                                 negative ? "9223372036854775808" : "9223372036854775807");
  JS_FreeCString(ctx, str);
  return fits;
}

bool napi_util__::bigint_fits_unsigned64(JSContext *ctx, JSValueConst value)
{
  const char *str = JS_ToCString(ctx, value);
  if (str == nullptr)
    return false;
  bool fits = str[0] != '-' && decimal_digits_fit(str, "18446744073709551615");
  JS_FreeCString(ctx, str);
  return fits;
}

std::vector<uint64_t> napi_util__::bigint_words_from_decimal(JSContext *ctx, JSValueConst value, bool *negative)
{
  std::vector<uint64_t> words;
  const char *str = JS_ToCString(ctx, value);
  if (str == nullptr)
    return words;

  words = napi::text::bigint_words_from_decimal_string(str, negative);
  JS_FreeCString(ctx, str);
  return words;
}

std::vector<char> napi_util__::utf8_to_latin1(const char *str, size_t len)
{
  return napi::text::utf8_to_latin1(str, len);
}

size_t napi_util__::complete_utf8_prefix_length(const char *str, size_t len)
{
  return napi::text::complete_utf8_prefix_length(str, len);
}

JSTypedArrayEnum napi_util__::to_quickjs_array_type(napi_typedarray_type type)
{
  switch (type)
  {
  case napi_int8_array:
    return JS_TYPED_ARRAY_INT8;
  case napi_uint8_array:
    return JS_TYPED_ARRAY_UINT8;
  case napi_uint8_clamped_array:
    return JS_TYPED_ARRAY_UINT8C;
  case napi_int16_array:
    return JS_TYPED_ARRAY_INT16;
  case napi_uint16_array:
    return JS_TYPED_ARRAY_UINT16;
  case napi_int32_array:
    return JS_TYPED_ARRAY_INT32;
  case napi_uint32_array:
    return JS_TYPED_ARRAY_UINT32;
  case napi_float32_array:
    return JS_TYPED_ARRAY_FLOAT32;
  case napi_float64_array:
    return JS_TYPED_ARRAY_FLOAT64;
  case napi_bigint64_array:
    return JS_TYPED_ARRAY_BIG_INT64;
  case napi_biguint64_array:
    return JS_TYPED_ARRAY_BIG_UINT64;
  case napi_float16_array:
    return JS_TYPED_ARRAY_FLOAT16;
  }
}

bool napi_util__::from_quickjs_array_type(int type, napi_typedarray_type *out)
{
  switch (type)
  {
  case JS_TYPED_ARRAY_INT8:
    *out = napi_int8_array;
    return true;
  case JS_TYPED_ARRAY_UINT8:
    *out = napi_uint8_array;
    return true;
  case JS_TYPED_ARRAY_UINT8C:
    *out = napi_uint8_clamped_array;
    return true;
  case JS_TYPED_ARRAY_INT16:
    *out = napi_int16_array;
    return true;
  case JS_TYPED_ARRAY_UINT16:
    *out = napi_uint16_array;
    return true;
  case JS_TYPED_ARRAY_INT32:
    *out = napi_int32_array;
    return true;
  case JS_TYPED_ARRAY_UINT32:
    *out = napi_uint32_array;
    return true;
  case JS_TYPED_ARRAY_FLOAT32:
    *out = napi_float32_array;
    return true;
  case JS_TYPED_ARRAY_FLOAT64:
    *out = napi_float64_array;
    return true;
  case JS_TYPED_ARRAY_BIG_INT64:
    *out = napi_bigint64_array;
    return true;
  case JS_TYPED_ARRAY_BIG_UINT64:
    *out = napi_biguint64_array;
    return true;
  case JS_TYPED_ARRAY_FLOAT16:
    *out = napi_float16_array;
    return true;
  default:
    return false;
  }
}

void napi_util__::free_array_buffer_data(JSRuntime *rt, void *opaque, void *ptr)
{
  (void)opaque;
  js_free_rt(rt, ptr);
}

int napi_util__::key_filter_to_gpn(napi_key_filter key_filter)
{
  int flags = 0;
  if (!(key_filter & napi_key_skip_strings))
    flags |= JS_GPN_STRING_MASK;
  if (!(key_filter & napi_key_skip_symbols))
    flags |= JS_GPN_SYMBOL_MASK;
  if (key_filter & napi_key_enumerable)
    flags |= JS_GPN_ENUM_ONLY;
  return flags;
}

napi_status napi_util__::get_property_names(napi_env env,
                                            napi_value object,
                                            napi_key_collection_mode key_mode,
                                            napi_key_filter key_filter,
                                            napi_key_conversion key_conversion,
                                            napi_value *result)
{
  if (!check_value(env, object) || result == nullptr)
    return invalid_arg(env);

  JSContext *ctx = env->context();
  JSValue obj = napi_quickjs_value_inner(env, object);
  if (!JS_IsObject(obj))
    return napi_object_expected;

  int gpn_flags = key_filter_to_gpn(key_filter);
  JSPropertyEnum *tab = nullptr;
  uint32_t tab_count = 0;

  if (JS_GetOwnPropertyNames(ctx, &tab, &tab_count, obj, gpn_flags) < 0)
    return return_pending_if_caught(env, "Exception while getting property names");

  JSValue arr = JS_NewArray(ctx);
  uint32_t arr_idx = 0;

  auto passes_descriptor_filter = [&](JSValue owner, JSAtom atom) -> int
  {
    if (!(key_filter & (napi_key_writable | napi_key_configurable)))
      return 1;

    JSPropertyDescriptor desc;
    int has = JS_GetOwnProperty(ctx, &desc, owner, atom);
    if (has <= 0)
      return has;

    bool include = true;
    if ((key_filter & napi_key_writable) && !(desc.flags & JS_PROP_WRITABLE))
      include = false;
    if ((key_filter & napi_key_configurable) && !(desc.flags & JS_PROP_CONFIGURABLE))
      include = false;

    JS_FreeValue(ctx, desc.value);
    JS_FreeValue(ctx, desc.getter);
    JS_FreeValue(ctx, desc.setter);
    return include ? 1 : 0;
  };

  auto append_tab = [&](JSValue owner, JSPropertyEnum *t, uint32_t count) -> napi_status
  {
    for (uint32_t i = 0; i < count; ++i)
    {
      int include = passes_descriptor_filter(owner, t[i].atom);
      if (include < 0)
      {
        JS_FreePropertyEnum(ctx, t, count);
        return return_pending_if_caught(env, "Exception while filtering property names");
      }
      if (include == 0)
        continue;

      JSValue key;
      if (key_conversion == napi_key_numbers_to_strings)
      {
        key = JS_AtomToValue(ctx, t[i].atom);
        if (!JS_IsSymbol(key))
        {
          JS_FreeValue(ctx, key);
          key = JS_AtomToString(ctx, t[i].atom);
        }
      }
      else
      {
        key = JS_AtomToValue(ctx, t[i].atom);
        if (!JS_IsException(key))
        {
          uint32_t array_index = 0;
          const int is_array_index = property_key_to_array_index(ctx, key, &array_index);
          if (is_array_index < 0)
          {
            JS_FreeValue(ctx, key);
            JS_FreePropertyEnum(ctx, t, count);
            return return_pending_if_caught(env, "Failed to convert property name");
          }
          if (is_array_index != 0 && !JS_IsNumber(key))
          {
            JS_FreeValue(ctx, key);
            key = JS_NewUint32(ctx, array_index);
          }
        }
      }
      if (JS_IsException(key))
      {
        JS_FreePropertyEnum(ctx, t, count);
        return return_pending_if_caught(env, "Failed to convert property name");
      }
      JS_SetPropertyUint32(ctx, arr, arr_idx++, key);
    }
    JS_FreePropertyEnum(ctx, t, count);
    return napi_ok;
  };

  napi_status status = append_tab(obj, tab, tab_count);
  if (status != napi_ok)
  {
    JS_FreeValue(ctx, arr);
    return status;
  }

  if (key_mode == napi_key_include_prototypes)
  {
    JSValue proto = JS_GetPrototype(ctx, obj);
    while (JS_IsObject(proto))
    {
      JSPropertyEnum *ptab = nullptr;
      uint32_t pcount = 0;
      if (JS_GetOwnPropertyNames(ctx, &ptab, &pcount, proto, gpn_flags) == 0)
      {
        status = append_tab(proto, ptab, pcount);
        if (status != napi_ok)
        {
          JS_FreeValue(ctx, proto);
          JS_FreeValue(ctx, arr);
          return status;
        }
      }

      JSValue next = JS_GetPrototype(ctx, proto);
      JS_FreeValue(ctx, proto);
      proto = next;
    }
    JS_FreeValue(ctx, proto);
  }

  *result = env->wrap_value_in_current_scope(arr, true);
  return (*result == nullptr) ? napi_generic_failure : napi_ok;
}

JSValue napi_util__::create_plain_error(JSContext *ctx, const char *msg)
{
  JSValue global = JS_GetGlobalObject(ctx);
  JSValue error_ctor = JS_GetPropertyStr(ctx, global, "Error");
  JSValue msg_str = JS_NewString(ctx, msg ? msg : "");
  JSValue error = JS_CallConstructor(ctx, error_ctor, 1, &msg_str);
  JS_FreeValue(ctx, msg_str);
  JS_FreeValue(ctx, error_ctor);
  JS_FreeValue(ctx, global);
  return error;
}

napi_status napi_util__::create_plain_error_common(napi_env env,
                                                   napi_value code,
                                                   napi_value msg,
                                                   napi_value *result)
{
  if (!check_env(env) || msg == nullptr || result == nullptr)
    return napi_invalid_arg;

  JSValue msg_val = napi_quickjs_value_inner(env, msg);
  if (!JS_IsString(msg_val))
    return napi_string_expected;

  const char *msg_str = JS_ToCString(env->context(), msg_val);
  JSValue error = create_plain_error(env->context(), msg_str);
  JS_FreeCString(env->context(), msg_str);

  if (code != nullptr && !JS_IsUndefined(napi_quickjs_value_inner(env, code)) && !JS_IsNull(napi_quickjs_value_inner(env, code)))
  {
    const char *code_str = JS_ToCString(env->context(), napi_quickjs_value_inner(env, code));
    JS_SetPropertyStr(env->context(), error, "code", JS_NewString(env->context(), code_str));
    JS_FreeCString(env->context(), code_str);
  }

  *result = env->wrap_value_in_current_scope(error, true);
  return (*result == nullptr) ? napi_generic_failure : napi_ok;
}

JSValue napi_util__::create_error_object(JSContext *ctx,
                                         JSValue (*factory)(JSContext *, const char *, ...),
                                         const char *code,
                                         const char *msg)
{
  JSValue error = factory(ctx, "%s", msg ? msg : "");
  JS_SetPropertyStr(ctx, error, "message", JS_NewString(ctx, msg ? msg : ""));
  if (code != nullptr)
    JS_SetPropertyStr(ctx, error, "code", JS_NewString(ctx, code));
  return error;
}

napi_status napi_util__::create_error_common(napi_env env,
                                             JSValue (*factory)(JSContext *, const char *, ...),
                                             napi_value code,
                                             napi_value msg,
                                             napi_value *result)
{
  if (!check_env(env) || msg == nullptr || result == nullptr)
    return napi_invalid_arg;

  JSValue msg_val = napi_quickjs_value_inner(env, msg);
  if (!JS_IsString(msg_val))
    return napi_string_expected;

  const char *msg_str = JS_ToCString(env->context(), msg_val);
  const char *code_str = nullptr;
  if (code != nullptr && !JS_IsUndefined(napi_quickjs_value_inner(env, code)) && !JS_IsNull(napi_quickjs_value_inner(env, code)))
    code_str = JS_ToCString(env->context(), napi_quickjs_value_inner(env, code));

  JSValue error = create_error_object(env->context(), factory, code_str, msg_str);

  JS_FreeCString(env->context(), msg_str);
  if (code_str != nullptr)
    JS_FreeCString(env->context(), code_str);

  *result = env->wrap_value_in_current_scope(error, true);
  return (*result == nullptr) ? napi_generic_failure : napi_ok;
}
