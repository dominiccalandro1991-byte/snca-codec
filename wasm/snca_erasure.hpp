#ifndef SNCA_ERASURE_HPP
#define SNCA_ERASURE_HPP

/**
 * SNCA Erasure Coding Engine
 * GF(2^8) Cauchy MDS — production SIMD kernel
 * Target: Emscripten / wasm32-unknown-emscripten + -msimd128
 * Memory model: all buffers supplied by caller (zero internal heap ownership)
 */

#include <cstdint>
#include <cstddef>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#include <wasm_simd128.h>
#else
#define EMSCRIPTEN_KEEPALIVE
/* Host fallback — no SIMD */
typedef struct { uint8_t _[16]; } v128_t;
#endif

#define SNCA_MAX_PAYLOAD   1048576u   /* 1 MiB */
#define SNCA_MAX_SHARDS    32u
#define SNCA_ALIGNMENT     16u

#ifdef __cplusplus
extern "C" {
#endif

/**
 * One-time GF table initialisation.
 * Thread-safe after first successful call (tables become immutable).
 * Returns 0 on success.
 */
EMSCRIPTEN_KEEPALIVE int32_t snca_init(void);

/**
 * Generate Cauchy matrix of shape m × k into caller-supplied buffer.
 * matrix_ptr must hold at least m * k bytes.
 * Returns 0 on success, negative error otherwise.
 */
EMSCRIPTEN_KEEPALIVE int32_t snca_generate_cauchy_matrix(
    uint8_t* matrix_ptr, uint32_t k, uint32_t m);

/**
 * Encode: produce m parity shards from k data shards.
 * in_ptr  — contiguous k * block_size bytes (data shards laid out sequentially)
 * out_ptr — contiguous m * block_size bytes (parity output)
 * matrix_ptr — m * k Cauchy coefficients
 * payload_len must be divisible by k.
 * Returns 0 on success.
 */
EMSCRIPTEN_KEEPALIVE int32_t snca_encode_direct(
    uint8_t* in_ptr,
    uint8_t* out_ptr,
    uint8_t* matrix_ptr,
    uint32_t payload_len,
    uint32_t k,
    uint32_t m);

/**
 * Decode / reconstruct.
 * shards_ptr — contiguous n * block_size bytes (n = k + m)
 * present    — n bytes, non-zero if shard is available
 * matrix_ptr — original m * k Cauchy matrix
 * Reconstructs missing shards in-place.
 * Returns 0 on success, -1 if > m shards missing (unrecoverable).
 */
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

#endif /* SNCA_ERASURE_HPP */
