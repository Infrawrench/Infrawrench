#include "internal/napi_contextify.h"

#include "internal/napi_bytecode.h"
#include "internal/napi_env.h"
#include "internal/napi_util.h"
#include "internal/napi_value.h"
#include "internal/quickjs_trace.h"
#include "node_api.h"

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <memory>
#include <utility>
#include <vector>

namespace quickjs::detail
{
    namespace
    {
        constexpr int k_contextify_internal_property_flags =
            JS_PROP_HAS_VALUE |
            JS_PROP_HAS_WRITABLE | JS_PROP_WRITABLE |
            JS_PROP_HAS_CONFIGURABLE | JS_PROP_CONFIGURABLE |
            JS_PROP_HAS_ENUMERABLE;

        napi_status define_contextify_internal_property(napi_env env,
                                                        JSContext *ctx,
                                                        JSValueConst object,
                                                        const char *name,
                                                        JSValue value)
        {
            if (JS_DefinePropertyValueStr(ctx, object, name, value, k_contextify_internal_property_flags) < 0)
                return napi_util__::return_pending_if_caught(env, "Failed to define contextify property");
            return napi_ok;
        }

        bool is_same_object(JSValueConst a, JSValueConst b)
        {
            return JS_IsObject(a) && JS_IsObject(b) && JS_VALUE_GET_PTR(a) == JS_VALUE_GET_PTR(b);
        }

        bool atom_equals_cstr(JSContext *ctx, JSAtom atom, const char *name)
        {
            JSAtom expected = JS_NewAtom(ctx, name);
            if (expected == JS_ATOM_NULL)
                return false;
            bool same = atom == expected;
            JS_FreeAtom(ctx, expected);
            return same;
        }

        bool should_skip_context_property(JSContext *ctx, JSAtom atom)
        {
            return atom_equals_cstr(ctx, atom, "globalThis") ||
                   atom_equals_cstr(ctx, atom, "__quickjs_contextified");
        }

        void free_property_descriptor(JSContext *ctx, JSPropertyDescriptor *desc)
        {
            JS_FreeValue(ctx, desc->value);
            JS_FreeValue(ctx, desc->getter);
            JS_FreeValue(ctx, desc->setter);
        }

        int define_property_from_descriptor(JSContext *source_ctx,
                                            JSContext *target_ctx,
                                            JSValueConst target,
                                            JSAtom atom,
                                            JSPropertyDescriptor *desc,
                                            JSValueConst map_from = JS_UNDEFINED,
                                            JSValueConst map_to = JS_UNDEFINED)
        {
            int flags = JS_PROP_HAS_CONFIGURABLE |
                        JS_PROP_HAS_ENUMERABLE |
                        (desc->flags & (JS_PROP_CONFIGURABLE | JS_PROP_ENUMERABLE));
            JSValueConst value = is_same_object(desc->value, map_from) ? map_to : desc->value;
            if (desc->flags & JS_PROP_GETSET)
            {
                flags |= JS_PROP_HAS_GET | JS_PROP_HAS_SET;
            }
            else
            {
                flags |= JS_PROP_HAS_VALUE |
                         JS_PROP_HAS_WRITABLE |
                         (desc->flags & JS_PROP_WRITABLE);
            }

            (void)source_ctx;
            return JS_DefineProperty(target_ctx, target, atom, value, desc->getter, desc->setter, flags);
        }
    } // namespace

    struct napi_contextify__::context_record
    {
        explicit context_record(napi_env owner,
                                JSContext *parent_context,
                                JSValueConst parent_sandbox,
                                JSContext *child_context,
                                JSValue child_global,
                                JSValueConst host_defined_option)
            : env{owner},
              parent_ctx{parent_context},
              ctx{child_context},
              sandbox{JS_DupValue(parent_context, parent_sandbox)},
              global{child_global},
              host_defined_option_id{JS_DupValue(parent_context, host_defined_option)}
        {
        }

        ~context_record()
        {
            close();
        }

        void close()
        {
            if (disposed)
                return;
            disposed = true;
            if (ctx != nullptr)
            {
                for (JSAtom atom : baseline_atoms)
                    JS_FreeAtom(ctx, atom);
                baseline_atoms.clear();
                JS_FreeValue(ctx, global);
                global = JS_UNDEFINED;
                JS_SetContextOpaque(ctx, nullptr);
                JS_FreeContext(ctx);
                ctx = nullptr;
            }
            if (parent_ctx != nullptr)
            {
                JS_FreeValue(parent_ctx, sandbox);
                JS_FreeValue(parent_ctx, host_defined_option_id);
            }
            sandbox = JS_UNDEFINED;
            host_defined_option_id = JS_UNDEFINED;
            parent_ctx = nullptr;
        }

        bool has_baseline_atom(JSAtom atom) const
        {
            return std::find(baseline_atoms.begin(), baseline_atoms.end(), atom) != baseline_atoms.end();
        }

        napi_env env = nullptr;
        JSContext *parent_ctx = nullptr;
        JSContext *ctx = nullptr;
        JSValue sandbox = JS_UNDEFINED;
        JSValue global = JS_UNDEFINED;
        JSValue host_defined_option_id = JS_UNDEFINED;
        std::vector<JSAtom> baseline_atoms;
        bool disposed = false;
    };

    napi_contextify__::napi_contextify__(napi_env env, JSContext *context)
        : env_{env},
          ctx_{context},
          source_map_error_source_callback_{JS_UNDEFINED}
    {
    }

    napi_contextify__::~napi_contextify__()
    {
        teardown();
    }

    void napi_contextify__::teardown()
    {
        if (torn_down_)
            return;
        contexts_.clear();
        JS_FreeValue(ctx_, source_map_error_source_callback_);
        source_map_error_source_callback_ = JS_UNDEFINED;
        torn_down_ = true;
    }

