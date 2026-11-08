#include "internal/napi_callback_info.h"

napi_callback_info__::napi_callback_info__(napi_env env,
                                           JSValueConst this_val,
                                           JSValue new_target,
                                           int argc,
                                           JSValueConst *argv,
                                           void *data)
    : env_{env},
      this_val_{this_val},
      new_target_{new_target},
      argc_{argc},
      argv_{argv},
      data_{data}
{
}

napi_callback_info__::~napi_callback_info__()
{
}

napi_env napi_callback_info__::env() const
{
  return env_;
}

JSValueConst napi_callback_info__::this_value() const
{
  return this_val_;
}

JSValue napi_callback_info__::new_target() const
{
  return new_target_;
}

size_t napi_callback_info__::argc() const
{
  return argc_ < 0 ? 0 : static_cast<size_t>(argc_);
}

JSValueConst napi_callback_info__::arg(size_t index) const
{
  return index < argc() ? argv_[index] : JS_UNDEFINED;
}

void *napi_callback_info__::data() const
{
  return data_;
}
