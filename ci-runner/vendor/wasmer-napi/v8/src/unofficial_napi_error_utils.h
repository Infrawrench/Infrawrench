#ifndef NAPI_V8_UNOFFICIAL_NAPI_ERROR_UTILS_H_
#define NAPI_V8_UNOFFICIAL_NAPI_ERROR_UTILS_H_

#include <string>

#include "internal/napi_v8_env.h"
#include "unofficial_napi.h"

namespace unofficial_napi_internal {

std::string BuildSyntaxArrowMessage(v8::Isolate* isolate,
                                    v8::Local<v8::Context> context,
                                    v8::Local<v8::Message> message);

void SetArrowMessageFromString(v8::Isolate* isolate,
                               v8::Local<v8::Context> context,
                               v8::Local<v8::Value> exception,
                               const std::string& arrow);

void SetArrowMessage(v8::Isolate* isolate,
                     v8::Local<v8::Context> context,
                     v8::Local<v8::Value> exception,
                     v8::Local<v8::Message> message);

void AttachSyntaxArrowMessage(v8::Isolate* isolate,
                              v8::Local<v8::Context> context,
                              v8::Local<v8::Value> exception,
                              v8::Local<v8::Message> message);
// iwci patch (#1150): text Node prints straight to its own standard error
// (an unsettled top-level await's warning, an exception the promise-reject
// callback threw). Under the bridge that is the program's descriptor 2, not
// the embedder's: the text goes to the embedder's
// `napi_host_write_guest_stderr`, and nowhere without one.
void WriteProgramStderr(napi_env env, const std::string& text);

std::string GetErrorSourceLineForStderrImpl(napi_env env,
                                            v8::Local<v8::Message> message);
std::string GetThrownAtString(v8::Isolate* isolate,
                              v8::Local<v8::Message> message);
void PreserveErrorFormatting(napi_env env,
                             v8::Local<v8::Value> exception,
                             const std::string& source_line,
                             const std::string& thrown_at);

napi_status ConfigureSourceMaps(napi_env env, bool enabled, napi_value callback);
napi_status PreserveErrorSourceMessage(napi_env env, napi_value error);
napi_status GetErrorMetadata(napi_env env,
                             napi_value error,
                             unofficial_napi_error_metadata_mode mode,
                             unofficial_napi_error_metadata* out);
void ResetErrorFormattingState(napi_env env);

}  // namespace unofficial_napi_internal

#endif  // NAPI_V8_UNOFFICIAL_NAPI_ERROR_UTILS_H_
