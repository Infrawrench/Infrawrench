#ifndef NAPI_QUICKJS_INTERNAL_NAPI_SERDES_H_
#define NAPI_QUICKJS_INTERNAL_NAPI_SERDES_H_

#include "unofficial_napi.h"

namespace quickjs::detail
{
    class napi_serdes__ final
    {
    public:
        static napi_value serializer_new(napi_env env, napi_callback_info info);
        static napi_value serializer_write_header(napi_env env, napi_callback_info info);
        static napi_value serializer_write_value(napi_env env, napi_callback_info info);
        static napi_value serializer_release_buffer(napi_env env, napi_callback_info info);
        static napi_value serializer_transfer_array_buffer(napi_env env, napi_callback_info info);
        static napi_value serializer_write_uint32(napi_env env, napi_callback_info info);
        static napi_value serializer_write_uint64(napi_env env, napi_callback_info info);
        static napi_value serializer_write_double(napi_env env, napi_callback_info info);
        static napi_value serializer_write_raw_bytes(napi_env env, napi_callback_info info);
        static napi_value serializer_set_treat_array_buffer_views_as_host_objects(napi_env env,
                                                                                  napi_callback_info info);
        static napi_value deserializer_new(napi_env env, napi_callback_info info);
        static napi_value deserializer_read_header(napi_env env, napi_callback_info info);
        static napi_value deserializer_read_value(napi_env env, napi_callback_info info);
        static napi_value deserializer_get_wire_format_version(napi_env env, napi_callback_info info);
        static napi_value deserializer_transfer_array_buffer(napi_env env, napi_callback_info info);
        static napi_value deserializer_read_uint32(napi_env env, napi_callback_info info);
        static napi_value deserializer_read_uint64(napi_env env, napi_callback_info info);
        static napi_value deserializer_read_double(napi_env env, napi_callback_info info);
        static napi_value deserializer_read_raw_bytes(napi_env env, napi_callback_info info);
        static napi_status serialize_value(napi_env env, napi_value value, void **payload_out);
        static napi_status deserialize_value(napi_env env, void *payload, napi_value *result_out);
        static void release_serialized_value(void *payload);

    private:
        struct serializer;
        struct deserializer;
        struct serialized_value;

        static void serializer_finalize(napi_env env, void *data, void *hint);
        static void deserializer_finalize(napi_env env, void *data, void *hint);
        static serializer *get_serializer(napi_env env, napi_value this_arg);
        static deserializer *get_deserializer(napi_env env, napi_value this_arg);
    };
}

#endif // NAPI_QUICKJS_INTERNAL_NAPI_SERDES_H_
