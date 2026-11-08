#ifndef NAPI_QUICKJS_INTERNAL_NAPI_CONTEXTIFY_H_
#define NAPI_QUICKJS_INTERNAL_NAPI_CONTEXTIFY_H_

#include "unofficial_napi.h"

#include <quickjs.h>

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace quickjs::detail
{
    class napi_contextify__ final
    {
    public:
        struct context_record;

        napi_contextify__(napi_env env, JSContext *context);
        ~napi_contextify__();

        void teardown();

        napi_contextify__(const napi_contextify__ &) = delete;
        napi_contextify__ &operator=(const napi_contextify__ &) = delete;

        napi_status get_error_metadata(napi_value error,
                                       unofficial_napi_error_metadata_mode mode,
                                       unofficial_napi_error_metadata *out);
        napi_status preserve_error_source_message(napi_value error);
        napi_status configure_source_maps(bool enabled, napi_value callback);

        napi_status make_context(napi_value sandbox_or_symbol,
                                 napi_value name,
                                 napi_value origin_or_undefined,
                                 bool allow_code_gen_strings,
                                 bool allow_code_gen_wasm,
                                 bool own_microtask_queue,
                                 napi_value host_defined_option_id,
                                 napi_value *result_out);
        napi_status run_script(napi_value sandbox_or_null,
                               const unofficial_napi_js_source *source,
                               napi_value filename,
                               int32_t line_offset,
                               int32_t column_offset,
                               int64_t timeout,
                               bool display_errors,
                               bool break_on_sigint,
                               bool break_on_first_line,
                               napi_value host_defined_option_id,
                               napi_value *result_out);
        napi_status dispose_context(napi_value sandbox_or_context_global);
        napi_status compile_function(const unofficial_napi_js_source *source,
                                     napi_value filename,
                                     int32_t line_offset,
                                     int32_t column_offset,
                                     napi_value parsing_context_or_undefined,
                                     napi_value context_extensions_or_undefined,
                                     napi_value params_or_undefined,
                                     napi_value host_defined_option_id,
                                     napi_value *result_out);
        napi_status contains_module_syntax(napi_value code,
                                           napi_value filename,
                                           napi_value resource_name_or_undefined,
                                           bool cjs_var_in_scope,
                                           bool *result_out);
        napi_status bytecode_compile(napi_value source_text,
                                     napi_value filename,
                                     int32_t shape,
                                     napi_value params_or_undefined,
                                     napi_value host_defined_option_id,
                                     int32_t line_offset,
                                     int32_t column_offset,
                                     unofficial_napi_bytecode *bytecode_out,
                                     bool *can_parse_as_module_out);
        napi_status bytecode_deserialize(const uint8_t *bytes,
                                         size_t byte_length,
                                         napi_value source_text,
                                         napi_value filename,
                                         int32_t shape,
                                         napi_value params_or_undefined,
                                         napi_value host_defined_option_id,
                                         unofficial_napi_bytecode *bytecode_out,
                                         bool *rejected_out);
        napi_status bytecode_serialize(unofficial_napi_bytecode bytecode, napi_value *buffer_out);
        napi_status bytecode_release(unofficial_napi_bytecode bytecode);

    private:
        bool compile_trace_enabled() const;
        int32_t get_int32_property_or(JSValueConst object, const char *name, int32_t fallback) const;
        std::string get_string_property_or_empty(JSValueConst object, const char *name) const;
        std::string builtin_id_from_resource_name(const std::string &resource_name) const;
        std::string source_line_at(const std::string &source, int32_t one_based_line) const;
        std::string prepare_function_body_source(const std::string &source) const;
        JSValue compile_cjs_function(JSContext *ctx,
                                     const std::string &source,
                                     const std::string &source_url,
                                     const std::vector<std::string> &params,
                                     std::string *diagnostic_source_out,
                                     const uint8_t *cached_data = nullptr,
                                     size_t cached_data_size = 0,
                                     bool produce_cached_data = false,
                                     std::vector<uint8_t> *produced_cache_out = nullptr,
                                     bool *cache_rejected_out = nullptr) const;
        bool can_parse_as_module(const std::string &source,
                                 const std::string &source_url) const;
        void set_int32_property(JSValueConst object, const char *name, int32_t value) const;
        void annotate_compile_exception(JSValueConst exception,
                                        const std::string &source,
                                        const std::string &resource_name,
                                        int32_t line_offset,
                                        int32_t column_offset);
        context_record *find_context_record(JSValueConst sandbox) const;
        context_record *create_context_record(JSValueConst sandbox,
                                              JSValueConst host_defined_option_id);
        void destroy_context_record(context_record *record);

        // Owning environment and QuickJS context.
        napi_env env_;
        JSContext *ctx_;

        // Source-map and error-formatting state.
        bool source_maps_enabled_ = false;
        JSValue source_map_error_source_callback_;
        std::vector<std::unique_ptr<context_record>> contexts_;

        // Subsystem lifecycle.
        bool torn_down_ = false;
    };
}

#endif // NAPI_QUICKJS_INTERNAL_NAPI_CONTEXTIFY_H_