    napi_status copy_own_properties_between_contexts(napi_env env,
                                                     JSContext *source_ctx,
                                                     JSValueConst source,
                                                     JSContext *target_ctx,
                                                     JSValueConst target,
                                                     JSValueConst map_from = JS_UNDEFINED,
                                                     JSValueConst map_to = JS_UNDEFINED)
    {
        JSPropertyEnum *props = nullptr;
        uint32_t prop_count = 0;
        if (JS_GetOwnPropertyNames(source_ctx,
                                   &props,
                                   &prop_count,
                                   source,
                                   JS_GPN_STRING_MASK | JS_GPN_SYMBOL_MASK) < 0)
        {
            return napi_util__::return_pending_if_caught(env, "Failed to enumerate context properties");
        }

        for (uint32_t i = 0; i < prop_count; ++i)
        {
            JSAtom atom = props[i].atom;
            if (should_skip_context_property(source_ctx, atom))
                continue;

            JSPropertyDescriptor desc;
            int has = JS_GetOwnProperty(source_ctx, &desc, source, atom);
            if (has < 0)
            {
                JS_FreePropertyEnum(source_ctx, props, prop_count);
                return napi_util__::return_pending_if_caught(env, "Failed to read context property");
            }
            if (has == 0)
                continue;

            int rc = define_property_from_descriptor(source_ctx, target_ctx, target, atom, &desc, map_from, map_to);
            free_property_descriptor(source_ctx, &desc);
            if (rc < 0)
            {
                JS_FreePropertyEnum(source_ctx, props, prop_count);
                napi_env_context_scope__ target_scope{env, target_ctx};
                return napi_util__::return_pending_if_caught(env, "Failed to define context property");
            }
        }

        JS_FreePropertyEnum(source_ctx, props, prop_count);
        return napi_ok;
    }

    napi_status collect_global_baseline(napi_contextify__::context_record *record)
    {
        JSPropertyEnum *props = nullptr;
        uint32_t prop_count = 0;
        if (JS_GetOwnPropertyNames(record->ctx,
                                   &props,
                                   &prop_count,
                                   record->global,
                                   JS_GPN_STRING_MASK | JS_GPN_SYMBOL_MASK) < 0)
        {
            napi_env_context_scope__ child_scope{record->env, record->ctx};
            return napi_util__::return_pending_if_caught(record->env, "Failed to enumerate context baseline");
        }

        record->baseline_atoms.reserve(prop_count);
        for (uint32_t i = 0; i < prop_count; ++i)
            record->baseline_atoms.push_back(JS_DupAtom(record->ctx, props[i].atom));
        JS_FreePropertyEnum(record->ctx, props, prop_count);
        return napi_ok;
    }

    napi_status sync_sandbox_to_context(napi_contextify__::context_record *record)
    {
        return copy_own_properties_between_contexts(record->env,
                                                    record->parent_ctx,
                                                    record->sandbox,
                                                    record->ctx,
                                                    record->global,
                                                    record->sandbox,
                                                    record->global);
    }

    napi_status sync_context_to_sandbox(napi_contextify__::context_record *record)
    {
        JSPropertyEnum *props = nullptr;
        uint32_t prop_count = 0;
        if (JS_GetOwnPropertyNames(record->ctx,
                                   &props,
                                   &prop_count,
                                   record->global,
                                   JS_GPN_STRING_MASK | JS_GPN_SYMBOL_MASK) < 0)
        {
            napi_env_context_scope__ child_scope{record->env, record->ctx};
            return napi_util__::return_pending_if_caught(record->env, "Failed to enumerate context globals");
        }

        for (uint32_t i = 0; i < prop_count; ++i)
        {
            JSAtom atom = props[i].atom;
            if (should_skip_context_property(record->ctx, atom))
                continue;

            int sandbox_has = JS_GetOwnProperty(record->parent_ctx, nullptr, record->sandbox, atom);
            if (sandbox_has < 0)
            {
                JS_FreePropertyEnum(record->ctx, props, prop_count);
                napi_env_context_scope__ parent_scope{record->env, record->parent_ctx};
                return napi_util__::return_pending_if_caught(record->env, "Failed to inspect sandbox property");
            }

            if (record->has_baseline_atom(atom) && sandbox_has == 0)
                continue;

            JSPropertyDescriptor desc;
            int has = JS_GetOwnProperty(record->ctx, &desc, record->global, atom);
            if (has < 0)
            {
                JS_FreePropertyEnum(record->ctx, props, prop_count);
                napi_env_context_scope__ child_scope{record->env, record->ctx};
                return napi_util__::return_pending_if_caught(record->env, "Failed to read context global");
            }
            if (has == 0)
                continue;

            int rc = define_property_from_descriptor(record->ctx,
                                                    record->parent_ctx,
                                                    record->sandbox,
                                                    atom,
                                                    &desc,
                                                    record->global,
                                                    record->sandbox);
            free_property_descriptor(record->ctx, &desc);
            if (rc < 0)
            {
                JS_FreePropertyEnum(record->ctx, props, prop_count);
                napi_env_context_scope__ parent_scope{record->env, record->parent_ctx};
                return napi_util__::return_pending_if_caught(record->env, "Failed to write sandbox property");
            }
        }

        JS_FreePropertyEnum(record->ctx, props, prop_count);
        return napi_ok;
    }

    napi_contextify__::context_record *napi_contextify__::find_context_record(JSValueConst sandbox) const
    {
        for (const auto &record : contexts_)
        {
            if (record != nullptr && !record->disposed && is_same_object(record->sandbox, sandbox))
                return record.get();
        }
        return nullptr;
    }

    napi_contextify__::context_record *napi_contextify__::create_context_record(
        JSValueConst sandbox,
        JSValueConst host_defined_option_id)
    {
        JSRuntime *rt = JS_GetRuntime(ctx_);
        JSContext *child_ctx = JS_NewContext(rt);
        if (child_ctx == nullptr)
            return nullptr;
        JS_SetContextOpaque(child_ctx, env_);
        JSValue child_global = JS_GetGlobalObject(child_ctx);
        if (JS_IsException(child_global))
        {
            JS_SetContextOpaque(child_ctx, nullptr);
            JS_FreeContext(child_ctx);
            return nullptr;
        }

        auto record = std::make_unique<context_record>(env_,
                                                       ctx_,
                                                       sandbox,
                                                       child_ctx,
                                                       child_global,
                                                       host_defined_option_id);
        context_record *raw = record.get();
        contexts_.push_back(std::move(record));
        if (collect_global_baseline(raw) != napi_ok)
        {
            destroy_context_record(raw);
            return nullptr;
        }
        return raw;
    }

    void napi_contextify__::destroy_context_record(context_record *record)
    {
        if (record == nullptr)
            return;
        auto it = std::find_if(contexts_.begin(), contexts_.end(), [record](const auto &entry)
                               { return entry.get() == record; });
        if (it != contexts_.end())
            contexts_.erase(it);
    }

