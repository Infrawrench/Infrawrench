#include "internal/napi_scope.h"

#include "internal/napi_env.h"
#include "internal/napi_lifetime_tracker.h"

napi_scope__::napi_scope__(napi_env env, napi_handle_scope parent)
    : values_{this}, env_{env}, parent_{parent}
{
  napi_scope__ *parent_scope = this->parent();
  level_ = parent_scope == nullptr ? 0 : parent_scope->level() + 1;
}

napi_scope__::~napi_scope__()
{
  close();
}

bool napi_scope__::is_active() const
{
  return env_ != nullptr;
}

size_t napi_scope__::level() const
{
  return level_;
}

napi_value napi_scope__::wrap_value(JSValue value, bool owned)
{
  return wrap_value(env_ == nullptr ? nullptr : env_->context(), value, owned);
}

napi_value napi_scope__::wrap_value(JSContext *context, JSValue value, bool owned)
{
  if (closed_)
  {
    if (owned && env_ != nullptr && context != nullptr)
      JS_FreeValue(context, value);
    return nullptr;
  }

  napi_value wrapped = values_.allocate(env_, context, value, owned);
  if (wrapped == nullptr)
  {
    if (owned && env_ != nullptr && context != nullptr)
      JS_FreeValue(context, value);
    return nullptr;
  }

  return wrapped;
}

napi_value napi_scope__::escape_value(napi_value value)
{
  auto record_escape = [this](napi_value escaped)
  {
    quickjs::detail::napi_lifetime_tracker__::record_scope_escape(env_, escaped != nullptr);
    return escaped;
  };

  if (parent_ == nullptr || value == nullptr)
    return record_escape(nullptr);

  napi_scope__ *owner = ValuesAllocator::unsafe_owner(value);
  assert(owner == this);

  if (owner != this)
    return record_escape(nullptr);

  napi_scope__ *parent_scope = parent();
  return record_escape(parent_scope == nullptr ? nullptr : parent_scope->wrap_value(value->context(), value->get_inner(), false));
}

void napi_scope__::delete_value(napi_value value)
{
  if (value == nullptr)
    return;

  napi_scope__ *owner = ValuesAllocator::unsafe_owner(value);

  if (owner == this)
  {
    values_.destroy(value);
  }
}

void napi_scope__::close()
{
  if (closed_)
    return;

  values_.close();
  closed_ = true;
}

size_t napi_scope__::value_slot_count() const
{
  return values_.slot_count();
}

size_t napi_scope__::value_storage_slot_count() const
{
  return values_.storage_slot_count();
}

size_t napi_scope__::active_value_count() const
{
  return values_.count_active();
}

napi_handle_scope napi_scope__::parent_handle() const
{
  return parent_;
}

napi_scope__ *napi_scope__::parent() const
{
  return env_ == nullptr || parent_ == nullptr ? nullptr : env_->scope_from_handle(parent_);
}

napi_env napi_scope__::env() const
{
  return env_;
}

bool napi_scope__::has_escaped() const
{
  return escaped_;
}

void napi_scope__::mark_escaped()
{
  escaped_ = true;
}
