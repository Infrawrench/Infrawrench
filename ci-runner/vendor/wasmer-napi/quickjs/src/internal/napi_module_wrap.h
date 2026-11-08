#ifndef NAPI_QUICKJS_MODULE_WRAP_H_
#define NAPI_QUICKJS_MODULE_WRAP_H_

#include "../../../include/js_native_api.h"
#include "../../../include/unofficial_napi.h"

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>
#include <quickjs.h>

namespace quickjs::detail
{

class napi_module_wrap__
{
public:
  napi_module_wrap__(napi_env env, JSContext *context);
  ~napi_module_wrap__();

  void teardown();

  napi_status create_source_text(napi_value wrapper,
                                 napi_value url,
                                 napi_value context_or_undefined,
                                 const unofficial_napi_js_source *source,
                                 int32_t line_offset,
                                 int32_t column_offset,
                                 napi_value host_defined_option_id,
                                 unofficial_napi_module *module_out);
  napi_status create_synthetic(napi_value wrapper,
                               napi_value url,
                               napi_value context_or_undefined,
                               napi_value export_names,
                               napi_value synthetic_eval_steps,
                               unofficial_napi_module *module_out);
  napi_status destroy(unofficial_napi_module module);
  napi_status get_creation_metadata(unofficial_napi_module module,
                                    napi_value *requests_out,
                                    bool *has_top_level_await_out);
  napi_status link(unofficial_napi_module module,
                   size_t count,
                   const unofficial_napi_module *linked_modules);
  napi_status instantiate(unofficial_napi_module module);
  napi_status evaluate(unofficial_napi_module module,
                       int64_t timeout,
                       bool break_on_sigint,
                       napi_value *result_out);
  napi_status evaluate_sync(unofficial_napi_module module,
                            napi_value filename,
                            napi_value parent_filename,
                            napi_value *result_out);
  napi_status get_namespace(unofficial_napi_module module,
                            napi_value *result_out);
  napi_status get_state(unofficial_napi_module module,
                        int32_t *status_out,
                        napi_value *error_out,
                        bool *has_async_graph_out);
  napi_status check_unsettled_top_level_await(unofficial_napi_module module,
                                              bool warnings,
                                              bool *settled_out);
  napi_status set_export(unofficial_napi_module module,
                         napi_value export_name,
                         napi_value export_value);
  napi_status set_module_source_object(unofficial_napi_module module,
                                       napi_value source_object);
  napi_status get_module_source_object(unofficial_napi_module module,
                                       napi_value *result_out);
  napi_status create_cached_data(unofficial_napi_module module,
                                 napi_value *result_out);
  napi_status set_hooks(const unofficial_napi_module_hooks *hooks);
  napi_status import_module_dynamically(size_t argc,
                                        napi_value const *argv,
                                        napi_value *result_out);
  bool has_pending_provider_work();
  napi_status create_required_module_facade(unofficial_napi_module module,
                                            napi_value *result_out);
  void register_dynamic_import_referrer(napi_value referrer_name,
                                        napi_value host_defined_option_id);
  void unregister_dynamic_import_referrer(napi_value referrer_name,
                                          napi_value host_defined_option_id);

  int initialize_synthetic_module(JSModuleDef *module);
  int initialize_import_meta(JSModuleDef *module, JSValueConst meta);
  JSValue import_module_dynamically(JSModuleDef *referrer,
                                    JSValueConst referrer_name,
                                    JSValueConst specifier,
                                    JSValueConst attributes,
                                    JSModuleImportPhaseEnum phase);

private:
  struct pending_provider_promise {
    JSValue value = JS_UNDEFINED;
    bool settlement_observed = false;
  };

  struct request_record;
  struct record;
  struct script_referrer;

  record *find(unofficial_napi_module module) const;
  record *find_by_module(JSModuleDef *module) const;
  record *find_by_wrapper(JSValueConst wrapper) const;
  void remove(record *entry);
  void free_record(record *entry);

  JSValue get_host_defined_option_symbol() const;
  JSValue get_symbols_binding_property(const char *name) const;
  JSValue get_or_create_host_defined_option(napi_value wrapper,
                                            napi_value candidate,
                                            const char *description) const;
  void set_host_defined_option(napi_value wrapper, JSValueConst value) const;
  JSValue create_frozen_null_proto_object() const;
  JSValue clone_attributes(JSValueConst value) const;
  napi_status throw_error(const char *code, const char *message);
  napi_status return_pending_exception(const char *message);
  napi_status wrap_owned(JSValue value, napi_value *result_out) const;
  JSValue call_callback(JSValueConst callback,
                        int argc,
                        JSValueConst *argv) const;
  napi_status cache_module_requests(record *entry);

  static int synthetic_init(JSContext *ctx, JSModuleDef *module);
  static int host_import_meta_init(JSContext *ctx,
                                   JSModuleDef *module,
                                   JSValueConst meta,
                                   void *opaque);
  static JSValue host_dynamic_import(JSContext *ctx,
                                     JSModuleDef *referrer,
                                     JSValueConst referrer_name,
                                     JSValueConst specifier,
                                     JSValueConst attributes,
                                     JSModuleImportPhaseEnum phase,
                                     void *opaque);

  // Owning environment and QuickJS context.
  napi_env env_;
  JSContext *ctx_;

  // Host module callbacks.
  JSValue import_module_dynamically_callback_;
  JSValue initialize_import_meta_callback_;

  // Module records and referrer metadata.
  std::vector<record *> records_;
  std::vector<script_referrer> script_referrers_;
  std::vector<pending_provider_promise> pending_dynamic_imports_;
  uint64_t facade_counter_ = 0;

  // Subsystem lifecycle.
  bool torn_down_ = false;
};

} // namespace quickjs::detail

#endif // NAPI_QUICKJS_MODULE_WRAP_H_
