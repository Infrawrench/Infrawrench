#ifndef NAPI_QUICKJS_INTERNAL_NAPI_BYTECODE_H_
#define NAPI_QUICKJS_INTERNAL_NAPI_BYTECODE_H_

#include <quickjs.h>

#define XXH_INLINE_ALL
#include "internal/xxhash.h"

#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

namespace quickjs::detail
{
    // QuickJS serialized bytecode is fully self-validating, mirroring what
    // V8's CachedData provides natively: every payload this provider emits
    // starts with a 40-byte header that pins everything the engine cannot
    // re-derive from the raw JS_WriteObject bytes:
    //   [magic 'QJSB'][version u8][shape u8][reserved u16]
    //   [source_hash u64][params_hash u64][filename_hash u64][payload_hash u64]
    // - payload_hash guards corruption/truncation (JS_ReadObject is not
    //   hardened against bad input).
    // - source_hash / shape / params_hash reject bytes compiled from a
    //   different source, a different compile shape, or a different CJS
    //   parameter list (all of which V8's CachedData rejects natively). This
    //   is what lets edge.js hand untrusted vm cachedData straight to
    //   deserialize without its own source wrapper.
    // - filename_hash rejects payloads compiled under another name (QuickJS
    //   bytecode embeds the compile-time filename/URL — import.meta.url and
    //   stack traces would silently go stale). A stored hash of 0 means
    //   "unenforced": vm.SourceTextModule#createCachedData writes 0 because
    //   Node gives vm modules numbered default identifiers (vm:module(N))
    //   and V8 does not key its caches on the name either.
    inline constexpr char k_bytecode_payload_magic[4] = {'Q', 'J', 'S', 'B'};
    inline constexpr uint8_t k_bytecode_payload_version = 2;
    inline constexpr size_t k_bytecode_payload_header_size = 40;

    inline uint64_t napi_bytecode_hash64(const void *data, size_t size)
    {
        return XXH3_64bits(data, size);
    }

    // Length-prefixed XXH3 over the parameter list, so ['a','bc'] and ['ab','c']
    // hash differently. Empty list hashes to XXH3("").
    inline uint64_t napi_bytecode_params_hash(const std::vector<std::string> &params)
    {
        std::vector<uint8_t> buf;
        for (const std::string &p : params)
        {
            const uint32_t n = static_cast<uint32_t>(p.size());
            for (int i = 0; i < 4; ++i)
                buf.push_back(static_cast<uint8_t>(n >> (8 * i)));
            buf.insert(buf.end(), p.begin(), p.end());
        }
        return napi_bytecode_hash64(buf.data(), buf.size());
    }

    inline void napi_bytecode_put_u64(std::vector<uint8_t> *out, uint64_t value)
    {
        for (int i = 0; i < 8; ++i)
            out->push_back(static_cast<uint8_t>(value >> (8 * i)));
    }

    inline uint64_t napi_bytecode_get_u64(const uint8_t *p)
    {
        uint64_t value = 0;
        for (int i = 0; i < 8; ++i)
            value |= static_cast<uint64_t>(p[i]) << (8 * i);
        return value;
    }

    // Identity of a serialized payload; what the header pins and what
    // deserialize compares against (filename_hash 0 = unenforced on write).
    struct napi_bytecode_identity
    {
        int32_t shape = 0;
        uint64_t source_hash = 0;
        uint64_t params_hash = 0;
        uint64_t filename_hash = 0;
    };

    // Prepends the self-validating header to raw JS_WriteObject bytes and
    // returns the persisted buffer (the only producer of the QJSB format).
    inline std::vector<uint8_t> napi_bytecode_serialize_payload(const napi_bytecode_identity &id,
                                                                const uint8_t *payload,
                                                                size_t payload_len)
    {
        std::vector<uint8_t> out;
        out.reserve(k_bytecode_payload_header_size + payload_len);
        out.insert(out.end(), k_bytecode_payload_magic, k_bytecode_payload_magic + 4);
        out.push_back(k_bytecode_payload_version);
        out.push_back(static_cast<uint8_t>(id.shape));
        out.push_back(0);  // reserved
        out.push_back(0);  // reserved
        napi_bytecode_put_u64(&out, id.source_hash);
        napi_bytecode_put_u64(&out, id.params_hash);
        napi_bytecode_put_u64(&out, id.filename_hash);
        napi_bytecode_put_u64(&out, napi_bytecode_hash64(payload, payload_len));
        out.insert(out.end(), payload, payload + payload_len);
        return out;
    }

    // Returns the raw JS_WriteObject span past the header, or nullptr when the
    // header is absent/wrong-version, the shape/source/params do not match
    // `expect`, the stored filename hash is non-zero and differs, or the
    // payload hash mismatches (corruption). expect.filename_hash is the
    // consumer's filename hash (only compared when the stored hash is non-zero).
    inline const uint8_t *napi_bytecode_validate_payload(const uint8_t *bytes,
                                                         size_t byte_length,
                                                         const napi_bytecode_identity &expect,
                                                         size_t *payload_length_out)
    {
        *payload_length_out = 0;
        if (bytes == nullptr || byte_length <= k_bytecode_payload_header_size)
            return nullptr;
        if (std::memcmp(bytes, k_bytecode_payload_magic, 4) != 0)
            return nullptr;
        if (bytes[4] != k_bytecode_payload_version)
            return nullptr;
        if (bytes[5] != static_cast<uint8_t>(expect.shape))
            return nullptr;
        if (napi_bytecode_get_u64(bytes + 8) != expect.source_hash)
            return nullptr;
        if (napi_bytecode_get_u64(bytes + 16) != expect.params_hash)
            return nullptr;
        const uint64_t stored_filename = napi_bytecode_get_u64(bytes + 24);
        if (stored_filename != 0 && stored_filename != expect.filename_hash)
            return nullptr;
        const uint64_t stored_payload = napi_bytecode_get_u64(bytes + 32);
        const uint8_t *payload = bytes + k_bytecode_payload_header_size;
        const size_t payload_length = byte_length - k_bytecode_payload_header_size;
        if (stored_payload != napi_bytecode_hash64(payload, payload_length))
            return nullptr;
        *payload_length_out = payload_length;
        return payload;
    }

    // Backing store for an unofficial_napi bytecode handle (see
    // unofficial_napi_js_source). Created/owned via the
    // unofficial_napi_bytecode_* APIs implemented by napi_contextify__ and
    // consumed by JSSource-accepting APIs (contextify + module_wrap).
    struct napi_bytecode_record__
    {
        JSContext *ctx = nullptr;
        std::vector<uint8_t> bytes;
        std::string source_utf8;
        std::string filename_utf8;
        int32_t shape = 0;
        std::vector<std::string> params;
        // Live artifact per shape: script -> the compiled function-bytecode
        // value (dup before JS_EvalFunction, which consumes its argument);
        // cjs_function -> the compiled function; module -> the module value.
        JSValue artifact = JS_UNDEFINED;
    };

    inline napi_bytecode_record__ *napi_bytecode_record_from_source(
        const unofficial_napi_js_source *source)
    {
        return source != nullptr &&
                       source->kind == unofficial_napi_js_source_bytecode
                   ? reinterpret_cast<napi_bytecode_record__ *>(source->bytecode)
                   : nullptr;
    }
}

#endif  // NAPI_QUICKJS_INTERNAL_NAPI_BYTECODE_H_