    bool napi_contextify__::compile_trace_enabled() const
    {
        return NAPI_QUICKJS_TRACE_ENABLED("NAPI_QUICKJS_TRACE_CONTEXTIFY") ||
               NAPI_QUICKJS_TRACE_ENABLED("NAPI_QUICKJS_TRACE_BUILTINS");
    }

    int32_t napi_contextify__::get_int32_property_or(JSValueConst object,
                                                     const char *name,
                                                     int32_t fallback) const
    {
        JSValue value = JS_GetPropertyStr(ctx_, object, name);
        if (JS_IsException(value) || JS_IsUndefined(value) || JS_IsNull(value))
        {
            JS_FreeValue(ctx_, value);
            return fallback;
        }
        int32_t out = fallback;
        (void)JS_ToInt32(ctx_, &out, value);
        JS_FreeValue(ctx_, value);
        return out;
    }

    std::string napi_contextify__::get_string_property_or_empty(JSValueConst object,
                                                                const char *name) const
    {
        JSValue value = JS_GetPropertyStr(ctx_, object, name);
        if (JS_IsException(value) || JS_IsUndefined(value) || JS_IsNull(value))
        {
            JS_FreeValue(ctx_, value);
            return {};
        }
        std::string out = napi_util__::to_utf8(ctx_, value);
        JS_FreeValue(ctx_, value);
        return out;
    }

    std::string napi_contextify__::builtin_id_from_resource_name(const std::string &resource_name) const
    {
        const char prefix[] = "node:";
        if (resource_name.rfind(prefix, 0) == 0)
            return resource_name.substr(sizeof(prefix) - 1);
        return {};
    }

    std::string napi_contextify__::source_line_at(const std::string &source,
                                                  int32_t one_based_line) const
    {
        if (source.empty() || one_based_line <= 0)
            return {};
        size_t pos = 0;
        for (int32_t line = 1; line < one_based_line; ++line)
        {
            pos = source.find('\n', pos);
            if (pos == std::string::npos)
                return {};
            ++pos;
        }
        size_t end = source.find('\n', pos);
        std::string line = source.substr(pos, end == std::string::npos ? std::string::npos : end - pos);
        if (!line.empty() && line.back() == '\r')
            line.pop_back();
        if (line.size() > 240)
            line = line.substr(0, 240) + "...";
        return line;
    }

    std::string napi_contextify__::prepare_function_body_source(const std::string &source) const
    {
        if (source.size() < 2 || source[0] != '#' || source[1] != '!')
            return source;

        // V8 accepts hashbangs in vm.compileFunction bodies. QuickJS only skips
        // them for whole-script eval, so preserve lines while hiding the text.
        std::string prepared = source;
        for (char &ch : prepared)
        {
            if (ch == '\n' || ch == '\r')
                break;
            ch = ' ';
        }
        return prepared;
    }

    JSValue napi_contextify__::compile_cjs_function(JSContext *ctx,
                                                    const std::string &source,
                                                    const std::string &source_url,
                                                    const std::vector<std::string> &params,
                                                    std::string *diagnostic_source_out,
                                                    const uint8_t *cached_data,
                                                    size_t cached_data_size,
                                                    bool produce_cached_data,
                                                    std::vector<uint8_t> *produced_cache_out,
                                                    bool *cache_rejected_out) const
    {
        if (cache_rejected_out != nullptr)
            *cache_rejected_out = false;
        if (cached_data != nullptr && cached_data_size > 0)
        {
            // Bytecode from a different quickjs build (or corrupted data) makes
            // JS_ReadObject throw; treat it as a stale cache and recompile.
            JSValue restored = JS_ReadObject(ctx, cached_data, cached_data_size, JS_READ_OBJ_BYTECODE);
            if (JS_IsException(restored))
            {
                JSValue exc = JS_GetException(ctx);
                JS_FreeValue(ctx, exc);
                if (cache_rejected_out != nullptr)
                    *cache_rejected_out = true;
            }
            else
            {
                if (diagnostic_source_out != nullptr)
                    *diagnostic_source_out = source;
                return JS_EvalFunction(ctx, restored);
            }
        }

        // NOTE: this wrapper text, the parameter list, the shebang blanking in
        // prepare_function_body_source(), and the sourceURL suffix all shape the
        // bytecode serialized below. Changing any of them requires bumping
        // edge_bytecode_cache::kFormatVersion so stale sidecars are rejected.
        std::string function_body = prepare_function_body_source(source);
        std::string diagnostic_source = source;
        if (!source.empty() && !source_url.empty())
        {
            function_body += "\n//# sourceURL=";
            function_body += source_url;
            diagnostic_source += "\n//# sourceURL=";
            diagnostic_source += source_url;
        }
        if (diagnostic_source_out != nullptr)
            *diagnostic_source_out = diagnostic_source;

        std::string compile_source = "(function anonymous(";
        for (size_t i = 0; i < params.size(); ++i)
        {
            if (i != 0)
                compile_source += ',';
            compile_source += params[i];
        }
        compile_source += "\n) {\n";
        compile_source += function_body;
        compile_source += "\n})";

        JSEvalOptions options = {
            .version = JS_EVAL_OPTIONS_VERSION,
            .eval_flags = JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_COMPILE_ONLY,
            .filename = source_url.empty() ? "<contextify>" : source_url.c_str(),
            .line_num = 1,
        };
        JSValue bytecode = JS_Eval2(ctx, compile_source.c_str(), compile_source.size(), &options);
        if (JS_IsException(bytecode))
            return JS_EXCEPTION;
        if (produce_cached_data && produced_cache_out != nullptr)
        {
            size_t serialized_size = 0;
            uint8_t *serialized = JS_WriteObject(ctx, &serialized_size, bytecode, JS_WRITE_OBJ_BYTECODE);
            if (serialized != nullptr)
            {
                produced_cache_out->assign(serialized, serialized + serialized_size);
                js_free(ctx, serialized);
            }
            else
            {
                // JS_WriteObject raised an exception; clear it so it does not
                // leak pending into the JS_EvalFunction below (which would see
                // a stale exception) or out to the caller.
                JSValue exc = JS_GetException(ctx);
                JS_FreeValue(ctx, exc);
            }
        }
        return JS_EvalFunction(ctx, bytecode);
    }

