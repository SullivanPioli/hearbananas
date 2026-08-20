cmake_minimum_required(VERSION 3.20)

project(hearbananas_windows_system_audio LANGUAGES CXX)

add_executable(hearbananas-system-audio main.cpp)

target_compile_features(hearbananas-system-audio PRIVATE cxx_std_20)
target_compile_definitions(
  hearbananas-system-audio
  PRIVATE
    NOMINMAX
    UNICODE
    _UNICODE
    WIN32_LEAN_AND_MEAN
    _WIN32_WINNT=0x0A00
)
target_link_libraries(hearbananas-system-audio PRIVATE mmdevapi ole32 uuid)

if(MSVC)
  target_compile_options(hearbananas-system-audio PRIVATE /W4 /permissive- /EHsc)
  set_property(
    TARGET hearbananas-system-audio
    PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>"
  )
endif()
