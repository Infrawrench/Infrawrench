#include "internal/napi_env_cleanup_hook.h"

#include "internal/napi_env.h"

napi_env_cleanup_hook__::napi_env_cleanup_hook__(napi_env env, napi_cleanup_hook hook, void *arg)
    : env_{env},
      hook_{hook},
      arg_{arg}
{
}

napi_env_cleanup_hook__::~napi_env_cleanup_hook__()
{
  env_ = nullptr;
  hook_ = nullptr;
  arg_ = nullptr;
}

napi_env napi_env_cleanup_hook__::env() const
{
  return env_;
}

napi_env_cleanup_hook__ *napi_env_cleanup_hook__::create(napi_env env, napi_cleanup_hook hook, void *arg)
{
  if (env == nullptr || env->context() == nullptr || hook == nullptr)
    return nullptr;
  return env->create_cleanup_hook(hook, arg);
}

void napi_env_cleanup_hook__::destroy(napi_env_cleanup_hook__ *entry)
{
  if (entry == nullptr)
    return;

  napi_env env = entry->env_;
  if (env != nullptr)
    env->destroy_cleanup_hook(entry);
}

void napi_env_cleanup_hook__::run() const
{
  if (hook_ != nullptr)
    hook_(arg_);
}

bool napi_env_cleanup_hook__::matches(napi_cleanup_hook hook, void *arg) const
{
  return hook_ == hook && arg_ == arg;
}
