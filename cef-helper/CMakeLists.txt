cmake_minimum_required(VERSION 3.19)
project(cef_screenshot_helper)

set(CEF_ROOT "" CACHE PATH "CEF binary distribution 根目录")

if(NOT CEF_ROOT OR NOT EXISTS "${CEF_ROOT}/include/cef_app.h")
  message(FATAL_ERROR "CEF_ROOT 必须指向有效的 CEF binary distribution，当前值: ${CEF_ROOT}")
endif()

# ---------- CEF wrapper library (static) ----------
file(GLOB_RECURSE CEF_WRAPPER_SRCS
  "${CEF_ROOT}/libcef_dll/*.cc"
  "${CEF_ROOT}/libcef_dll/*.cpp"
)

add_library(libcef_dll_wrapper STATIC ${CEF_WRAPPER_SRCS})
target_include_directories(libcef_dll_wrapper PUBLIC "${CEF_ROOT}")

# C++20 required by CEF 146+
target_compile_features(libcef_dll_wrapper PUBLIC cxx_std_20)

target_compile_definitions(libcef_dll_wrapper PUBLIC WRAPPING_CEF_SHARED)

if(MSVC)
  target_compile_definitions(libcef_dll_wrapper PUBLIC NOMINMAX WIN32_LEAN_AND_MEAN _UNICODE UNICODE)
  target_compile_options(libcef_dll_wrapper PRIVATE /W0 /wd4100 /wd4127 /wd4244 /wd4267 /wd4996 /std:c++20 /Zc:__cplusplus)
else()
  target_compile_options(libcef_dll_wrapper PRIVATE -w)
endif()

# ---------- Helper executable ----------
add_executable(${PROJECT_NAME} main.cpp)

target_include_directories(${PROJECT_NAME} PRIVATE "${CEF_ROOT}")
target_compile_features(${PROJECT_NAME} PRIVATE cxx_std_20)

# ── 平台相关编译定义 ──
if(WIN32)
  target_compile_definitions(${PROJECT_NAME} PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN _UNICODE UNICODE)
endif()

# ── 平台相关链接 ──
if(WIN32)
  # Windows: 静态链接 CEF import lib + GDI+（PNG 编码）+ shlwapi（路径函数）
  target_link_libraries(${PROJECT_NAME}
    libcef_dll_wrapper
    "${CEF_ROOT}/Release/libcef.lib"
    gdiplus
    shlwapi
  )
elseif(UNIX AND NOT APPLE)
  # Linux: 链接 CEF 共享库 + libpng（PNG 编码）+ pthread/dl/atomic
  find_package(PNG REQUIRED)
  target_link_libraries(${PROJECT_NAME}
    libcef_dll_wrapper
    "${CEF_ROOT}/Release/libcef.so"
    PNG::PNG
    pthread
    dl
    atomic
  )
  # RPATH 使运行时能在同目录下找到 libcef.so
  set_target_properties(${PROJECT_NAME} PROPERTIES
    BUILD_RPATH  "$ORIGIN"
    INSTALL_RPATH "$ORIGIN"
  )
elseif(APPLE)
  # macOS: 链接 CEF framework + libpng + 系统 framework
  find_package(PNG REQUIRED)
  target_link_libraries(${PROJECT_NAME}
    libcef_dll_wrapper
    PNG::PNG
    "-framework CoreFoundation"
    "-framework AppKit"
  )
  # 链接 CEF .framework（位于 Release/ 下）
  target_link_options(${PROJECT_NAME} PRIVATE
    "-F${CEF_ROOT}/Release"
    "-framework Chromium Embedded Framework"
  )
  # RPATH 指向同级 Frameworks 目录
  set_target_properties(${PROJECT_NAME} PROPERTIES
    BUILD_RPATH  "@executable_path"
    INSTALL_RPATH "@executable_path"
  )
endif()

# Output 到 Release/ 子目录
set_target_properties(${PROJECT_NAME} PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_CURRENT_BINARY_DIR}/Release"
  RUNTIME_OUTPUT_DIRECTORY_DEBUG   "${CMAKE_CURRENT_BINARY_DIR}/Debug"
  RUNTIME_OUTPUT_DIRECTORY         "${CMAKE_CURRENT_BINARY_DIR}/Release"
)

if(MSVC)
  # 静态链接 C 运行时，减少部署依赖
  set_property(TARGET ${PROJECT_NAME}      PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
  set_property(TARGET libcef_dll_wrapper   PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
endif()
