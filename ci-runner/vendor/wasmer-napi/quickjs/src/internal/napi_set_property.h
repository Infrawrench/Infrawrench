#ifndef NAPI_QUICKJS_INTERNAL_NAPI_SET_PROPERTY_H_
#define NAPI_QUICKJS_INTERNAL_NAPI_SET_PROPERTY_H_

#include <quickjs.h>

namespace quickjs::detail
{
    int set_property_with_node_compat(JSContext *ctx,
                                      JSValueConst object,
                                      JSAtom property,
                                      JSValueConst value);
}

#endif // NAPI_QUICKJS_INTERNAL_NAPI_SET_PROPERTY_H_