    bool napi_contextify__::can_parse_as_module(const std::string &source,
                                                const std::string &source_url) const
    {
        JSEvalOptions options = {
            .version = JS_EVAL_OPTIONS_VERSION,
            .eval_flags = JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY,
            .filename = source_url.empty() ? "<module>" : source_url.c_str(),
            .line_num = 1,
        };
        JSValue module = JS_Eval2(ctx_, source.c_str(), source.size(), &options);
        if (JS_IsException(module))
        {
            JSValue exception = JS_GetException(ctx_);
            JS_FreeValue(ctx_, exception);
            return false;
        }
        JS_FreeValue(ctx_, module);
        return true;
    }

    void napi_contextify__::set_int32_property(JSValueConst object,
                                               const char *name,
                                               int32_t value) const
    {
        JS_SetPropertyStr(ctx_, object, name, JS_NewInt32(ctx_, value));
    }

    void napi_contextify__::annotate_compile_exception(JSValueConst exception,
                                                       const std::string &source,
                                                       const std::string &resource_name,
                                                       int32_t line_offset,
                                                       int32_t column_offset)
    {
        if (!napi_util__::check_env(env_) || !JS_IsObject(exception))
            return;

        const std::string builtin_id = builtin_id_from_resource_name(resource_name);
        const std::string quickjs_file = get_string_property_or_empty(exception, "fileName");
        const int32_t quickjs_line = get_int32_property_or(exception, "lineNumber", -1);
        const int32_t mapped_line = quickjs_line > 0 ? quickjs_line + line_offset : -1;

        JS_SetPropertyStr(ctx_, exception, "node:quickjsContextifyCompile", JS_NewBool(ctx_, true));
        napi_util__::set_string_property(ctx_, exception, "node:quickjsCompileResourceName", resource_name);
        if (!builtin_id.empty())
            napi_util__::set_string_property(ctx_, exception, "node:quickjsCompileBuiltinId", builtin_id);
        set_int32_property(exception, "node:quickjsCompileLineOffset", line_offset);
        set_int32_property(exception, "node:quickjsCompileColumnOffset", column_offset);
        if (quickjs_line > 0)
            set_int32_property(exception, "node:quickjsCompileQuickJSLine", quickjs_line);
        if (mapped_line > 0)
            set_int32_property(exception, "node:quickjsCompileMappedLine", mapped_line);

        if (!compile_trace_enabled())
            return;

        std::string summary = "[quickjs contextify compile]";
        if (!resource_name.empty())
            summary += " resource=" + resource_name;
        if (!builtin_id.empty())
            summary += " builtin=" + builtin_id;
        if (!quickjs_file.empty())
            summary += " quickjsFile=" + quickjs_file;
        if (quickjs_line > 0)
            summary += " quickjsLine=" + std::to_string(quickjs_line);
        if (mapped_line > 0)
            summary += " mappedLine=" + std::to_string(mapped_line);
        summary += " lineOffset=" + std::to_string(line_offset);
        summary += " columnOffset=" + std::to_string(column_offset);

        std::string source_line = source_line_at(source, quickjs_line);
        if (!source_line.empty())
            summary += " sourceLine=\"" + source_line + "\"";

        std::fprintf(stderr, "%s\n", summary.c_str());

        JSValue stack = JS_GetPropertyStr(ctx_, exception, "stack");
        std::string stack_text;
        if (!JS_IsException(stack) && !JS_IsUndefined(stack) && !JS_IsNull(stack))
            stack_text = napi_util__::to_utf8(ctx_, stack);
        JS_FreeValue(ctx_, stack);
        if (!stack_text.empty())
            napi_util__::set_string_property(ctx_, exception, "stack", summary + "\n" + stack_text);
    }

    napi_status napi_contextify__::get_error_metadata(
        napi_value error,
        unofficial_napi_error_metadata_mode mode,
        unofficial_napi_error_metadata *out)
    {
        if (!napi_util__::check_env(env_) || error == nullptr || out == nullptr)
            return napi_invalid_arg;
        std::memset(out, 0, sizeof(*out));
        if (mode == unofficial_napi_error_metadata_take_preserved)
            return napi_ok;
        if (mode != unofficial_napi_error_metadata_current &&
            mode != unofficial_napi_error_metadata_positions_only &&
            mode != unofficial_napi_error_metadata_thrown_at_only)
            return napi_invalid_arg;

        // QuickJS does not currently expose a provider stack snapshot for an
        // arbitrary caught value. The cheap query is nevertheless a valid,
        // side-effect-free empty result and must not inspect user properties.
        if (mode == unofficial_napi_error_metadata_thrown_at_only)
            return napi_ok;

        out->line_number = -1;
        out->start_column = -1;
        out->end_column = -1;
        napi_value empty = nullptr;
        napi_status status = napi_create_string_utf8(env_, "", 0, &empty);
        if (status != napi_ok)
            return status;
        out->source_line = empty;
        out->script_resource_name = empty;

        if (mode == unofficial_napi_error_metadata_positions_only)
            return napi_ok;

        JSValueConst raw_error = napi_quickjs_value_inner(env_, error);
        if (!JS_IsObject(raw_error))
            return napi_util__::create_undefined(env_, &out->stderr_line);
        JSValue value = JS_GetPropertyStr(ctx_, raw_error, "node:arrowMessage");
        if (JS_IsException(value))
            return napi_pending_exception;
        if (JS_IsUndefined(value))
        {
            JS_FreeValue(ctx_, value);
            return napi_util__::create_undefined(env_, &out->stderr_line);
        }
        return napi_util__::wrap_owned(env_, value, &out->stderr_line);
    }

    napi_status napi_contextify__::preserve_error_source_message(napi_value error)
    {
        // QuickJS does not expose a V8-style message for an arbitrary caught Error.
        if (!napi_util__::check_env(env_) || error == nullptr)
            return napi_invalid_arg;
        return napi_ok;
    }

    napi_status napi_contextify__::configure_source_maps(bool enabled, napi_value callback)
    {
        if (!napi_util__::check_env(env_))
            return napi_invalid_arg;
        if (callback != nullptr && !JS_IsUndefined(napi_quickjs_value_inner(env_, callback)) &&
            !JS_IsNull(napi_quickjs_value_inner(env_, callback)) && !JS_IsFunction(ctx_, napi_quickjs_value_inner(env_, callback)))
        {
            return napi_invalid_arg;
        }

        source_maps_enabled_ = enabled;
        JS_FreeValue(ctx_, source_map_error_source_callback_);
        source_map_error_source_callback_ =
            callback == nullptr ? JS_UNDEFINED : JS_DupValue(ctx_, napi_quickjs_value_inner(env_, callback));
        return napi_ok;
    }

