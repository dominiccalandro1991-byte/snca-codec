#ifndef SNCA_CAUCHY_MDS_HPP
#define SNCA_CAUCHY_MDS_HPP

/**
 * Canonical C++17 GF(2^8) Cauchy MDS engine.
 * Compiled to WASM via Emscripten (-O3 -msimd128) or natively for tests.
 * Memory: caller owns every buffer. No internal heap ownership.
 */

#include <cstdint>
#include <cstddef>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#include <wasm_simd128.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif

#define SNCA_MAX_PAYLOAD   8388608u  /* 8 MiB per encode call */
#define SNCA_MAX_SHARDS    32u
#define SNCA_ALIGNMENT     16u
#define SNCA_HEADER_SIZE   96u
#define SNCA_VERSION       1u

#ifdef __cplusplus
extern "C" {
#endif

EMSCRIPTEN_KEEPALIVE int32_t snca_init(void);

EMSCRIPTEN_KEEPALIVE int32_t snca_generate_cauchy_matrix(
    uint8_t* matrix_ptr, uint32_t k, uint32_t m);

EMSCRIPTEN_KEEPALIVE int32_t snca_encode_direct(
    uint8_t* in_ptr,
    uint8_t* out_ptr,
    uint8_t* matrix_ptr,
    uint32_t payload_len,
    uint32_t k,
    uint32_t m);

EMSCRIPTEN_KEEPALIVE int32_t snca_decode_direct(
    uint8_t* shards_ptr,
    const uint8_t* present,
    uint8_t* matrix_ptr,
    uint32_t block_size,
    uint32_t k,
    uint32_t m);

#ifdef __cplusplus
}
#endif

#endif /* SNCA_CAUCHY_MDS_HPP */
