#ifndef NAPI_QUICKJS_INTERNAL_NAPI_SHARED_ARRAY_BUFFER_H_
#define NAPI_QUICKJS_INTERNAL_NAPI_SHARED_ARRAY_BUFFER_H_

#include <quickjs.h>

#include <atomic>
#include <cstddef>

namespace quickjs::detail
{
    struct napi_shared_array_buffer__ final
    {
        std::atomic<int> ref_count;

        static void install(JSRuntime *rt);
        static void *alloc(void *opaque, size_t size);
        static void free(void *opaque, void *ptr);
        static void dup(void *opaque, void *ptr);
        static void free_data(void *ptr);
        static void dup_data(void *ptr);

    private:
        static constexpr size_t header_size();
        static napi_shared_array_buffer__ *from_data(void *ptr);
    };
}

#endif // NAPI_QUICKJS_INTERNAL_NAPI_SHARED_ARRAY_BUFFER_H_
