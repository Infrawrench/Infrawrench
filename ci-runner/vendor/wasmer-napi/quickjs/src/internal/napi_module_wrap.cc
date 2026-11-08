#include "internal/napi_module_wrap.h"

#include "internal/napi_bytecode.h"
#include "internal/napi_env.h"
#include "internal/napi_util.h"
#include "internal/napi_value.h"
#include "node_api.h"

#include <algorithm>
#include <cstring>
#include <new>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

namespace quickjs::detail
{
namespace
{
constexpr int32_t kUninstantiated = 0;
constexpr int32_t kInstantiating = 1;
constexpr int32_t kInstantiated = 2;
constexpr int32_t kEvaluating = 3;
constexpr int32_t kEvaluated = 4;
constexpr int32_t kErrored = 5;

constexpr int32_t kSourcePhase = 1;
constexpr int32_t kEvaluationPhase = 2;

bool is_nullish(napi_env env, napi_value value)
{
  if (value == nullptr)
    return true;
  JSValueConst inner = napi_quickjs_value_inner(env, value);
  return JS_IsUndefined(inner) || JS_IsNull(inner);
}

JSValue js_dup_or_undefined(napi_env env, JSContext *ctx, napi_value value)
{
  if (is_nullish(env, value))
    return JS_UNDEFINED;
  return JS_DupValue(ctx, napi_quickjs_value_inner(env, value));
}

std::string value_to_string(JSContext *ctx, JSValueConst value)
{
  const char *str = JS_ToCString(ctx, value);
  if (str == nullptr)
    return {};
  std::string out{str};
  JS_FreeCString(ctx, str);
  return out;
}

int32_t to_node_phase(JSModuleImportPhaseEnum phase)
{
  return phase == JS_MODULE_IMPORT_PHASE_SOURCE ? kSourcePhase : kEvaluationPhase;
}

std::string attributes_key(JSContext *ctx, JSValueConst attributes)
{
  if (JS_IsUndefined(attributes))
    return "{}";

  JSPropertyEnum *props = nullptr;
  uint32_t len = 0;
  if (!JS_IsObject(attributes) ||
      JS_GetOwnPropertyNames(ctx, &props, &len, attributes,
                             JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) < 0)
    return "{}";

  std::vector<std::string> parts;
  parts.reserve(len);
  for (uint32_t i = 0; i < len; ++i)
  {
    JSValue key = JS_AtomToString(ctx, props[i].atom);
    JSValue val = JS_GetProperty(ctx, attributes, props[i].atom);
    if (!JS_IsException(key) && !JS_IsException(val))
      parts.push_back(value_to_string(ctx, key) + "=" + value_to_string(ctx, val));
    JS_FreeValue(ctx, key);
    JS_FreeValue(ctx, val);
  }
  JS_FreePropertyEnum(ctx, props, len);
  std::sort(parts.begin(), parts.end());

  std::ostringstream out;
  out << "{";
  for (size_t i = 0; i < parts.size(); ++i)
  {
    if (i != 0)
      out << ",";
    out << parts[i];
  }
  out << "}";
  return out.str();
}
} // namespace

struct napi_module_wrap__::request_record
{
  std::string specifier;
  JSValue attributes = JS_UNDEFINED;
  JSModuleImportPhaseEnum phase = JS_MODULE_IMPORT_PHASE_EVALUATION;
};

struct napi_module_wrap__::record
{
  napi_module_wrap__ *owner = nullptr;
  JSModuleDef *module = nullptr;
  JSValue module_value = JS_UNDEFINED;
  JSValue wrapper = JS_UNDEFINED;
  JSValue host_defined_option_id = JS_UNDEFINED;
  JSValue synthetic_eval_steps = JS_UNDEFINED;
  JSValue source_object = JS_UNDEFINED;
  bool synthetic = false;
  // XXH3 of the module source text; written into the QJSB header by
  // create_cached_data so the consuming vm.SourceTextModule constructor's
  // deserialize validates source identity (filename stays unenforced).
  uint64_t source_hash = 0;
  std::vector<request_record> requests;
  std::vector<record *> linked_records;
  std::vector<JSValue> linked_module_values;
};

struct napi_module_wrap__::script_referrer
{
  std::string name;
  JSValue host_defined_option_id = JS_UNDEFINED;
};

napi_module_wrap__::napi_module_wrap__(napi_env env, JSContext *context)
    : env_{env},
      ctx_{context},
      import_module_dynamically_callback_{JS_UNDEFINED},
      initialize_import_meta_callback_{JS_UNDEFINED}
{
  JSRuntime *rt = JS_GetRuntime(ctx_);
  JS_SetModuleImportMetaInitFunc(rt, host_import_meta_init, this);
  JS_SetModuleDynamicImportFunc(rt, host_dynamic_import, this);
}

napi_module_wrap__::~napi_module_wrap__()
{
  teardown();
}

void napi_module_wrap__::teardown()
{
  if (torn_down_)
    return;

  JSRuntime *rt = JS_GetRuntime(ctx_);
  JS_SetModuleImportMetaInitFunc(rt, nullptr, nullptr);
  JS_SetModuleDynamicImportFunc(rt, nullptr, nullptr);

  while (!records_.empty())
    free_record(records_.back());
  for (auto &referrer : script_referrers_)
    JS_FreeValue(ctx_, referrer.host_defined_option_id);
  script_referrers_.clear();
  for (const auto &promise : pending_dynamic_imports_)
    JS_FreeValue(ctx_, promise.value);
  pending_dynamic_imports_.clear();

  JS_FreeValue(ctx_, import_module_dynamically_callback_);
  import_module_dynamically_callback_ = JS_UNDEFINED;
  JS_FreeValue(ctx_, initialize_import_meta_callback_);
  initialize_import_meta_callback_ = JS_UNDEFINED;
  torn_down_ = true;
}

napi_module_wrap__::record *napi_module_wrap__::find(unofficial_napi_module module) const
{
  auto *entry = reinterpret_cast<record *>(module);
  if (entry == nullptr)
    return nullptr;
  for (record *candidate : records_)
  {
    if (candidate == entry)
      return entry;
  }
  return nullptr;
}

napi_module_wrap__::record *napi_module_wrap__::find_by_module(JSModuleDef *module) const
{
  if (module == nullptr)
    return nullptr;
  for (record *entry : records_)
  {
    if (entry != nullptr && entry->module == module)
      return entry;
  }
  return nullptr;
}

napi_module_wrap__::record *napi_module_wrap__::find_by_wrapper(JSValueConst wrapper) const
{
  for (record *entry : records_)
  {
    if (entry != nullptr && JS_IsSameValue(ctx_, entry->wrapper, wrapper))
      return entry;
  }
  return nullptr;
}

void napi_module_wrap__::remove(record *entry)
{
  auto it = std::find(records_.begin(), records_.end(), entry);
  if (it != records_.end())
    records_.erase(it);
}

void napi_module_wrap__::free_record(record *entry)
{
  if (entry == nullptr)
    return;

  remove(entry);
  for (auto &request : entry->requests)
    JS_FreeValue(ctx_, request.attributes);
  for (JSValue value : entry->linked_module_values)
    JS_FreeValue(ctx_, value);
  JS_FreeValue(ctx_, entry->module_value);
  JS_FreeValue(ctx_, entry->wrapper);
  JS_FreeValue(ctx_, entry->host_defined_option_id);
  JS_FreeValue(ctx_, entry->synthetic_eval_steps);
  JS_FreeValue(ctx_, entry->source_object);
  delete entry;
}

JSValue napi_module_wrap__::get_host_defined_option_symbol() const
{
  JSValue global = JS_GetGlobalObject(ctx_);
  JSValue binding_fn = JS_GetPropertyStr(ctx_, global, "internalBinding");
  if (!JS_IsFunction(ctx_, binding_fn))
  {
    JS_FreeValue(ctx_, binding_fn);
    binding_fn = JS_GetPropertyStr(ctx_, global, "getInternalBinding");
  }
  if (!JS_IsFunction(ctx_, binding_fn))
  {
    JS_FreeValue(ctx_, binding_fn);
    JS_FreeValue(ctx_, global);
    return JS_UNDEFINED;
  }

  JSValue name = JS_NewString(ctx_, "util");
  JSValue util = JS_Call(ctx_, binding_fn, global, 1, &name);
  JS_FreeValue(ctx_, name);
  JS_FreeValue(ctx_, binding_fn);
  JS_FreeValue(ctx_, global);
  if (JS_IsException(util))
    return JS_UNDEFINED;

  JSValue private_symbols = JS_GetPropertyStr(ctx_, util, "privateSymbols");
  JS_FreeValue(ctx_, util);
  if (JS_IsException(private_symbols))
    return JS_UNDEFINED;

  JSValue symbol = JS_GetPropertyStr(ctx_, private_symbols, "host_defined_option_symbol");
  JS_FreeValue(ctx_, private_symbols);
  if (JS_IsException(symbol))
    return JS_UNDEFINED;
  return symbol;
}

JSValue napi_module_wrap__::get_symbols_binding_property(const char *name) const
{
  JSValue global = JS_GetGlobalObject(ctx_);
  JSValue binding_fn = JS_GetPropertyStr(ctx_, global, "internalBinding");
  if (!JS_IsFunction(ctx_, binding_fn))
  {
    JS_FreeValue(ctx_, binding_fn);
    binding_fn = JS_GetPropertyStr(ctx_, global, "getInternalBinding");
  }
  if (!JS_IsFunction(ctx_, binding_fn))
  {
    JS_FreeValue(ctx_, binding_fn);
    JS_FreeValue(ctx_, global);
    return JS_UNDEFINED;
  }

  JSValue binding_name = JS_NewString(ctx_, "symbols");
  JSValue symbols = JS_Call(ctx_, binding_fn, global, 1, &binding_name);
  JS_FreeValue(ctx_, binding_name);
  JS_FreeValue(ctx_, binding_fn);
  JS_FreeValue(ctx_, global);
  if (JS_IsException(symbols))
    return JS_UNDEFINED;

  JSValue result = JS_GetPropertyStr(ctx_, symbols, name);
  JS_FreeValue(ctx_, symbols);
  if (JS_IsException(result))
    return JS_UNDEFINED;
  return result;
}

JSValue napi_module_wrap__::get_or_create_host_defined_option(napi_value wrapper,
                                                              napi_value candidate,
                                                              const char *description) const
{
  JSValue value = JS_UNDEFINED;
  if (!is_nullish(env_, candidate) && JS_IsSymbol(napi_quickjs_value_inner(env_, candidate)))
    value = JS_DupValue(ctx_, napi_quickjs_value_inner(env_, candidate));
  else
    value = JS_NewSymbol(ctx_, description, false);
  set_host_defined_option(wrapper, value);
  return value;
}

void napi_module_wrap__::set_host_defined_option(napi_value wrapper, JSValueConst value) const
{
  if (wrapper == nullptr || !JS_IsObject(napi_quickjs_value_inner(env_, wrapper)))
    return;

  JSValue symbol = get_host_defined_option_symbol();
  if (JS_IsSymbol(symbol))
  {
    JSAtom atom = JS_ValueToAtom(ctx_, symbol);
    if (atom != JS_ATOM_NULL)
    {
      JS_SetProperty(ctx_, napi_quickjs_value_inner(env_, wrapper), atom, JS_DupValue(ctx_, value));
      JS_FreeAtom(ctx_, atom);
    }
  }
  JS_FreeValue(ctx_, symbol);
  JS_SetPropertyStr(ctx_, napi_quickjs_value_inner(env_, wrapper), "contextifyHostDefinedOptionId",
                    JS_DupValue(ctx_, value));
}

JSValue napi_module_wrap__::create_frozen_null_proto_object() const
{
  JSValue object = JS_NewObjectProto(ctx_, JS_NULL);
  if (JS_IsException(object))
    return object;
  if (JS_FreezeObject(ctx_, object) < 0)
  {
    JS_FreeValue(ctx_, object);
    return JS_EXCEPTION;
  }
  return object;
}

JSValue napi_module_wrap__::clone_attributes(JSValueConst value) const
{
  JSValue object = JS_NewObjectProto(ctx_, JS_NULL);
  if (JS_IsException(object))
    return object;

  if (!JS_IsUndefined(value) && JS_IsObject(value))
  {
    JSPropertyEnum *props = nullptr;
    uint32_t len = 0;
    if (JS_GetOwnPropertyNames(ctx_, &props, &len, value,
                               JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) < 0)
    {
      JS_FreeValue(ctx_, object);
      return JS_EXCEPTION;
    }
    for (uint32_t i = 0; i < len; ++i)
    {
      JSValue property_value = JS_GetProperty(ctx_, value, props[i].atom);
      if (JS_IsException(property_value) ||
          JS_DefinePropertyValue(ctx_, object, props[i].atom, property_value,
                                 JS_PROP_C_W_E) < 0)
      {
        JS_FreePropertyEnum(ctx_, props, len);
        JS_FreeValue(ctx_, object);
        return JS_EXCEPTION;
      }
    }
    JS_FreePropertyEnum(ctx_, props, len);
  }

  if (JS_FreezeObject(ctx_, object) < 0)
  {
    JS_FreeValue(ctx_, object);
    return JS_EXCEPTION;
  }
  return object;
}

napi_status napi_module_wrap__::throw_error(const char *code, const char *message)
{
  JSValue error = napi_util__::create_plain_error(ctx_, message);
  if (code != nullptr)
    JS_SetPropertyStr(ctx_, error, "code", JS_NewString(ctx_, code));
  env_->set_last_exception(error);
  return napi_pending_exception;
}

napi_status napi_module_wrap__::return_pending_exception(const char *message)
{
  return napi_util__::return_pending_if_caught(env_, message);
}

napi_status napi_module_wrap__::wrap_owned(JSValue value, napi_value *result_out) const
{
  return napi_util__::wrap_owned(env_, value, result_out);
}

JSValue napi_module_wrap__::call_callback(JSValueConst callback,
                                          int argc,
                                          JSValueConst *argv) const
{
  if (!JS_IsFunction(ctx_, callback))
    return JS_UNDEFINED;
  JSValue global = JS_GetGlobalObject(ctx_);
  JSValue result = JS_Call(ctx_, callback, global, argc, argv);
  JS_FreeValue(ctx_, global);
  return result;
}

napi_status napi_module_wrap__::cache_module_requests(record *entry)
{
  const int count = JS_GetModuleRequestCount(ctx_, entry->module);
  if (count < 0)
    return napi_generic_failure;

  entry->requests.clear();
  entry->requests.reserve(static_cast<size_t>(count));
  for (int i = 0; i < count; ++i)
  {
    JSModuleRequest request{};
    if (JS_GetModuleRequest(ctx_, entry->module, i, &request) < 0)
      return napi_generic_failure;

    const char *specifier = JS_AtomToCString(ctx_, request.module_name);
    request_record item;
    if (specifier != nullptr)
    {
      item.specifier = specifier;
      JS_FreeCString(ctx_, specifier);
    }
    item.attributes = clone_attributes(request.attributes);
    item.phase = request.phase;
    JS_FreeModuleRequest(ctx_, &request);
    if (JS_IsException(item.attributes))
      return return_pending_exception("Failed to clone module attributes");
    entry->requests.push_back(std::move(item));
  }
  return napi_ok;
}

napi_status napi_module_wrap__::create_source_text(napi_value wrapper,
                                                   napi_value url,
                                                   napi_value context_or_undefined,
                                                   const unofficial_napi_js_source *source,
                                                   int32_t line_offset,
                                                   int32_t column_offset,
                                                   napi_value host_defined_option_id,
                                                   unofficial_napi_module *module_out)
{
  (void)context_or_undefined;
  (void)column_offset;
  if (!napi_util__::check_value(env_, wrapper) ||
      !napi_util__::check_value(env_, url) ||
      !unofficial_napi_js_source_is_valid(source) ||
      module_out == nullptr)
    return napi_util__::invalid_arg(env_);

  auto *bytecode_record = napi_bytecode_record_from_source(source);
  if (bytecode_record != nullptr &&
      bytecode_record->shape != unofficial_napi_bytecode_shape_module)
    return napi_util__::invalid_arg(env_);

  *module_out = nullptr;
  std::string url_string = napi_util__::to_utf8(env_, url);
  std::string source_string = bytecode_record != nullptr
                                  ? bytecode_record->source_utf8
                                  : napi_util__::to_utf8(env_, source->text);

  JSValue host_id = get_or_create_host_defined_option(wrapper,
                                                      host_defined_option_id,
                                                      url_string.c_str());
  if (JS_IsException(host_id))
    return return_pending_exception("Failed to create module host option");

  JSValue module_value = JS_UNDEFINED;
  if (bytecode_record != nullptr && !JS_IsUndefined(bytecode_record->artifact) &&
      bytecode_record->ctx == ctx_)
  {
    // Reuse the deserialized/compiled module artifact: same JSModuleDef the
    // bytecode handle registered, so import.meta/dynamic-import records and
    // linking behave exactly like the text-compiled path.
    module_value = JS_DupValue(ctx_, bytecode_record->artifact);
  }
  else
  {
    JSEvalOptions options = {
        .version = JS_EVAL_OPTIONS_VERSION,
        .eval_flags = JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY,
        .filename = url_string.empty() ? "<module>" : url_string.c_str(),
        .line_num = line_offset + 1,
    };
    module_value = JS_Eval2(ctx_, source_string.c_str(),
                            source_string.size(), &options);
  }
  if (JS_IsException(module_value))
  {
    JS_FreeValue(ctx_, host_id);
    return return_pending_exception("Module compile failed");
  }

  JSModuleDef *module = JS_GetModuleDef(ctx_, module_value);
  if (module == nullptr)
  {
    JS_FreeValue(ctx_, host_id);
    JS_FreeValue(ctx_, module_value);
    return napi_generic_failure;
  }

  auto *entry = new (std::nothrow) record{};
  if (entry == nullptr)
  {
    JS_FreeValue(ctx_, host_id);
    JS_FreeValue(ctx_, module_value);
    return napi_generic_failure;
  }
  entry->owner = this;
  entry->module = module;
  entry->module_value = module_value;
  entry->wrapper = JS_DupValue(ctx_, napi_quickjs_value_inner(env_, wrapper));
  entry->host_defined_option_id = host_id;
  entry->source_hash =
      quickjs::detail::napi_bytecode_hash64(source_string.data(), source_string.size());
  records_.push_back(entry);

  napi_status status = cache_module_requests(entry);
  if (status != napi_ok)
  {
    free_record(entry);
    return status;
  }

  JS_SetPropertyStr(ctx_, napi_quickjs_value_inner(env_, wrapper), "sourceURL",
                    JS_NewString(ctx_, url_string.c_str()));
  JS_SetPropertyStr(ctx_, napi_quickjs_value_inner(env_, wrapper), "sourceMapURL", JS_UNDEFINED);
  *module_out = reinterpret_cast<unofficial_napi_module>(entry);
  return napi_ok;
}

napi_status napi_module_wrap__::create_synthetic(napi_value wrapper,
                                                 napi_value url,
                                                 napi_value context_or_undefined,
                                                 napi_value export_names,
                                                 napi_value synthetic_eval_steps,
                                                 unofficial_napi_module *module_out)
{
  (void)context_or_undefined;
  if (!napi_util__::check_value(env_, wrapper) ||
      !napi_util__::check_value(env_, url) ||
      !napi_util__::check_value(env_, export_names) ||
      !napi_util__::check_value(env_, synthetic_eval_steps) ||
      module_out == nullptr)
    return napi_util__::invalid_arg(env_);

  *module_out = nullptr;
  std::string url_string = napi_util__::to_utf8(env_, url);
  JSModuleDef *module = JS_NewCModule(ctx_,
                                      url_string.empty() ? "<synthetic>" : url_string.c_str(),
                                      synthetic_init);
  if (module == nullptr)
    return return_pending_exception("Failed to create synthetic module");

  int64_t length = 0;
  if (JS_GetLength(ctx_, napi_quickjs_value_inner(env_, export_names), &length) < 0)
    return return_pending_exception("Failed to read synthetic export names");
  for (int64_t i = 0; i < length; ++i)
  {
    JSValue name_value = JS_GetPropertyUint32(ctx_, napi_quickjs_value_inner(env_, export_names),
                                              static_cast<uint32_t>(i));
    if (JS_IsException(name_value))
      return return_pending_exception("Failed to read synthetic export name");
    std::string name = value_to_string(ctx_, name_value);
    JS_FreeValue(ctx_, name_value);
    if (JS_AddModuleExport(ctx_, module, name.c_str()) < 0)
      return return_pending_exception("Failed to add synthetic export");
  }

  auto *entry = new (std::nothrow) record{};
  if (entry == nullptr)
    return napi_generic_failure;
  entry->owner = this;
  entry->module = module;
  entry->module_value = JS_DupModuleValue(ctx_, module);
  entry->wrapper = JS_DupValue(ctx_, napi_quickjs_value_inner(env_, wrapper));
  entry->host_defined_option_id = JS_UNDEFINED;
  entry->synthetic_eval_steps = JS_DupValue(ctx_, napi_quickjs_value_inner(env_, synthetic_eval_steps));
  entry->synthetic = true;
  records_.push_back(entry);

  *module_out = reinterpret_cast<unofficial_napi_module>(entry);
  return napi_ok;
}

napi_status napi_module_wrap__::destroy(unofficial_napi_module module)
{
  record *entry = find(module);
  if (entry != nullptr)
    free_record(entry);
  return napi_ok;
}

napi_status napi_module_wrap__::get_creation_metadata(unofficial_napi_module module,
                                                      napi_value *requests_out,
                                                      bool *has_top_level_await_out)
{
  record *entry = find(module);
  if (entry == nullptr || requests_out == nullptr || has_top_level_await_out == nullptr)
    return napi_util__::invalid_arg(env_);

  JSValue array = JS_NewArray(ctx_);
  if (JS_IsException(array))
    return return_pending_exception("Failed to create module request array");

  for (size_t i = 0; i < entry->requests.size(); ++i)
  {
    const request_record &request = entry->requests[i];
    JSValue object = JS_NewObjectProto(ctx_, JS_NULL);
    if (JS_IsException(object))
    {
      JS_FreeValue(ctx_, array);
      return return_pending_exception("Failed to create module request object");
    }
    JS_DefinePropertyValueStr(ctx_, object, "specifier",
                              JS_NewString(ctx_, request.specifier.c_str()),
                              JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx_, object, "attributes",
                              clone_attributes(request.attributes),
                              JS_PROP_C_W_E);
    JS_DefinePropertyValueStr(ctx_, object, "phase",
                              JS_NewInt32(ctx_, to_node_phase(request.phase)),
                              JS_PROP_C_W_E);
    JS_FreezeObject(ctx_, object);
    JS_DefinePropertyValueUint32(ctx_, array, static_cast<uint32_t>(i),
                                 object, JS_PROP_C_W_E);
  }
  *has_top_level_await_out = JS_ModuleHasTopLevelAwait(ctx_, entry->module);
  return wrap_owned(array, requests_out);
}

napi_status napi_module_wrap__::link(unofficial_napi_module module,
                                     size_t count,
                                     const unofficial_napi_module *linked_modules)
{
  record *entry = find(module);
  if (entry == nullptr || (count > 0 && linked_modules == nullptr))
    return napi_util__::invalid_arg(env_);
  if (count != entry->requests.size())
    return throw_error("ERR_MODULE_LINK_MISMATCH", "Module link count mismatch");

  for (JSValue value : entry->linked_module_values)
    JS_FreeValue(ctx_, value);
  entry->linked_module_values.clear();
  entry->linked_records.clear();

  for (size_t i = 0; i < count; ++i)
  {
    record *linked = find(linked_modules[i]);
    if (linked == nullptr)
      return throw_error("ERR_VM_MODULE_LINK_FAILURE", "Linked module is invalid");

    const std::string key = entry->requests[i].specifier + "\n" +
                            attributes_key(ctx_, entry->requests[i].attributes);
    for (size_t j = 0; j < i; ++j)
    {
      const std::string previous_key = entry->requests[j].specifier + "\n" +
                                       attributes_key(ctx_, entry->requests[j].attributes);
      if (key == previous_key && entry->linked_records[j] != linked)
      {
        std::string message = "Module request 'ModuleCacheKey(\"" +
                              entry->requests[i].specifier +
                              "\")' at index " + std::to_string(j) +
                              " must be linked to the same module requested at index " +
                              std::to_string(i);
        return throw_error("ERR_MODULE_LINK_MISMATCH", message.c_str());
      }
    }

    if (JS_SetModuleRequestModule(ctx_, entry->module, static_cast<int>(i),
                                  linked->module) < 0)
      return return_pending_exception("Failed to link module request");
    entry->linked_records.push_back(linked);
    entry->linked_module_values.push_back(JS_DupModuleValue(ctx_, linked->module));
  }
  return napi_ok;
}

napi_status napi_module_wrap__::instantiate(unofficial_napi_module module)
{
  record *entry = find(module);
  if (entry == nullptr)
    return napi_util__::invalid_arg(env_);
  if (JS_LinkModule(ctx_, entry->module) < 0)
    return return_pending_exception("Module linking failed");
  return napi_ok;
}

napi_status napi_module_wrap__::evaluate(unofficial_napi_module module,
                                         int64_t timeout,
                                         bool break_on_sigint,
                                         napi_value *result_out)
{
  (void)timeout;
  (void)break_on_sigint;
  record *entry = find(module);
  if (entry == nullptr || result_out == nullptr)
    return napi_util__::invalid_arg(env_);
  JSValue promise = JS_EvaluateModule(ctx_, entry->module);
  if (JS_IsException(promise))
    return return_pending_exception("Failed to evaluate module");
  return wrap_owned(promise, result_out);
}

napi_status napi_module_wrap__::evaluate_sync(unofficial_napi_module module,
                                              napi_value filename,
                                              napi_value parent_filename,
                                              napi_value *result_out)
{
  (void)filename;
  (void)parent_filename;
  record *entry = find(module);
  if (entry == nullptr || result_out == nullptr)
    return napi_util__::invalid_arg(env_);

  JSValue promise = JS_EvaluateModule(ctx_, entry->module);
  if (JS_IsException(promise))
    return return_pending_exception("Failed to evaluate module");

  JSPromiseStateEnum state = JS_PromiseState(ctx_, promise);
  if (state == JS_PROMISE_FULFILLED)
  {
    JS_FreeValue(ctx_, promise);
    return get_namespace(module, result_out);
  }
  if (state == JS_PROMISE_REJECTED)
  {
    JSValue reason = JS_PromiseResult(ctx_, promise);
    JS_FreeValue(ctx_, promise);
    env_->set_last_exception(reason);
    return napi_pending_exception;
  }

  JS_FreeValue(ctx_, promise);
  return throw_error("ERR_REQUIRE_ASYNC_MODULE",
                     "require() cannot be used on an ESM graph with top-level await");
}

napi_status napi_module_wrap__::get_namespace(unofficial_napi_module module,
                                              napi_value *result_out)
{
  record *entry = find(module);
  if (entry == nullptr || result_out == nullptr)
    return napi_util__::invalid_arg(env_);
  JSValue ns = JS_GetModuleNamespace(ctx_, entry->module);
  if (JS_IsException(ns))
    return return_pending_exception("Failed to get module namespace");
  return wrap_owned(ns, result_out);
}

napi_status napi_module_wrap__::get_state(unofficial_napi_module module,
                                          int32_t *status_out,
                                          napi_value *error_out,
                                          bool *has_async_graph_out)
{
  record *entry = find(module);
  if (entry == nullptr ||
      (status_out == nullptr && error_out == nullptr &&
       has_async_graph_out == nullptr))
    return napi_util__::invalid_arg(env_);

  JSValue error = JS_GetModuleEvaluationException(ctx_, entry->module);
  const bool has_error = !JS_IsUndefined(error);
  int32_t status = kUninstantiated;
  if (status_out != nullptr || has_async_graph_out != nullptr)
  {
    if (has_error)
    {
      status = kErrored;
    }
    else
    {
      switch (JS_GetModuleStatus(ctx_, entry->module))
      {
      case JS_MODULE_STATUS_UNLINKED:
        status = kUninstantiated;
        break;
      case JS_MODULE_STATUS_LINKING:
        status = kInstantiating;
        break;
      case JS_MODULE_STATUS_LINKED:
        status = kInstantiated;
        break;
      case JS_MODULE_STATUS_EVALUATING:
      case JS_MODULE_STATUS_EVALUATING_ASYNC:
        status = kEvaluating;
        break;
      case JS_MODULE_STATUS_EVALUATED:
        status = kEvaluated;
        break;
      }
    }
  }
  if (status_out != nullptr)
    *status_out = status;
  if (has_async_graph_out != nullptr)
  {
    *has_async_graph_out =
        status >= kInstantiated && JS_ModuleHasAsyncGraph(ctx_, entry->module);
  }
  if (error_out != nullptr)
    return wrap_owned(error, error_out);

  JS_FreeValue(ctx_, error);
  return napi_ok;
}

napi_status napi_module_wrap__::check_unsettled_top_level_await(unofficial_napi_module module,
                                                                bool warnings,
                                                                bool *settled_out)
{
  (void)warnings;
  if (find(module) == nullptr || settled_out == nullptr)
    return napi_util__::invalid_arg(env_);
  *settled_out = true;
  return napi_ok;
}

napi_status napi_module_wrap__::set_export(unofficial_napi_module module,
                                           napi_value export_name,
                                           napi_value export_value)
{
  record *entry = find(module);
  if (entry == nullptr ||
      !napi_util__::check_value(env_, export_name) ||
      !napi_util__::check_value(env_, export_value))
    return napi_util__::invalid_arg(env_);
  if (!JS_IsString(napi_quickjs_value_inner(env_, export_name)))
  {
    env_->set_last_exception(JS_NewTypeError(ctx_, "Synthetic module export name must be a string"));
    return napi_pending_exception;
  }
  std::string name = napi_util__::to_utf8(env_, export_name);
  if (JS_SetModuleExport(ctx_, entry->module, name.c_str(),
                         JS_DupValue(ctx_, napi_quickjs_value_inner(env_, export_value))) < 0)
  {
    env_->set_last_exception(JS_NewReferenceError(ctx_, "Synthetic module export is not defined"));
    return napi_pending_exception;
  }
  return napi_ok;
}

napi_status napi_module_wrap__::set_module_source_object(unofficial_napi_module module,
                                                         napi_value source_object)
{
  record *entry = find(module);
  if (entry == nullptr)
    return napi_util__::invalid_arg(env_);
  JS_FreeValue(ctx_, entry->source_object);
  entry->source_object = js_dup_or_undefined(env_, ctx_, source_object);
  return napi_ok;
}

napi_status napi_module_wrap__::get_module_source_object(unofficial_napi_module module,
                                                         napi_value *result_out)
{
  record *entry = find(module);
  if (entry == nullptr || result_out == nullptr)
    return napi_util__::invalid_arg(env_);
  if (JS_IsUndefined(entry->source_object))
    return napi_generic_failure;
  return wrap_owned(JS_DupValue(ctx_, entry->source_object), result_out);
}

napi_status napi_module_wrap__::create_cached_data(unofficial_napi_module module,
                                                   napi_value *result_out)
{
  if (result_out == nullptr)
    return napi_util__::invalid_arg(env_);

  // Serialize the already-compiled module (vm.SourceTextModule#createCachedData).
  // An evaluated module's function bytecode is gone; fall back to an empty
  // buffer in that case, matching the V8 provider's empty-cache behavior.
  std::vector<uint8_t> bytes;
  record *entry = find(module);
  if (entry != nullptr && !entry->synthetic && !JS_IsUndefined(entry->module_value))
  {
    size_t serialized_size = 0;
    uint8_t *serialized = JS_WriteObject(ctx_, &serialized_size, entry->module_value,
                                         JS_WRITE_OBJ_BYTECODE | JS_WRITE_OBJ_REFERENCE);
    if (serialized != nullptr)
    {
      // Self-validating QJSB header. source_hash pins module identity so the
      // consuming vm.SourceTextModule constructor's deserialize rejects a
      // different source; filename_hash is 0 (unenforced) because Node assigns
      // vm modules numbered default identifiers (vm:module(N)), so a
      // consumer's identifier legitimately differs and V8 does not key
      // CachedData on the name either. params is empty for modules.
      napi_bytecode_identity id;
      id.shape = unofficial_napi_bytecode_shape_module;
      id.source_hash = entry->source_hash;
      id.params_hash = napi_bytecode_params_hash({});
      id.filename_hash = 0;
      bytes = napi_bytecode_serialize_payload(id, serialized, serialized_size);
      js_free(ctx_, serialized);
    }
    else
    {
      JSValue exc = JS_GetException(ctx_);
      JS_FreeValue(ctx_, exc);
    }
  }

  napi_value arraybuffer = nullptr;
  void *data = nullptr;
  napi_status status = napi_create_arraybuffer(env_, bytes.size(), &data, &arraybuffer);
  if (status != napi_ok)
    return status;
  if (!bytes.empty() && data != nullptr)
    std::memcpy(data, bytes.data(), bytes.size());
  return napi_create_typedarray(env_, napi_uint8_array, bytes.size(), arraybuffer, 0, result_out);
}

napi_status napi_module_wrap__::set_hooks(const unofficial_napi_module_hooks *hooks)
{
  if (hooks == nullptr || hooks->size < sizeof(*hooks) ||
      hooks->version != UNOFFICIAL_NAPI_MODULE_HOOKS_VERSION)
    return napi_util__::invalid_arg(env_);

  JSValue import_callback =
      (!is_nullish(env_, hooks->import_module_dynamically) &&
       JS_IsFunction(ctx_, napi_quickjs_value_inner(env_, hooks->import_module_dynamically)))
          ? JS_DupValue(ctx_, napi_quickjs_value_inner(env_, hooks->import_module_dynamically))
          : JS_UNDEFINED;
  JSValue import_meta_callback =
      (!is_nullish(env_, hooks->initialize_import_meta_object) &&
       JS_IsFunction(ctx_, napi_quickjs_value_inner(env_, hooks->initialize_import_meta_object)))
          ? JS_DupValue(ctx_, napi_quickjs_value_inner(env_, hooks->initialize_import_meta_object))
          : JS_UNDEFINED;

  JS_FreeValue(ctx_, import_module_dynamically_callback_);
  JS_FreeValue(ctx_, initialize_import_meta_callback_);
  import_module_dynamically_callback_ = import_callback;
  initialize_import_meta_callback_ = import_meta_callback;
  return napi_ok;
}

napi_status napi_module_wrap__::import_module_dynamically(size_t argc,
                                                          napi_value const *argv,
                                                          napi_value *result_out)
{
  if (result_out == nullptr)
    return napi_util__::invalid_arg(env_);
  if (!JS_IsFunction(ctx_, import_module_dynamically_callback_))
    return napi_util__::create_undefined(env_, result_out);

  JSValue args[5] = {JS_UNDEFINED, JS_UNDEFINED, JS_UNDEFINED, JS_UNDEFINED, JS_UNDEFINED};
  if (argc >= 5)
  {
    for (size_t i = 0; i < 5; ++i)
      args[i] = js_dup_or_undefined(env_, ctx_, argv[i]);
  }
  else
  {
    args[0] = get_symbols_binding_property("vm_dynamic_import_default_internal");
    args[1] = argc >= 1 ? js_dup_or_undefined(env_, ctx_, argv[0]) : JS_UNDEFINED;
    args[2] = JS_NewInt32(ctx_, kEvaluationPhase);
    args[3] = create_frozen_null_proto_object();
    args[4] = argc >= 2 ? js_dup_or_undefined(env_, ctx_, argv[1]) : JS_UNDEFINED;
  }

  JSValue result = call_callback(import_module_dynamically_callback_, 5, args);
  for (JSValue arg : args)
    JS_FreeValue(ctx_, arg);
  if (JS_IsException(result))
    return return_pending_exception("Dynamic import callback failed");
  if (JS_PromiseState(ctx_, result) != JS_PROMISE_NOT_A_PROMISE)
    pending_dynamic_imports_.push_back({JS_DupValue(ctx_, result), false});
  return wrap_owned(result, result_out);
}

bool napi_module_wrap__::has_pending_provider_work()
{
  size_t write_index = 0;
  for (size_t index = 0; index < pending_dynamic_imports_.size(); ++index)
  {
    auto &tracked = pending_dynamic_imports_[index];
    const bool pending =
        JS_PromiseState(ctx_, tracked.value) == JS_PROMISE_PENDING;
    const bool keep = pending || !tracked.settlement_observed;
    if (keep)
    {
      if (!pending)
        tracked.settlement_observed = true;
      pending_dynamic_imports_[write_index++] = tracked;
    }
    else
    {
      JS_FreeValue(ctx_, tracked.value);
    }
  }
  pending_dynamic_imports_.resize(write_index);
  return !pending_dynamic_imports_.empty();
}

napi_status napi_module_wrap__::create_required_module_facade(unofficial_napi_module module,
                                                              napi_value *result_out)
{
  record *entry = find(module);
  if (entry == nullptr || result_out == nullptr)
    return napi_util__::invalid_arg(env_);

  std::string filename = "<required-module-facade:" +
                         std::to_string(++facade_counter_) + ">";
  static constexpr const char *kFacadeSource =
      "export * from 'original';\n"
      "export { default } from 'original';\n"
      "export const __esModule = true;\n";
  JSEvalOptions options = {
      .version = JS_EVAL_OPTIONS_VERSION,
      .eval_flags = JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY,
      .filename = filename.c_str(),
      .line_num = 1,
  };
  JSValue facade_value = JS_Eval2(ctx_, kFacadeSource, std::strlen(kFacadeSource),
                                  &options);
  if (JS_IsException(facade_value))
    return return_pending_exception("Failed to compile required module facade");
  JSModuleDef *facade = JS_GetModuleDef(ctx_, facade_value);
  if (facade == nullptr)
  {
    JS_FreeValue(ctx_, facade_value);
    return napi_generic_failure;
  }

  if (JS_GetModuleRequestCount(ctx_, facade) < 1 ||
      JS_SetModuleRequestModule(ctx_, facade, 0, entry->module) < 0 ||
      JS_LinkModule(ctx_, facade) < 0)
  {
    JS_FreeValue(ctx_, facade_value);
    return return_pending_exception("Failed to link required module facade");
  }

  JSValue promise = JS_EvaluateModule(ctx_, facade);
  if (JS_IsException(promise))
  {
    JS_FreeValue(ctx_, facade_value);
    return return_pending_exception("Failed to evaluate required module facade");
  }
  JSPromiseStateEnum state = JS_PromiseState(ctx_, promise);
  if (state == JS_PROMISE_REJECTED)
  {
    JSValue reason = JS_PromiseResult(ctx_, promise);
    JS_FreeValue(ctx_, promise);
    JS_FreeValue(ctx_, facade_value);
    env_->set_last_exception(reason);
    return napi_pending_exception;
  }
  JS_FreeValue(ctx_, promise);
  if (state != JS_PROMISE_FULFILLED)
  {
    JS_FreeValue(ctx_, facade_value);
    return throw_error("ERR_REQUIRE_ASYNC_MODULE",
                       "require() cannot be used on an ESM graph with top-level await");
  }

  JSValue ns = JS_GetModuleNamespace(ctx_, facade);
  JS_FreeValue(ctx_, facade_value);
  if (JS_IsException(ns))
    return return_pending_exception("Failed to get required module facade namespace");
  return wrap_owned(ns, result_out);
}

void napi_module_wrap__::register_dynamic_import_referrer(napi_value referrer_name,
                                                          napi_value host_defined_option_id)
{
  if (is_nullish(env_, referrer_name) || is_nullish(env_, host_defined_option_id) ||
      !JS_IsSymbol(napi_quickjs_value_inner(env_, host_defined_option_id)))
    return;

  std::string name = napi_util__::to_utf8(env_, referrer_name);
  if (name.empty())
    return;

  for (auto &referrer : script_referrers_)
  {
    if (referrer.name == name)
    {
      JS_FreeValue(ctx_, referrer.host_defined_option_id);
      referrer.host_defined_option_id = JS_DupValue(ctx_, napi_quickjs_value_inner(env_, host_defined_option_id));
      return;
    }
  }

  script_referrer referrer;
  referrer.name = std::move(name);
  referrer.host_defined_option_id = JS_DupValue(ctx_, napi_quickjs_value_inner(env_, host_defined_option_id));
  script_referrers_.push_back(std::move(referrer));
}

void napi_module_wrap__::unregister_dynamic_import_referrer(napi_value referrer_name,
                                                            napi_value host_defined_option_id)
{
  if (is_nullish(env_, referrer_name) || is_nullish(env_, host_defined_option_id) ||
      !JS_IsSymbol(napi_quickjs_value_inner(env_, host_defined_option_id)))
    return;

  std::string name = napi_util__::to_utf8(env_, referrer_name);
  if (name.empty())
    return;

  JSValueConst expected = napi_quickjs_value_inner(env_, host_defined_option_id);
  for (auto it = script_referrers_.begin(); it != script_referrers_.end(); ++it)
  {
    if (it->name == name && JS_IsStrictEqual(ctx_, it->host_defined_option_id, expected))
    {
      JS_FreeValue(ctx_, it->host_defined_option_id);
      script_referrers_.erase(it);
      return;
    }
  }
}

int napi_module_wrap__::initialize_synthetic_module(JSModuleDef *module)
{
  record *entry = find_by_module(module);
  if (entry == nullptr || !JS_IsFunction(ctx_, entry->synthetic_eval_steps))
    return 0;
  JSValue result = JS_Call(ctx_, entry->synthetic_eval_steps,
                           entry->wrapper, 0, nullptr);
  if (JS_IsException(result))
    return -1;
  JS_FreeValue(ctx_, result);
  return 0;
}

int napi_module_wrap__::initialize_import_meta(JSModuleDef *module, JSValueConst meta)
{
  record *entry = find_by_module(module);
  if (entry == nullptr || !JS_IsFunction(ctx_, initialize_import_meta_callback_))
    return 0;

  JSValue args[3] = {
      JS_DupValue(ctx_, entry->host_defined_option_id),
      JS_DupValue(ctx_, meta),
      JS_DupValue(ctx_, entry->wrapper),
  };
  JSValue result = call_callback(initialize_import_meta_callback_, 3, args);
  for (JSValue arg : args)
    JS_FreeValue(ctx_, arg);
  if (JS_IsException(result))
    return -1;
  JS_FreeValue(ctx_, result);
  return 0;
}

JSValue napi_module_wrap__::import_module_dynamically(JSModuleDef *referrer,
                                                      JSValueConst referrer_name,
                                                      JSValueConst specifier,
                                                      JSValueConst attributes,
                                                      JSModuleImportPhaseEnum phase)
{
  if (!JS_IsFunction(ctx_, import_module_dynamically_callback_))
    return JS_ThrowTypeError(ctx_, "Dynamic import callback is not registered");

  record *entry = find_by_module(referrer);
  if (entry == nullptr && JS_IsString(referrer_name))
  {
    std::string referrer_string = value_to_string(ctx_, referrer_name);
    for (record *candidate : records_)
    {
      if (candidate == nullptr || candidate->module == nullptr)
        continue;
      JSAtom module_name = JS_GetModuleName(ctx_, candidate->module);
      const char *module_name_string = JS_AtomToCString(ctx_, module_name);
      const bool matches = module_name_string != nullptr &&
                           referrer_string == module_name_string;
      JS_FreeCString(ctx_, module_name_string);
      JS_FreeAtom(ctx_, module_name);
      if (matches)
      {
        entry = candidate;
        break;
      }
    }
  }
  JSValue referrer_symbol = entry != nullptr
                                ? JS_DupValue(ctx_, entry->host_defined_option_id)
                                : get_symbols_binding_property("vm_dynamic_import_default_internal");
  if (entry == nullptr && JS_IsString(referrer_name))
  {
    std::string referrer_string = value_to_string(ctx_, referrer_name);
    for (const auto &candidate : script_referrers_)
    {
      if (candidate.name == referrer_string)
      {
        JS_FreeValue(ctx_, referrer_symbol);
        referrer_symbol = JS_DupValue(ctx_, candidate.host_defined_option_id);
        break;
      }
    }
  }
  JSValue attrs = clone_attributes(attributes);
  if (JS_IsException(attrs))
  {
    JS_FreeValue(ctx_, referrer_symbol);
    return JS_EXCEPTION;
  }
  JSValue args[5] = {
      referrer_symbol,
      JS_DupValue(ctx_, specifier),
      JS_NewInt32(ctx_, to_node_phase(phase)),
      attrs,
      JS_DupValue(ctx_, referrer_name),
  };
  JSValue result = call_callback(import_module_dynamically_callback_, 5, args);
  for (JSValue arg : args)
    JS_FreeValue(ctx_, arg);
  if (JS_PromiseState(ctx_, result) != JS_PROMISE_NOT_A_PROMISE)
    pending_dynamic_imports_.push_back({JS_DupValue(ctx_, result), false});
  return result;
}

int napi_module_wrap__::synthetic_init(JSContext *ctx, JSModuleDef *module)
{
  auto *env = static_cast<napi_env>(JS_GetContextOpaque(ctx));
  if (!napi_util__::check_env(env))
    return -1;
  return env->module_wrap().initialize_synthetic_module(module);
}

int napi_module_wrap__::host_import_meta_init(JSContext *ctx,
                                              JSModuleDef *module,
                                              JSValueConst meta,
                                              void *opaque)
{
  auto *self = static_cast<napi_module_wrap__ *>(opaque);
  if (self == nullptr)
    return 0;
  return self->initialize_import_meta(module, meta);
}

JSValue napi_module_wrap__::host_dynamic_import(JSContext *ctx,
                                                JSModuleDef *referrer,
                                                JSValueConst referrer_name,
                                                JSValueConst specifier,
                                                JSValueConst attributes,
                                                JSModuleImportPhaseEnum phase,
                                                void *opaque)
{
  auto *self = static_cast<napi_module_wrap__ *>(opaque);
  if (self == nullptr)
    return JS_ThrowTypeError(ctx, "Dynamic import callback is not registered");
  return self->import_module_dynamically(referrer, referrer_name, specifier,
                                         attributes, phase);
}

} // namespace quickjs::detail
