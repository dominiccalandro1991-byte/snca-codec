#include "snca_erasure.hpp"
#include <cstring>

namespace {

/* GF(2^8) tables — AES-like irreducible 0x11D.
 * Written only during snca_init; thereafter treated as immutable.
 * Alignment guarantees SIMD-safe loads. */
alignas(SNCA_ALIGNMENT) uint8_t GF_EXP[512];
alignas(SNCA_ALIGNMENT) uint8_t GF_LOG[256];
alignas(SNCA_ALIGNMENT) uint8_t GF_INV[256];
volatile bool g_initialized = false;

void gf_tables_init() {
    uint32_t x = 1;
    for (uint32_t i = 0; i < 255; ++i) {
        GF_EXP[i]       = static_cast<uint8_t>(x);
        GF_EXP[i + 255] = static_cast<uint8_t>(x);
        GF_LOG[x]       = static_cast<uint8_t>(i);
        x <<= 1;
        if (x & 0x100) x ^= 0x11D;
    }
    GF_LOG[0] = 0;
    GF_INV[0] = 0;
    for (uint32_t i = 1; i < 256; ++i) {
        GF_INV[i] = GF_EXP[255 - GF_LOG[i]];
    }
    g_initialized = true;
}

inline uint8_t gf_mul(uint8_t a, uint8_t b) {
    if (a == 0 || b == 0) return 0;
    return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

inline uint8_t gf_div(uint8_t a, uint8_t b) {
    if (a == 0) return 0;
    if (b == 0) return 0; /* caller must never divide by zero */
    return GF_EXP[GF_LOG[a] + 255 - GF_LOG[b]];
}

#ifdef __EMSCRIPTEN__
/* SIMD GF multiply by constant coefficient using table-driven swizzle.
 * Processes 16 bytes per instruction. */
inline v128_t gf_mul_vec_coeff(v128_t data, uint8_t coeff) {
    if (coeff == 0) return wasm_u8x16_splat(0);
    if (coeff == 1) return data;

    uint8_t tbl_lo[16], tbl_hi[16];
    for (int n = 0; n < 16; ++n) {
        tbl_lo[n] = (n == 0) ? 0 : GF_EXP[GF_LOG[coeff] + GF_LOG[n]];
        tbl_hi[n] = (n == 0) ? 0 : GF_EXP[GF_LOG[coeff] + GF_LOG[n << 4]];
    }
    v128_t lo_tbl = wasm_v128_load(tbl_lo);
    v128_t hi_tbl = wasm_v128_load(tbl_hi);
    v128_t lo_idx = wasm_v128_and(data, wasm_u8x16_splat(0x0F));
    v128_t hi_idx = wasm_u8x16_shr(data, 4);
    v128_t lo_res = wasm_i8x16_swizzle(lo_tbl, lo_idx);
    v128_t hi_res = wasm_i8x16_swizzle(hi_tbl, hi_idx);
    return wasm_v128_xor(lo_res, hi_res);
}
#endif

/* Gaussian elimination over GF(2^8) for square matrix inversion.
 * In-place on mat (n×n), produces inverse in inv (n×n).
 * Returns false if singular. */
bool gf_invert(uint8_t* mat, uint8_t* inv, uint32_t n) {
    /* Build augmented [mat | I] */
    uint8_t aug[SNCA_MAX_SHARDS * SNCA_MAX_SHARDS * 2];
    for (uint32_t i = 0; i < n; ++i) {
        for (uint32_t j = 0; j < n; ++j) {
            aug[i * (2 * n) + j]       = mat[i * n + j];
            aug[i * (2 * n) + n + j]   = (i == j) ? 1 : 0;
        }
    }

    for (uint32_t col = 0; col < n; ++col) {
        /* Pivot */
        uint32_t piv = col;
        while (piv < n && aug[piv * (2 * n) + col] == 0) ++piv;
        if (piv == n) return false;
        if (piv != col) {
            for (uint32_t j = 0; j < 2 * n; ++j) {
                uint8_t tmp = aug[col * (2 * n) + j];
                aug[col * (2 * n) + j] = aug[piv * (2 * n) + j];
                aug[piv * (2 * n) + j] = tmp;
            }
        }
        uint8_t piv_val = aug[col * (2 * n) + col];
        uint8_t inv_piv = GF_INV[piv_val];
        for (uint32_t j = 0; j < 2 * n; ++j)
            aug[col * (2 * n) + j] = gf_mul(aug[col * (2 * n) + j], inv_piv);

        for (uint32_t row = 0; row < n; ++row) {
            if (row == col) continue;
            uint8_t factor = aug[row * (2 * n) + col];
            if (factor == 0) continue;
            for (uint32_t j = 0; j < 2 * n; ++j) {
                aug[row * (2 * n) + j] ^= gf_mul(factor, aug[col * (2 * n) + j]);
            }
        }
    }

    for (uint32_t i = 0; i < n; ++i)
        for (uint32_t j = 0; j < n; ++j)
            inv[i * n + j] = aug[i * (2 * n) + n + j];
    return true;
}

} // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE
int32_t snca_init(void) {
    if (!g_initialized) gf_tables_init();
    return 0;
}

EMSCRIPTEN_KEEPALIVE
int32_t snca_generate_cauchy_matrix(uint8_t* matrix_ptr, uint32_t k, uint32_t m) {
    if (!g_initialized) return -1;
    if (k == 0 || m == 0 || k + m > SNCA_MAX_SHARDS) return -2;
    if (!matrix_ptr) return -3;

    for (uint32_t i = 0; i < m; ++i) {
        uint8_t y = static_cast<uint8_t>(k + i);
        for (uint32_t j = 0; j < k; ++j) {
            uint8_t x = static_cast<uint8_t>(j);
            uint8_t denom = x ^ y;
            matrix_ptr[i * k + j] = GF_INV[denom];
        }
    }
    return 0;
}

EMSCRIPTEN_KEEPALIVE
int32_t snca_encode_direct(uint8_t* in_ptr, uint8_t* out_ptr, uint8_t* matrix_ptr,
                           uint32_t payload_len, uint32_t k, uint32_t m) {
    if (!g_initialized) return -1;
    if (!in_ptr || !out_ptr || !matrix_ptr) return -2;
    if (payload_len == 0 || payload_len > SNCA_MAX_PAYLOAD) return -3;
    if (k == 0 || m == 0 || k + m > SNCA_MAX_SHARDS) return -4;
    if (payload_len % k != 0) return -5;

    const uint32_t block_size   = payload_len / k;
    const uint32_t parity_bytes = m * block_size;
    std::memset(out_ptr, 0, parity_bytes);

    const uint32_t simd_chunks   = block_size / 16;
    const uint32_t scalar_tail   = block_size % 16;
    const uint32_t simd_boundary = block_size - scalar_tail;

    for (uint32_t shard = 0; shard < k; ++shard) {
        const uint8_t* data_block = in_ptr + shard * block_size;
        for (uint32_t p = 0; p < m; ++p) {
            uint8_t coeff = matrix_ptr[p * k + shard];
            uint8_t* parity_block = out_ptr + p * block_size;

            if (coeff == 0) continue;
            if (coeff == 1) {
                for (uint32_t b = 0; b < block_size; ++b)
                    parity_block[b] ^= data_block[b];
                continue;
            }

#ifdef __EMSCRIPTEN__
            for (uint32_t c = 0; c < simd_chunks; ++c) {
                v128_t data = wasm_v128_load(data_block + c * 16);
                v128_t res  = gf_mul_vec_coeff(data, coeff);
                v128_t acc  = wasm_v128_load(parity_block + c * 16);
                acc = wasm_v128_xor(acc, res);
                wasm_v128_store(parity_block + c * 16, acc);
            }
#else
            (void)simd_chunks;
#endif
            for (uint32_t b = 0; b < scalar_tail; ++b) {
                uint32_t idx = simd_boundary + b;
                parity_block[idx] ^= gf_mul(coeff, data_block[idx]);
            }
#ifdef __EMSCRIPTEN__
            /* scalar path also covers the full block when SIMD disabled */
#else
            for (uint32_t b = 0; b < block_size; ++b)
                parity_block[b] ^= gf_mul(coeff, data_block[b]);
#endif
        }
    }
    return 0;
}

EMSCRIPTEN_KEEPALIVE
int32_t snca_decode_direct(uint8_t* shards_ptr, const uint8_t* present,
                           uint8_t* matrix_ptr, uint32_t block_size,
                           uint32_t k, uint32_t m) {
    if (!g_initialized) return -1;
    if (!shards_ptr || !present || !matrix_ptr) return -2;
    if (k == 0 || m == 0 || k + m > SNCA_MAX_SHARDS) return -3;
    if (block_size == 0 || block_size > SNCA_MAX_PAYLOAD) return -4;

    const uint32_t n = k + m;
    uint32_t missing = 0;
    uint32_t present_idx[SNCA_MAX_SHARDS];
    uint32_t missing_idx[SNCA_MAX_SHARDS];
    uint32_t present_count = 0;

    for (uint32_t i = 0; i < n; ++i) {
        if (present[i]) {
            present_idx[present_count++] = i;
        } else {
            missing_idx[missing++] = i;
        }
    }
    if (missing > m) return -5; /* unrecoverable */
    if (missing == 0) return 0; /* nothing to do */
    if (present_count < k) return -5;

    /* Select first k present shards as the recovery basis */
    uint32_t basis[SNCA_MAX_SHARDS];
    for (uint32_t i = 0; i < k; ++i) basis[i] = present_idx[i];

    /* Build the decoding matrix (k × k).
     * For data shard i < k the row is unit vector e_i.
     * For parity shard i >= k the row is the corresponding Cauchy row. */
    uint8_t dec_mat[SNCA_MAX_SHARDS * SNCA_MAX_SHARDS];
    for (uint32_t r = 0; r < k; ++r) {
        uint32_t shard = basis[r];
        if (shard < k) {
            for (uint32_t c = 0; c < k; ++c)
                dec_mat[r * k + c] = (c == shard) ? 1 : 0;
        } else {
            uint32_t prow = shard - k;
            for (uint32_t c = 0; c < k; ++c)
                dec_mat[r * k + c] = matrix_ptr[prow * k + c];
        }
    }

    uint8_t inv_mat[SNCA_MAX_SHARDS * SNCA_MAX_SHARDS];
    if (!gf_invert(dec_mat, inv_mat, k)) return -6; /* singular — should not happen for Cauchy MDS */

    /* Reconstruct each missing shard */
    for (uint32_t mi = 0; mi < missing; ++mi) {
        uint32_t target = missing_idx[mi];
        uint8_t* out_block = shards_ptr + target * block_size;
        std::memset(out_block, 0, block_size);

        if (target < k) {
            /* Missing data shard: out = inv_mat[target_row] · present_data */
            for (uint32_t r = 0; r < k; ++r) {
                uint8_t coeff = inv_mat[target * k + r];
                if (coeff == 0) continue;
                const uint8_t* src = shards_ptr + basis[r] * block_size;
                if (coeff == 1) {
                    for (uint32_t b = 0; b < block_size; ++b) out_block[b] ^= src[b];
                } else {
                    for (uint32_t b = 0; b < block_size; ++b)
                        out_block[b] ^= gf_mul(coeff, src[b]);
                }
            }
        } else {
            /* Missing parity: recover data vector then re-encode.
             * Stack buffer hard-capped at 256 KiB to remain freestanding-safe. */
            constexpr uint32_t RECOVER_MAX = 256u * 1024u;
            if (k * block_size > RECOVER_MAX) return -7;
            uint8_t recovered[RECOVER_MAX];
            for (uint32_t d = 0; d < k; ++d) {
                uint8_t* dst = recovered + d * block_size;
                std::memset(dst, 0, block_size);
                for (uint32_t r = 0; r < k; ++r) {
                    uint8_t coeff = inv_mat[d * k + r];
                    if (coeff == 0) continue;
                    const uint8_t* src = shards_ptr + basis[r] * block_size;
                    for (uint32_t b = 0; b < block_size; ++b)
                        dst[b] ^= gf_mul(coeff, src[b]);
                }
            }
            /* Re-encode the missing parity */
            uint32_t prow = target - k;
            for (uint32_t d = 0; d < k; ++d) {
                uint8_t coeff = matrix_ptr[prow * k + d];
                if (coeff == 0) continue;
                const uint8_t* src = recovered + d * block_size;
                for (uint32_t b = 0; b < block_size; ++b)
                    out_block[b] ^= gf_mul(coeff, src[b]);
            }
        }
    }
    return 0;
}

} // extern "C"