    napi_status napi_contextify__::make_context(napi_value sandbox_or_symbol,
                                                napi_value name,
                                                napi_value origin_or_undefined,
                                                bool allow_code_gen_strings,
                                                bool allow_code_gen_wasm,
                                                bool own_microtask_queue,
                                                napi_value host_defined_option_id,
                                                napi_value *result_out)
    {
        (void)name;
        (void)origin_or_undefined;
        (void)allow_code_gen_strings;
        (void)allow_code_gen_wasm;
        (void)own_microtask_queue;
        if (!napi_util__::check_env(env_) || sandbox_or_symbol == nullptr || result_out == nullptr)
            return napi_invalid_arg;
        JSValue sandbox = napi_quickjs_value_inner(env_, sandbox_or_symbol);
        if (!JS_IsObject(sandbox))
            return napi_invalid_arg;
        context_record *record = find_context_record(sandbox);
        if (record == nullptr)
        {
            JSValue host_id = host_defined_option_id == nullptr ? JS_UNDEFINED : napi_quickjs_value_inner(env_, host_defined_option_id);
            record = create_context_record(sandbox, host_id);
            if (record == nullptr)
                return napi_util__::return_pending_if_caught(env_, "Failed to create QuickJS context");
        }
        napi_status status = define_contextify_internal_property(env_,
                                                                 ctx_,
                                                                 sandbox,
                                                                 "__quickjs_contextified",
                                                                 JS_NewBool(ctx_, true));
        if (status != napi_ok)
            return status;
        status = define_contextify_internal_property(env_,
                                                     ctx_,
                                                     sandbox,
                                                     "globalThis",
                                                     JS_DupValue(ctx_, sandbox));
        if (status != napi_ok)
            return status;
        return napi_util__::wrap_dup(env_, sandbox, result_out);
    }

    napi_status napi_contextify__::run_script(napi_value sandbox_or_null,
                                              const unofficial_napi_js_source *source,
                                              napi_value filename,
                                              int32_t line_offset,
                                              int32_t column_offset,
                                              int64_t timeout,
                                              bool display_errors,
                                              bool break_on_sigint,
                                              bool break_on_first_line,
                                              napi_value host_defined_option_id,
                                              napi_value *result_out)
    {
        (void)column_offset;
        (void)timeout;
        (void)display_errors;
        (void)break_on_sigint;
        (void)break_on_first_line;
        if (!napi_util__::check_env(env_) ||
            !unofficial_napi_js_source_is_valid(source) || result_out == nullptr)
            return napi_invalid_arg;
        auto *bytecode_record = napi_bytecode_record_from_source(source);
        if (bytecode_record != nullptr &&
            bytecode_record->shape != unofficial_napi_bytecode_shape_script)
            return napi_invalid_arg;
        env_->module_wrap().register_dynamic_import_referrer(filename, host_defined_option_id);
        context_record *record = nullptr;
        if (sandbox_or_null != nullptr && !JS_IsNull(napi_quickjs_value_inner(env_, sandbox_or_null)))
        {
            if (!napi_util__::is_truthy_property(env_, sandbox_or_null, "__quickjs_contextified"))
            {
                env_->module_wrap().unregister_dynamic_import_referrer(filename, host_defined_option_id);
                return napi_invalid_arg;
            }
            record = find_context_record(napi_quickjs_value_inner(env_, sandbox_or_null));
            if (record == nullptr || record->disposed)
            {
                env_->module_wrap().unregister_dynamic_import_referrer(filename, host_defined_option_id);
                return napi_invalid_arg;
            }
        }

        std::string src = bytecode_record != nullptr ? bytecode_record->source_utf8
                                                     : napi_util__::to_utf8(env_, source->text);
        std::string label = filename == nullptr ? "<contextify>" : napi_util__::to_utf8(env_, filename);
        JSValue result = JS_UNDEFINED;
        if (record != nullptr)
        {
            napi_status sync_status = sync_sandbox_to_context(record);
            if (sync_status != napi_ok)
            {
                env_->module_wrap().unregister_dynamic_import_referrer(filename, host_defined_option_id);
                return sync_status;
            }
            napi_env_context_scope__ child_scope{env_, record->ctx};
            JSEvalOptions options{
                .version = JS_EVAL_OPTIONS_VERSION,
                .eval_flags = JS_EVAL_TYPE_GLOBAL,
                .filename = label.c_str(),
                .line_num = std::max<int32_t>(1, line_offset + 1),
            };
            result = JS_EvalThis2(record->ctx, record->global, src.c_str(), src.size(), &options);
            if (JS_IsException(result))
            {
                JSValue exc = JS_GetException(record->ctx);
                napi_util__::set_last_exception(env_, exc);
                env_->module_wrap().unregister_dynamic_import_referrer(filename, host_defined_option_id);
                return napi_quickjs_set_last_error(env_, napi_pending_exception, "Exception while running contextify script");
            }
            sync_status = sync_context_to_sandbox(record);
            if (sync_status != napi_ok)
            {
                JS_FreeValue(record->ctx, result);
                env_->module_wrap().unregister_dynamic_import_referrer(filename, host_defined_option_id);
                return sync_status;
            }
            env_->module_wrap().unregister_dynamic_import_referrer(filename, host_defined_option_id);
            *result_out = env_->wrap_value_in_current_scope(record->ctx, result, true);
            return (*result_out == nullptr) ? napi_generic_failure : napi_ok;
        }

        if (bytecode_record != nullptr && !JS_IsUndefined(bytecode_record->artifact))
        {
            // JS_EvalFunction consumes its argument; the artifact stays reusable.
            result = JS_EvalFunction(ctx_, JS_DupValue(ctx_, bytecode_record->artifact));
        }
        else
        {
            result = JS_Eval(ctx_, src.c_str(), src.size(), label.c_str(), JS_EVAL_TYPE_GLOBAL);
        }
        env_->module_wrap().unregister_dynamic_import_referrer(filename, host_defined_option_id);
        if (JS_IsException(result))
            return napi_util__::return_pending_if_caught(env_, "Exception while running contextify script");
        return napi_util__::wrap_owned(env_, result, result_out);
    }

