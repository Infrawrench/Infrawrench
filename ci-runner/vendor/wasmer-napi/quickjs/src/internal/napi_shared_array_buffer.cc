#include "internal/napi_shared_array_buffer.h"

#include <cstdint>
#include <new>

namespace quickjs::detail
{
    static_assert(alignof(napi_shared_array_buffer__) <= alignof(uint64_t));

    constexpr size_t napi_shared_array_buffer__::header_size()
    {
        return (sizeof(napi_shared_array_buffer__) + alignof(uint64_t) - 1) & ~(alignof(uint64_t) - 1);
    }

    napi_shared_array_buffer__ *napi_shared_array_buffer__::from_data(void *ptr)
    {
        return reinterpret_cast<napi_shared_array_buffer__ *>(
            static_cast<uint8_t *>(ptr) - header_size());
    }

    void napi_shared_array_buffer__::install(JSRuntime *rt)
    {
        if (rt == nullptr)
            return;

        JSSharedArrayBufferFunctions funcs{};
        funcs.sab_alloc = &napi_shared_array_buffer__::alloc;
        funcs.sab_free = &napi_shared_array_buffer__::free;
        funcs.sab_dup = &napi_shared_array_buffer__::dup;
        JS_SetSharedArrayBufferFunctions(rt, &funcs);
    }

    void *napi_shared_array_buffer__::alloc(void * /*opaque*/, size_t size)
    {
        auto *storage = new (std::nothrow) uint8_t[header_size() + size];
        if (storage == nullptr)
            return nullptr;

        auto *header = new (storage) napi_shared_array_buffer__();
        header->ref_count.store(1, std::memory_order_relaxed);
        return storage + header_size();
    }

    void napi_shared_array_buffer__::free(void * /*opaque*/, void *ptr)
    {
        free_data(ptr);
    }

    void napi_shared_array_buffer__::dup(void * /*opaque*/, void *ptr)
    {
        dup_data(ptr);
    }

    void napi_shared_array_buffer__::free_data(void *ptr)
    {
        if (ptr == nullptr)
            return;

        auto *header = from_data(ptr);
        if (header->ref_count.fetch_sub(1, std::memory_order_acq_rel) == 1)
        {
            header->~napi_shared_array_buffer__();
            delete[] reinterpret_cast<uint8_t *>(header);
        }
    }

    void napi_shared_array_buffer__::dup_data(void *ptr)
    {
        if (ptr == nullptr)
            return;

        auto *header = from_data(ptr);
        header->ref_count.fetch_add(1, std::memory_order_relaxed);
    }
}
