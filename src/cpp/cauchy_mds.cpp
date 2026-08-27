/**
 * Host/native compile entry for the SNCA Cauchy MDS ABI declared in
 * cauchy_mds.hpp. The Emscripten SIMD kernel remains wasm/snca_erasure.cpp
 * (same exported symbols: snca_init, snca_generate_cauchy_matrix,
 * snca_encode_direct, snca_decode_direct, malloc, free).
 *
 * Native build:
 *   g++ -std=c++17 -O3 -I src/cpp -I wasm -c wasm/snca_erasure.cpp -o snca_erasure.o
 */
#include "cauchy_mds.hpp"
