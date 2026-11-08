#include "internal/napi_external_backing_store_hint.h"

#include "internal/napi_env.h"

napi_external_backing_store_hint__::napi_external_backing_store_hint__(
    napi_env env,
    void *external_data,
    node_api_basic_finalize finalize_cb,
    void *finalize_hint)
    : env_{env},
      rt_{env == nullptr || env->context() == nullptr ? nullptr : JS_GetRuntime(env->context())},
      external_data_{external_data},
      finalize_cb_{finalize_cb},
      finalize_hint_{finalize_hint}
{
}

napi_external_backing_store_hint__::~napi_external_backing_store_hint__()
{
  env_ = nullptr;
  rt_ = nullptr;
  external_data_ = nullptr;
  finalize_cb_ = nullptr;
  finalize_hint_ = nullptr;
  finalize_invoked_ = false;
  detaching_ = false;
  weak_target_ = JS_UNDEFINED;
}

napi_external_backing_store_hint__ *napi_external_backing_store_hint__::create(
    napi_env env,
    void *external_data,
    node_api_basic_finalize finalize_cb,
    void *finalize_hint)
{
  if (env == nullptr || env->context() == nullptr)
    return nullptr;
  return env->create_external_backing_store(external_data, finalize_cb, finalize_hint);
}

void napi_external_backing_store_hint__::destroy(napi_external_backing_store_hint__ *hint)
{
  if (hint == nullptr)
    return;

  destroy_with_runtime(hint->rt_, hint);
}

void napi_external_backing_store_hint__::destroy_with_runtime(
    JSRuntime *rt,
    napi_external_backing_store_hint__ *hint)
{
  if (hint == nullptr)
    return;

  (void)rt;
  napi_env env = hint->env_;
  if (env != nullptr)
    env->destroy_external_backing_store(hint);
}

void napi_external_backing_store_hint__::invoke_finalizer()
{
  if (finalize_invoked_)
    return;
  finalize_invoked_ = true;
  if (finalize_cb_ != nullptr)
    finalize_cb_(env_, external_data_, finalize_hint_);
}

void napi_external_backing_store_hint__::begin_detach()
{
  detaching_ = true;
}

void napi_external_backing_store_hint__::end_detach()
{
  detaching_ = false;
}

bool napi_external_backing_store_hint__::is_detaching() const
{
  return detaching_;
}

napi_env napi_external_backing_store_hint__::env() const
{
  return env_;
}

JSRuntime *napi_external_backing_store_hint__::runtime() const
{
  return rt_;
}

void *napi_external_backing_store_hint__::external_data() const
{
  return external_data_;
}

JSValue napi_external_backing_store_hint__::weak_target() const
{
  return weak_target_;
}

JSValue napi_external_backing_store_hint__::finalizer_target(JSValue fallback) const
{
  return JS_IsUndefined(weak_target_) ? fallback : weak_target_;
}

void napi_external_backing_store_hint__::set_weak_target(JSValue weak_target)
{
  weak_target_ = weak_target;
}