    napi_status napi_contextify__::dispose_context(napi_value sandbox_or_context_global)
    {
        if (!napi_util__::check_env(env_) || sandbox_or_context_global == nullptr)
            return napi_invalid_arg;
        JSValue sandbox = napi_quickjs_value_inner(env_, sandbox_or_context_global);
        if (!JS_IsObject(sandbox))
            return napi_invalid_arg;
        context_record *record = find_context_record(sandbox);
        if (record != nullptr)
            destroy_context_record(record);
        return define_contextify_internal_property(env_, ctx_, sandbox, "__quickjs_contextified", JS_NewBool(ctx_, false));
    }

    napi_status napi_contextify__::compile_function(const unofficial_napi_js_source *source,
                                                    napi_value filename,
                                                    int32_t line_offset,
                                                    int32_t column_offset,
                                                    napi_value parsing_context_or_undefined,
                                                    napi_value context_extensions_or_undefined,
                                                    napi_value params_or_undefined,
                                                    napi_value host_defined_option_id,
                                                    napi_value *result_out)
    {
        (void)context_extensions_or_undefined;
        (void)host_defined_option_id;
        if (!napi_util__::check_env(env_) ||
            !unofficial_napi_js_source_is_valid(source) || result_out == nullptr)
            return napi_invalid_arg;

        auto *bytecode_record = napi_bytecode_record_from_source(source);
        if (bytecode_record != nullptr &&
            bytecode_record->shape != unofficial_napi_bytecode_shape_cjs_function)
            return napi_invalid_arg;

        std::vector<std::string> params;
        if (params_or_undefined != nullptr && JS_IsArray(napi_quickjs_value_inner(env_, params_or_undefined)))
        {
            uint32_t length = 0;
            JSValue len_val = JS_GetPropertyStr(ctx_, napi_quickjs_value_inner(env_, params_or_undefined), "length");
            JS_ToUint32(ctx_, &length, len_val);
            JS_FreeValue(ctx_, len_val);
            params.reserve(length);
            for (uint32_t i = 0; i < length; ++i)
            {
                JSValue param = JS_GetPropertyUint32(ctx_, napi_quickjs_value_inner(env_, params_or_undefined), i);
                if (JS_IsException(param))
                    return napi_pending_exception;
                params.push_back(napi_util__::to_utf8(ctx_, param));
                JS_FreeValue(ctx_, param);
            }
        }

        std::string source_text = bytecode_record != nullptr ? bytecode_record->source_utf8
                                                             : napi_util__::to_utf8(env_, source->text);
        std::string source_url;
        if (filename != nullptr && !JS_IsUndefined(napi_quickjs_value_inner(env_, filename)) && !JS_IsNull(napi_quickjs_value_inner(env_, filename)))
        {
            source_url = napi_util__::to_utf8(env_, filename);
        }

        context_record *record = nullptr;
        if (parsing_context_or_undefined != nullptr &&
            !JS_IsUndefined(napi_quickjs_value_inner(env_, parsing_context_or_undefined)) &&
            !JS_IsNull(napi_quickjs_value_inner(env_, parsing_context_or_undefined)))
        {
            record = find_context_record(napi_quickjs_value_inner(env_, parsing_context_or_undefined));
        }

        JSContext *compile_ctx = record == nullptr ? ctx_ : record->ctx;
        napi_env_context_scope__ compile_scope{env_, compile_ctx};

        JSValue fn = JS_UNDEFINED;
        bool have_fn = false;
        if (bytecode_record != nullptr && compile_ctx == ctx_ &&
            !JS_IsUndefined(bytecode_record->artifact))
        {
            // The handle's artifact is the compiled function; reuse it directly.
            fn = JS_DupValue(ctx_, bytecode_record->artifact);
            have_fn = true;
        }

        if (!have_fn)
        {
            const uint8_t *cached_bytes = nullptr;
            size_t cached_size = 0;
            if (bytecode_record != nullptr && !bytecode_record->bytes.empty())
            {
                cached_bytes = bytecode_record->bytes.data();
                cached_size = bytecode_record->bytes.size();
            }
            std::string diagnostic_source;
            fn = compile_cjs_function(compile_ctx, source_text, source_url, params, &diagnostic_source,
                                      cached_bytes, cached_size, false, nullptr, nullptr);
            if (JS_IsException(fn))
            {
                JSValue exc = JS_GetException(compile_ctx);
                if (compile_ctx == ctx_)
                    annotate_compile_exception(exc, diagnostic_source, source_url, line_offset, column_offset);
                napi_util__::set_last_exception(env_, exc);
                return napi_pending_exception;
            }
        }

        JSValue out = JS_NewObject(compile_ctx);
        JS_SetPropertyStr(compile_ctx, out, "function", fn);
        if (!source_url.empty())
            napi_util__::set_string_property(compile_ctx, out, "sourceURL", source_url);
        JS_SetPropertyStr(compile_ctx, out, "sourceMapURL", JS_UNDEFINED);
        *result_out = env_->wrap_value_in_current_scope(compile_ctx, out, true);
        return (*result_out == nullptr) ? napi_generic_failure : napi_ok;
    }

    napi_status napi_contextify__::contains_module_syntax(napi_value code,
                                                          napi_value filename,
                                                          napi_value resource_name_or_undefined,
                                                          bool cjs_var_in_scope,
                                                          bool *result_out)
    {
        if (!napi_util__::check_env(env_) || code == nullptr || result_out == nullptr)
            return napi_invalid_arg;

        std::string source = napi_util__::to_utf8(env_, code);
        std::string filename_string;
        if (filename != nullptr && !JS_IsUndefined(napi_quickjs_value_inner(env_, filename)) &&
            !JS_IsNull(napi_quickjs_value_inner(env_, filename)))
            filename_string = napi_util__::to_utf8(env_, filename);

        std::string resource_name = filename_string;
        if (resource_name_or_undefined != nullptr &&
            !JS_IsUndefined(napi_quickjs_value_inner(env_, resource_name_or_undefined)) &&
            !JS_IsNull(napi_quickjs_value_inner(env_, resource_name_or_undefined)))
            resource_name = napi_util__::to_utf8(env_, resource_name_or_undefined);

        std::vector<std::string> params;
        if (cjs_var_in_scope)
            params = {"exports", "require", "module", "__filename", "__dirname"};

        JSValue fn = compile_cjs_function(ctx_, source, filename_string, params, nullptr);
        if (!JS_IsException(fn))
        {
            JS_FreeValue(ctx_, fn);
            *result_out = false;
            return napi_ok;
        }

        JSValue cjs_exception = JS_GetException(ctx_);
        JS_FreeValue(ctx_, cjs_exception);

        *result_out = can_parse_as_module(source, resource_name);
        return napi_ok;
    }

