#ifndef NAPI_QUICKJS_TRACE_H_
#define NAPI_QUICKJS_TRACE_H_

#include <cstdlib>

#if !defined(NAPI_QUICKJS_ENABLE_TRACE_DIAGNOSTICS)
#if !defined(NDEBUG)
#define NAPI_QUICKJS_ENABLE_TRACE_DIAGNOSTICS 1
#else
#define NAPI_QUICKJS_ENABLE_TRACE_DIAGNOSTICS 0
#endif
#endif

#if NAPI_QUICKJS_ENABLE_TRACE_DIAGNOSTICS
#define NAPI_QUICKJS_TRACE_ENABLED(name) (std::getenv(name) != nullptr)
#else
#define NAPI_QUICKJS_TRACE_ENABLED(name) false
#endif

#endif  // NAPI_QUICKJS_TRACE_H_
