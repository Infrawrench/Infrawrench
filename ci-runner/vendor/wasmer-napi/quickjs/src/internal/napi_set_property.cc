#include "internal/napi_set_property.h"

namespace quickjs::detail
{
    void clear_pending_exception(JSContext *ctx)
    {
        if (!JS_HasException(ctx))
            return;

        JSValue exception = JS_GetException(ctx);
        JS_FreeValue(ctx, exception);
    }

    void free_property_descriptor(JSContext *ctx, JSPropertyDescriptor *descriptor)
    {
        JS_FreeValue(ctx, descriptor->getter);
        JS_FreeValue(ctx, descriptor->setter);
        JS_FreeValue(ctx, descriptor->value);
    }

    bool object_has_own_property(JSContext *ctx, JSValueConst object, JSAtom property)
    {
        int has_own = JS_GetOwnProperty(ctx, nullptr, object, property);
        if (has_own < 0)
        {
            clear_pending_exception(ctx);
            return true;
        }
        return has_own != 0;
    }

    bool descriptor_blocks_assignment_without_setter(const JSPropertyDescriptor &descriptor)
    {
        if ((descriptor.flags & JS_PROP_GETSET) != 0)
            return JS_IsUndefined(descriptor.setter);

        return (descriptor.flags & JS_PROP_WRITABLE) == 0;
    }

    // Brief: should_define_own_property_after_set_failure belongs to the property assignment compatibility layer.
    // It recognizes inherited descriptor shapes Node expects to shadow with an own property.
    // Inputs stay as QuickJS handles owned by the caller.
    // Descriptor/prototype lookup failures are cleared and reported as a conservative false.
    // Keep changes narrow so this compatibility bridge remains easy to remove.
    bool should_define_own_property_after_set_failure(JSContext *ctx,
                                                      JSValueConst object,
                                                      JSAtom property)
    {
        if (object_has_own_property(ctx, object, property))
            return false;

        JSValue prototype = JS_GetPrototype(ctx, object);
        while (!JS_IsNull(prototype))
        {
            if (JS_IsException(prototype))
            {
                clear_pending_exception(ctx);
                return false;
            }

            JSPropertyDescriptor descriptor;
            int has_property = JS_GetOwnProperty(ctx, &descriptor, prototype, property);
            if (has_property < 0)
            {
                JS_FreeValue(ctx, prototype);
                clear_pending_exception(ctx);
                return false;
            }

            if (has_property != 0)
            {
                bool should_shadow = descriptor_blocks_assignment_without_setter(descriptor);
                free_property_descriptor(ctx, &descriptor);
                JS_FreeValue(ctx, prototype);
                return should_shadow;
            }

            JSValue next_prototype = JS_GetPrototype(ctx, prototype);
            JS_FreeValue(ctx, prototype);
            prototype = next_prototype;
        }

        JS_FreeValue(ctx, prototype);
        return false;
    }

    // Brief: set_property_with_node_compat belongs to the property assignment compatibility layer.
    // It first uses QuickJS normal property assignment semantics.
    // When QuickJS rejects inherited readonly properties, it falls back to a Node-like own property.
    // Inputs stay as QuickJS handles owned by the caller and values are duplicated before storing.
    // Keep changes narrow so this compatibility bridge remains easy to remove.
    int set_property_with_node_compat(JSContext *ctx,
                                      JSValueConst object,
                                      JSAtom property,
                                      JSValueConst value)
    {
        int rc = JS_SetProperty(ctx, object, property, JS_DupValue(ctx, value));
        if (rc >= 0 || !JS_HasException(ctx))
            return rc;

        JSValue exception = JS_GetException(ctx);
        if (should_define_own_property_after_set_failure(ctx, object, property))
        {
            JS_FreeValue(ctx, exception);
            return JS_DefinePropertyValue(ctx,
                                          object,
                                          property,
                                          JS_DupValue(ctx, value),
                                          JS_PROP_C_W_E);
        }

        JS_Throw(ctx, exception);
        return -1;
    }
}
