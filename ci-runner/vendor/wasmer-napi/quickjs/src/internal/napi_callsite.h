#ifndef NAPI_QUICKJS_CALLSITE_H_
#define NAPI_QUICKJS_CALLSITE_H_

#include "../../../include/js_native_api.h"

#include <cstdint>

namespace quickjs::detail
{

class napi_callsite__
{
public:
  static napi_status get_call_sites(napi_env env, uint32_t frames, napi_value *callsites_out);
  static napi_status get_current_stack_trace(napi_env env, uint32_t frames, napi_value *callsites_out);
  static napi_status get_caller_location(napi_env env, napi_value *location_out);
};

} // namespace quickjs::detail

#endif // NAPI_QUICKJS_CALLSITE_H_