    namespace
    {
        int bytecode_stub_module_init(JSContext *, JSModuleDef *)
        {
            return 0;
        }

        // JS_ReadObject resolves a module's import requests eagerly at read
        // time, but this embedding links modules explicitly afterwards
        // (JS_SetModuleRequestModule), so any placeholder satisfies the read.
        // The placeholder must NOT be registered under the requested name:
        // js_import_meta() resolves the executing module by name through
        // ctx->loaded_modules, so a stub under a real URL would shadow the
        // real module and break import.meta. Unique stub names sacrifice the
        // loaded-modules cache hit (another tiny stub per request) to keep
        // name lookups pointing at real modules only.
        JSModuleDef *bytecode_stub_module_loader(JSContext *ctx, const char *module_name, void *opaque)
        {
            (void)module_name;
            (void)opaque;
            static unsigned long long stub_counter = 0;
            char stub_name[64];
            std::snprintf(stub_name, sizeof(stub_name), "edge-bytecode-stub:%llu", ++stub_counter);
            return JS_NewCModule(ctx, stub_name, bytecode_stub_module_init);
        }

        struct bytecode_module_loader_guard
        {
            explicit bytecode_module_loader_guard(JSRuntime *rt) : rt_(rt)
            {
                JS_SetModuleLoaderFunc(rt_, nullptr, bytecode_stub_module_loader, nullptr);
            }
            ~bytecode_module_loader_guard()
            {
                JS_SetModuleLoaderFunc(rt_, nullptr, nullptr, nullptr);
            }
            JSRuntime *rt_;
        };

        std::vector<std::string> bytecode_params_from_napi(napi_env env, JSContext *ctx,
                                                           napi_value params_or_undefined)
        {
            std::vector<std::string> params;
            if (params_or_undefined == nullptr || !JS_IsArray(napi_quickjs_value_inner(env, params_or_undefined)))
                return params;
            uint32_t length = 0;
            JSValue len_val = JS_GetPropertyStr(ctx, napi_quickjs_value_inner(env, params_or_undefined), "length");
            JS_ToUint32(ctx, &length, len_val);
            JS_FreeValue(ctx, len_val);
            params.reserve(length);
            for (uint32_t i = 0; i < length; ++i)
            {
                JSValue param = JS_GetPropertyUint32(ctx, napi_quickjs_value_inner(env, params_or_undefined), i);
                if (JS_IsException(param))
                    break;
                params.push_back(napi_util__::to_utf8(ctx, param));
                JS_FreeValue(ctx, param);
            }
            return params;
        }
    }

    napi_status napi_contextify__::bytecode_compile(napi_value source_text,
                                                    napi_value filename,
                                                    int32_t shape,
                                                    napi_value params_or_undefined,
                                                    napi_value host_defined_option_id,
                                                    int32_t line_offset,
                                                    int32_t column_offset,
                                                    unofficial_napi_bytecode *bytecode_out,
                                                    bool *can_parse_as_module_out)
    {
        (void)host_defined_option_id;  // QuickJS handles HDO at record registration.
        (void)column_offset;           // QuickJS JS_Eval2 keys only on line_num.
        if (!napi_util__::check_env(env_) || source_text == nullptr || bytecode_out == nullptr)
            return napi_invalid_arg;
        *bytecode_out = nullptr;
        if (can_parse_as_module_out != nullptr)
            *can_parse_as_module_out = false;

        auto record = std::make_unique<napi_bytecode_record__>();
        record->ctx = ctx_;
        record->source_utf8 = napi_util__::to_utf8(env_, source_text);
        record->filename_utf8 = filename != nullptr ? napi_util__::to_utf8(env_, filename) : std::string();
        record->shape = shape;
        record->params = bytecode_params_from_napi(env_, ctx_, params_or_undefined);

        if (shape == unofficial_napi_bytecode_shape_cjs_function)
        {
            std::vector<uint8_t> produced;
            JSValue fn = compile_cjs_function(ctx_, record->source_utf8, record->filename_utf8,
                                              record->params, nullptr, nullptr, 0, true, &produced, nullptr);
            if (JS_IsException(fn))
            {
                JSValue exc = JS_GetException(ctx_);
                if (can_parse_as_module_out != nullptr)
                    *can_parse_as_module_out = can_parse_as_module(record->source_utf8, record->filename_utf8);
                napi_util__::set_last_exception(env_, exc);
                return napi_pending_exception;
            }
            record->artifact = fn;
            record->bytes = std::move(produced);
        }
        else if (shape == unofficial_napi_bytecode_shape_script ||
                 shape == unofficial_napi_bytecode_shape_module)
        {
            const bool is_module = shape == unofficial_napi_bytecode_shape_module;
            JSEvalOptions options = {
                .version = JS_EVAL_OPTIONS_VERSION,
                .eval_flags = (is_module ? JS_EVAL_TYPE_MODULE : JS_EVAL_TYPE_GLOBAL) |
                              JS_EVAL_FLAG_COMPILE_ONLY,
                .filename = record->filename_utf8.empty() ? "<bytecode>" : record->filename_utf8.c_str(),
                .line_num = std::max<int32_t>(1, line_offset + 1),
            };
            JSValue compiled = JS_Eval2(ctx_, record->source_utf8.c_str(), record->source_utf8.size(), &options);
            if (JS_IsException(compiled))
            {
                JSValue exc = JS_GetException(ctx_);
                if (!is_module && can_parse_as_module_out != nullptr)
                    *can_parse_as_module_out = can_parse_as_module(record->source_utf8, record->filename_utf8);
                napi_util__::set_last_exception(env_, exc);
                return napi_pending_exception;
            }
            size_t serialized_size = 0;
            const int write_flags = is_module ? (JS_WRITE_OBJ_BYTECODE | JS_WRITE_OBJ_REFERENCE)
                                              : JS_WRITE_OBJ_BYTECODE;
            uint8_t *serialized = JS_WriteObject(ctx_, &serialized_size, compiled, write_flags);
            if (serialized != nullptr)
            {
                record->bytes.assign(serialized, serialized + serialized_size);
                js_free(ctx_, serialized);
            }
            else
            {
                // JS_WriteObject raised an exception (e.g. OOM); drop it so it
                // does not leak pending out of this napi_ok return. The handle
                // still holds the live artifact; only serialization is lost.
                JSValue exc = JS_GetException(ctx_);
                JS_FreeValue(ctx_, exc);
            }
            record->artifact = compiled;
        }
        else
        {
            return napi_invalid_arg;
        }

        *bytecode_out = reinterpret_cast<unofficial_napi_bytecode>(record.release());
        return napi_ok;
    }

