#ifndef NAPI_QUICKJS_ENV_CLEANUP_HOOK_H_
#define NAPI_QUICKJS_ENV_CLEANUP_HOOK_H_

#include "../../../include/js_native_api.h"
#include "../../../include/node_api_types.h"

typedef struct napi_env_cleanup_hook__ *napi_env_cleanup_hook;

struct napi_env_cleanup_hook__
{
  napi_env_cleanup_hook__(napi_env env, napi_cleanup_hook hook, void *arg);
  static napi_env_cleanup_hook__ *create(napi_env env, napi_cleanup_hook hook, void *arg);
  static void destroy(napi_env_cleanup_hook__ *entry);
  ~napi_env_cleanup_hook__();
  napi_env_cleanup_hook__(const napi_env_cleanup_hook__ &) = delete;
  napi_env_cleanup_hook__(napi_env_cleanup_hook__ &&other) = delete;
  napi_env_cleanup_hook__ &operator=(const napi_env_cleanup_hook__ &) = delete;
  napi_env_cleanup_hook__ &operator=(napi_env_cleanup_hook__ &&other) = delete;

  napi_env env() const;
  void run() const;
  bool matches(napi_cleanup_hook hook, void *arg) const;

private:
  // Owning environment and registered cleanup callback.
  napi_env env_ = nullptr;
  napi_cleanup_hook hook_ = nullptr;
  void *arg_ = nullptr;
};

#endif // NAPI_QUICKJS_ENV_CLEANUP_HOOK_H_
