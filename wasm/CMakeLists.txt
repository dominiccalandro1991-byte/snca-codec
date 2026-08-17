cmake_minimum_required(VERSION 3.16)
project(snca_codec_wasm LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Emscripten toolchain must be active (emcmake / emmake)
if(NOT EMSCRIPTEN)
    message(FATAL_ERROR "This project must be configured with emcmake")
endif()

add_executable(snca_codec snca_erasure.cpp)

target_include_directories(snca_codec PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})

# Production flags: SIMD, LTO, no exceptions, minimal runtime
target_compile_options(snca_codec PRIVATE
    -O3
    -flto
    -msimd128
    -fno-exceptions
    -fno-rtti
    -Wall
    -Wextra
)

set_target_properties(snca_codec PROPERTIES
    SUFFIX ".js"
    LINK_FLAGS "\
        -O3 -flto \
        -msimd128 \
        -s WASM=1 \
        -s MODULARIZE=1 \
        -s EXPORT_NAME=createSNCAModule \
        -s EXPORTED_FUNCTIONS=['_snca_init','_snca_generate_cauchy_matrix','_snca_encode_direct','_snca_decode_direct','_malloc','_free'] \
        -s EXPORTED_RUNTIME_METHODS=['ccall','cwrap','HEAPU8','UTF8ToString'] \
        -s ALLOW_MEMORY_GROWTH=1 \
        -s INITIAL_MEMORY=16777216 \
        -s MAXIMUM_MEMORY=268435456 \
        -s NO_EXIT_RUNTIME=1 \
        -s ENVIRONMENT=web,worker \
        -s FILESYSTEM=0 \
        -s ASSERTIONS=0 \
        --no-entry"
)
