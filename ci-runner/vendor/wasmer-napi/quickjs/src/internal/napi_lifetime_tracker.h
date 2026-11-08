#ifndef NAPI_QUICKJS_LIFETIME_TRACKER_H_
#define NAPI_QUICKJS_LIFETIME_TRACKER_H_

#include <concepts>
#include <cstddef>

template <typename T, typename Owner>
struct napi_allocator_lifetime__;

struct napi_deferred__;
struct napi_env__;
struct napi_env_cleanup_hook__;
struct napi_external_backing_store_hint__;
struct napi_ref__;
struct napi_scope__;
struct napi_value__;

namespace quickjs::detail
{

#ifdef NAPI_ENABLE_LIFETIME_TRACKER
template <class T>
struct napi_lifetime__;

template <typename T, typename Owner>
concept napi_lifetime_tracked__ = requires(Owner *owner, T *val) {
  { napi_lifetime__<T>::record_create(owner, val) } -> std::same_as<void>;
  { napi_lifetime__<T>::record_release(owner, val) } -> std::same_as<void>;
};

template <>
struct napi_lifetime__<napi_value__>
{
  static void record_create(napi_scope__ *owner, napi_value__ *val);
  static void record_release(napi_scope__ *owner, napi_value__ *val);
};

template <>
struct napi_lifetime__<napi_ref__>
{
  static void record_create(napi_env__ *owner, napi_ref__ *val);
  static void record_release(napi_env__ *owner, napi_ref__ *val);
};

template <>
struct napi_lifetime__<napi_env_cleanup_hook__>
{
  static void record_create(napi_env__ *owner, napi_env_cleanup_hook__ *val);
  static void record_release(napi_env__ *owner, napi_env_cleanup_hook__ *val);
};

template <>
struct napi_lifetime__<napi_deferred__>
{
  static void record_create(napi_env__ *owner, napi_deferred__ *val);
  static void record_release(napi_env__ *owner, napi_deferred__ *val);
};

template <>
struct napi_lifetime__<napi_external_backing_store_hint__>
{
  static void record_create(napi_env__ *owner, napi_external_backing_store_hint__ *val);
  static void record_release(napi_env__ *owner, napi_external_backing_store_hint__ *val);
};
#else
template <typename T, typename Owner>
concept napi_lifetime_tracked__ = true;

template <class T>
struct napi_lifetime__
{
  template <typename Owner>
  static void record_create(Owner *owner, T *val)
  {
    (void)owner;
    (void)val;
  }

  template <typename Owner>
  static void record_release(Owner *owner, T *val)
  {
    (void)owner;
    (void)val;
  }
};
#endif

class napi_lifetime_tracker__
{
public:
#ifdef NAPI_ENABLE_LIFETIME_TRACKER
  static void record_scope_escape(napi_env__ *env, bool succeeded);
#else
  static void record_scope_escape(napi_env__ *env, bool succeeded)
  {
    (void)env;
    (void)succeeded;
  }
#endif
  static void dump(napi_env__ *env, const char *reason);
};

} // namespace quickjs::detail

#ifdef NAPI_ENABLE_LIFETIME_TRACKER
template <>
struct napi_allocator_lifetime__<napi_value__, napi_scope__>
{
  static void record_create(napi_scope__ *owner, napi_value__ *val)
  {
    quickjs::detail::napi_lifetime__<napi_value__>::record_create(owner, val);
  }

  static void record_release(napi_scope__ *owner, napi_value__ *val)
  {
    quickjs::detail::napi_lifetime__<napi_value__>::record_release(owner, val);
  }
};

template <>
struct napi_allocator_lifetime__<napi_ref__, napi_env__>
{
  static void record_create(napi_env__ *owner, napi_ref__ *val)
  {
    quickjs::detail::napi_lifetime__<napi_ref__>::record_create(owner, val);
  }

  static void record_release(napi_env__ *owner, napi_ref__ *val)
  {
    quickjs::detail::napi_lifetime__<napi_ref__>::record_release(owner, val);
  }
};

template <>
struct napi_allocator_lifetime__<napi_env_cleanup_hook__, napi_env__>
{
  static void record_create(napi_env__ *owner, napi_env_cleanup_hook__ *val)
  {
    quickjs::detail::napi_lifetime__<napi_env_cleanup_hook__>::record_create(owner, val);
  }

  static void record_release(napi_env__ *owner, napi_env_cleanup_hook__ *val)
  {
    quickjs::detail::napi_lifetime__<napi_env_cleanup_hook__>::record_release(owner, val);
  }
};

template <>
struct napi_allocator_lifetime__<napi_deferred__, napi_env__>
{
  static void record_create(napi_env__ *owner, napi_deferred__ *val)
  {
    quickjs::detail::napi_lifetime__<napi_deferred__>::record_create(owner, val);
  }

  static void record_release(napi_env__ *owner, napi_deferred__ *val)
  {
    quickjs::detail::napi_lifetime__<napi_deferred__>::record_release(owner, val);
  }
};

template <>
struct napi_allocator_lifetime__<napi_external_backing_store_hint__, napi_env__>
{
  static void record_create(napi_env__ *owner, napi_external_backing_store_hint__ *val)
  {
    quickjs::detail::napi_lifetime__<napi_external_backing_store_hint__>::record_create(owner, val);
  }

  static void record_release(napi_env__ *owner, napi_external_backing_store_hint__ *val)
  {
    quickjs::detail::napi_lifetime__<napi_external_backing_store_hint__>::record_release(owner, val);
  }
};
#endif

extern "C" void napi_quickjs_lifetime_dump(napi_env__ *env, const char *reason);

#endif // NAPI_QUICKJS_LIFETIME_TRACKER_H_