    napi_status napi_contextify__::bytecode_deserialize(const uint8_t *bytes,
                                                        size_t byte_length,
                                                        napi_value source_text,
                                                        napi_value filename,
                                                        int32_t shape,
                                                        napi_value params_or_undefined,
                                                        napi_value host_defined_option_id,
                                                        unofficial_napi_bytecode *bytecode_out,
                                                        bool *rejected_out)
    {
        (void)host_defined_option_id;  // QuickJS handles HDO at record registration.
        if (!napi_util__::check_env(env_) || bytes == nullptr || byte_length == 0 ||
            source_text == nullptr || bytecode_out == nullptr)
            return napi_invalid_arg;
        *bytecode_out = nullptr;
        if (rejected_out != nullptr)
            *rejected_out = false;

        auto record = std::make_unique<napi_bytecode_record__>();
        record->ctx = ctx_;
        record->source_utf8 = napi_util__::to_utf8(env_, source_text);
        record->filename_utf8 = filename != nullptr ? napi_util__::to_utf8(env_, filename) : std::string();
        record->shape = shape;
        record->params = bytecode_params_from_napi(env_, ctx_, params_or_undefined);

        // Payloads are fully self-validating (QJSB header pins shape, source,
        // params, filename, and payload integrity); reject any mismatch before
        // JS_ReadObject ever sees the bytes — its reader is not hardened, and
        // wrong-source/shape/params bytes would otherwise be silently accepted
        // (V8's CachedData rejects all of these natively).
        napi_bytecode_identity expect;
        expect.shape = shape;
        expect.source_hash = napi_bytecode_hash64(record->source_utf8.data(), record->source_utf8.size());
        expect.params_hash = napi_bytecode_params_hash(record->params);
        expect.filename_hash = napi_bytecode_hash64(record->filename_utf8.data(), record->filename_utf8.size());
        size_t payload_length = 0;
        const uint8_t *payload =
            napi_bytecode_validate_payload(bytes, byte_length, expect, &payload_length);
        if (payload == nullptr || payload_length == 0)
        {
            if (rejected_out != nullptr)
                *rejected_out = true;
            return napi_ok;
        }
        record->bytes.assign(payload, payload + payload_length);

        const bool is_module = shape == unofficial_napi_bytecode_shape_module;
        JSValue restored = JS_UNDEFINED;
        {
            std::unique_ptr<bytecode_module_loader_guard> guard;
            if (is_module)
                guard = std::make_unique<bytecode_module_loader_guard>(JS_GetRuntime(ctx_));
            const int read_flags = is_module ? (JS_READ_OBJ_BYTECODE | JS_READ_OBJ_REFERENCE)
                                             : JS_READ_OBJ_BYTECODE;
            restored = JS_ReadObject(ctx_, record->bytes.data(), record->bytes.size(), read_flags);
        }
        if (JS_IsException(restored))
        {
            JSValue exc = JS_GetException(ctx_);
            JS_FreeValue(ctx_, exc);
            if (rejected_out != nullptr)
                *rejected_out = true;
            return napi_ok;
        }

        if (shape == unofficial_napi_bytecode_shape_cjs_function)
        {
            // Evaluating the serialized wrapper expression yields the function
            // without running its body.
            JSValue fn = JS_EvalFunction(ctx_, restored);
            if (JS_IsException(fn))
            {
                JSValue exc = JS_GetException(ctx_);
                JS_FreeValue(ctx_, exc);
                if (rejected_out != nullptr)
                    *rejected_out = true;
                return napi_ok;
            }
            record->artifact = fn;
        }
        else
        {
            record->artifact = restored;
        }

        *bytecode_out = reinterpret_cast<unofficial_napi_bytecode>(record.release());
        return napi_ok;
    }

    napi_status napi_contextify__::bytecode_serialize(unofficial_napi_bytecode bytecode, napi_value *buffer_out)
    {
        if (!napi_util__::check_env(env_) || bytecode == nullptr || buffer_out == nullptr)
            return napi_invalid_arg;
        auto *record = reinterpret_cast<napi_bytecode_record__ *>(bytecode);
        std::vector<uint8_t> persisted;
        if (!record->bytes.empty())
        {
            napi_bytecode_identity id;
            id.shape = record->shape;
            id.source_hash = napi_bytecode_hash64(record->source_utf8.data(), record->source_utf8.size());
            id.params_hash = napi_bytecode_params_hash(record->params);
            id.filename_hash = napi_bytecode_hash64(record->filename_utf8.data(), record->filename_utf8.size());
            persisted = napi_bytecode_serialize_payload(id, record->bytes.data(), record->bytes.size());
        }
        napi_value arraybuffer = nullptr;
        void *data = nullptr;
        napi_status status = napi_create_arraybuffer(env_, persisted.size(), &data, &arraybuffer);
        if (status != napi_ok)
            return status;
        if (!persisted.empty() && data != nullptr)
            std::memcpy(data, persisted.data(), persisted.size());
        return napi_create_typedarray(env_, napi_uint8_array, persisted.size(), arraybuffer, 0, buffer_out);
    }

    napi_status napi_contextify__::bytecode_release(unofficial_napi_bytecode bytecode)
    {
        if (bytecode == nullptr)
            return napi_invalid_arg;
        auto *record = reinterpret_cast<napi_bytecode_record__ *>(bytecode);
        if (record->ctx != nullptr && !JS_IsUndefined(record->artifact))
            JS_FreeValue(record->ctx, record->artifact);
        delete record;
        return napi_ok;
    }
}
