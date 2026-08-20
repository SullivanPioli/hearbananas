#include <windows.h>

#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <fcntl.h>
#include <io.h>
#include <mmdeviceapi.h>
#include <objidl.h>
#include <tlhelp32.h>
#include <wrl/client.h>

#include <algorithm>
#include <atomic>
#include <climits>
#include <cstdint>
#include <cwctype>
#include <iostream>
#include <new>
#include <optional>
#include <sstream>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace {

using Microsoft::WRL::ComPtr;

constexpr DWORD kActivationTimeoutMs = 10000;
constexpr WORD kChannels = 2;
constexpr DWORD kSampleRate = 48000;
constexpr WORD kBitsPerSample = 16;

std::atomic_bool g_keepRunning{true};

class ScopedHandle {
 public:
  explicit ScopedHandle(HANDLE handle = nullptr) : handle_(handle) {}
  ~ScopedHandle() {
    if (handle_ && handle_ != INVALID_HANDLE_VALUE) CloseHandle(handle_);
  }

  ScopedHandle(const ScopedHandle&) = delete;
  ScopedHandle& operator=(const ScopedHandle&) = delete;

  HANDLE get() const { return handle_; }
  bool valid() const { return handle_ && handle_ != INVALID_HANDLE_VALUE; }

 private:
  HANDLE handle_;
};

enum class CommunicationFamily { kDiscord, kVesktop };

struct ProcessInfo {
  DWORD pid;
  DWORD parentPid;
  std::wstring executable;
  CommunicationFamily family;
};

struct ExcludedProcess {
  DWORD pid;
  std::string displayName;
};

std::wstring Lowercase(std::wstring value) {
  std::transform(value.begin(), value.end(), value.begin(), [](wchar_t character) {
    return static_cast<wchar_t>(std::towlower(character));
  });
  return value;
}

std::optional<CommunicationFamily> GetCommunicationFamily(const std::wstring& executable) {
  const std::wstring normalized = Lowercase(executable);
  if (normalized == L"vesktop.exe") return CommunicationFamily::kVesktop;
  if (normalized == L"discord.exe" || normalized == L"discordcanary.exe" ||
      normalized == L"discordptb.exe" || normalized == L"discorddevelopment.exe") {
    return CommunicationFamily::kDiscord;
  }
  return std::nullopt;
}

std::string GetDisplayName(const ProcessInfo& process) {
  if (process.family == CommunicationFamily::kVesktop) return "Vesktop";
  const std::wstring normalized = Lowercase(process.executable);
  if (normalized == L"discordcanary.exe") return "Discord Canary";
  if (normalized == L"discordptb.exe") return "Discord PTB";
  if (normalized == L"discorddevelopment.exe") return "Discord Development";
  return "Discord";
}

std::optional<ExcludedProcess> FindCommunicationProcess(std::string& error) {
  ScopedHandle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
  if (!snapshot.valid()) {
    error = "Could not enumerate Windows processes.";
    return std::nullopt;
  }

  std::unordered_map<DWORD, ProcessInfo> communicationProcesses;
  PROCESSENTRY32W entry{};
  entry.dwSize = sizeof(entry);
  if (!Process32FirstW(snapshot.get(), &entry)) {
    error = "Windows returned an empty process list.";
    return std::nullopt;
  }

  do {
    const auto family = GetCommunicationFamily(entry.szExeFile);
    if (!family) continue;
    communicationProcesses.emplace(
        entry.th32ProcessID,
        ProcessInfo{entry.th32ProcessID, entry.th32ParentProcessID, entry.szExeFile, *family});
  } while (Process32NextW(snapshot.get(), &entry));

  if (communicationProcesses.empty()) {
    error = "No running Discord, Discord Canary/PTB, or Vesktop process was found.";
    return std::nullopt;
  }

  std::unordered_set<DWORD> roots;
  for (const auto& [pid, process] : communicationProcesses) {
    DWORD rootPid = pid;
    DWORD parentPid = process.parentPid;
    std::unordered_set<DWORD> visited{pid};
    while (parentPid != 0 && !visited.contains(parentPid)) {
      visited.insert(parentPid);
      const auto parent = communicationProcesses.find(parentPid);
      if (parent == communicationProcesses.end() || parent->second.family != process.family) break;
      rootPid = parentPid;
      parentPid = parent->second.parentPid;
    }
    roots.insert(rootPid);
  }

  if (roots.size() != 1) {
    error =
        "More than one independent Discord/Vesktop process tree is running. Close the one you "
        "are not using, then start the hearBananas session again.";
    return std::nullopt;
  }

  const DWORD rootPid = *roots.begin();
  const auto root = communicationProcesses.find(rootPid);
  if (root == communicationProcesses.end()) {
    error = "Could not resolve the Discord/Vesktop root process.";
    return std::nullopt;
  }
  return ExcludedProcess{rootPid, GetDisplayName(root->second)};
}

std::string DescribeHRESULT(HRESULT result) {
  LPWSTR rawMessage = nullptr;
  const DWORD size = FormatMessageW(
      FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM |
          FORMAT_MESSAGE_IGNORE_INSERTS,
      nullptr, static_cast<DWORD>(result), MAKELANGID(LANG_NEUTRAL, SUBLANG_DEFAULT),
      reinterpret_cast<LPWSTR>(&rawMessage), 0, nullptr);

  std::ostringstream message;
  message << "0x" << std::hex << static_cast<unsigned long>(result);
  if (size > 0 && rawMessage) {
    const int utf8Size = WideCharToMultiByte(CP_UTF8, 0, rawMessage, static_cast<int>(size), nullptr,
                                              0, nullptr, nullptr);
    if (utf8Size > 0) {
      std::string utf8Message(static_cast<size_t>(utf8Size), '\0');
      WideCharToMultiByte(CP_UTF8, 0, rawMessage, static_cast<int>(size), utf8Message.data(),
                          utf8Size, nullptr, nullptr);
      while (!utf8Message.empty() &&
             (utf8Message.back() == '\r' || utf8Message.back() == '\n' ||
              utf8Message.back() == '\0')) {
        utf8Message.pop_back();
      }
      message << ": " << utf8Message;
    }
    LocalFree(rawMessage);
  }
  return message.str();
}

class ActivationHandler final : public IActivateAudioInterfaceCompletionHandler,
                                public IAgileObject {
 public:
  ActivationHandler() : completedEvent_(CreateEventW(nullptr, FALSE, FALSE, nullptr)) {}

  HRESULT QueryInterface(REFIID interfaceId, void** object) override {
    if (!object) return E_POINTER;
    *object = nullptr;
    if (interfaceId == __uuidof(IUnknown) ||
        interfaceId == __uuidof(IActivateAudioInterfaceCompletionHandler)) {
      *object = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
    } else if (interfaceId == __uuidof(IAgileObject)) {
      *object = static_cast<IAgileObject*>(this);
    } else {
      return E_NOINTERFACE;
    }
    AddRef();
    return S_OK;
  }

  ULONG AddRef() override { return ++referenceCount_; }

  ULONG Release() override {
    const ULONG remaining = --referenceCount_;
    if (remaining == 0) delete this;
    return remaining;
  }

  HRESULT ActivateCompleted(IActivateAudioInterfaceAsyncOperation* operation) override {
    HRESULT activateResult = E_UNEXPECTED;
    ComPtr<IUnknown> activatedInterface;
    HRESULT result = operation->GetActivateResult(&activateResult, &activatedInterface);
    if (SUCCEEDED(result)) result = activateResult;
    if (SUCCEEDED(result)) result = activatedInterface.As(&audioClient_);
    activationResult_ = result;
    SetEvent(completedEvent_.get());
    return S_OK;
  }

  HRESULT WaitForAudioClient(IAudioClient** audioClient) {
    if (!completedEvent_.valid()) return HRESULT_FROM_WIN32(GetLastError());
    const DWORD waitResult = WaitForSingleObject(completedEvent_.get(), kActivationTimeoutMs);
    if (waitResult == WAIT_TIMEOUT) return HRESULT_FROM_WIN32(ERROR_TIMEOUT);
    if (waitResult != WAIT_OBJECT_0) return HRESULT_FROM_WIN32(GetLastError());
    if (FAILED(activationResult_)) return activationResult_;
    return audioClient_.CopyTo(audioClient);
  }

 private:
  ~ActivationHandler() = default;

  std::atomic<ULONG> referenceCount_{1};
  ScopedHandle completedEvent_;
  HRESULT activationResult_{E_PENDING};
  ComPtr<IAudioClient> audioClient_;
};

HRESULT ActivateProcessLoopback(DWORD processId, IAudioClient** audioClient) {
  AUDIOCLIENT_ACTIVATION_PARAMS activationParameters{};
  activationParameters.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  activationParameters.ProcessLoopbackParams.TargetProcessId = processId;
  activationParameters.ProcessLoopbackParams.ProcessLoopbackMode =
      PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;

  PROPVARIANT parameters{};
  parameters.vt = VT_BLOB;
  parameters.blob.cbSize = sizeof(activationParameters);
  parameters.blob.pBlobData = reinterpret_cast<BYTE*>(&activationParameters);

  auto* handler = new (std::nothrow) ActivationHandler();
  if (!handler) return E_OUTOFMEMORY;

  ComPtr<IActivateAudioInterfaceAsyncOperation> operation;
  HRESULT result = ActivateAudioInterfaceAsync(
      VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &parameters, handler,
      operation.GetAddressOf());
  if (SUCCEEDED(result)) result = handler->WaitForAudioClient(audioClient);
  handler->Release();
  return result;
}

bool WriteAll(HANDLE output, const void* data, size_t byteCount) {
  const auto* bytes = static_cast<const std::uint8_t*>(data);
  size_t offset = 0;
  while (offset < byteCount) {
    const DWORD remaining = static_cast<DWORD>(
        std::min<size_t>(byteCount - offset, static_cast<size_t>(MAXDWORD)));
    DWORD written = 0;
    if (!WriteFile(output, bytes + offset, remaining, &written, nullptr) || written == 0) {
      return false;
    }
    offset += written;
  }
  return true;
}

HRESULT CaptureFilteredAudio(const ExcludedProcess& excludedProcess) {
  ScopedHandle excludedProcessHandle(OpenProcess(SYNCHRONIZE, FALSE, excludedProcess.pid));
  if (!excludedProcessHandle.valid()) return HRESULT_FROM_WIN32(GetLastError());

  ComPtr<IAudioClient> audioClient;
  HRESULT result = ActivateProcessLoopback(excludedProcess.pid, &audioClient);
  if (FAILED(result)) return result;

  WAVEFORMATEX captureFormat{};
  captureFormat.wFormatTag = WAVE_FORMAT_PCM;
  captureFormat.nChannels = kChannels;
  captureFormat.nSamplesPerSec = kSampleRate;
  captureFormat.wBitsPerSample = kBitsPerSample;
  captureFormat.nBlockAlign =
      captureFormat.nChannels * captureFormat.wBitsPerSample / CHAR_BIT;
  captureFormat.nAvgBytesPerSec = captureFormat.nSamplesPerSec * captureFormat.nBlockAlign;

  const DWORD streamFlags = AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
                            AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
                            AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
  result = audioClient->Initialize(AUDCLNT_SHAREMODE_SHARED, streamFlags, 0, 0, &captureFormat,
                                   nullptr);
  if (FAILED(result)) return result;

  ScopedHandle sampleReadyEvent(CreateEventW(nullptr, FALSE, FALSE, nullptr));
  if (!sampleReadyEvent.valid()) return HRESULT_FROM_WIN32(GetLastError());
  result = audioClient->SetEventHandle(sampleReadyEvent.get());
  if (FAILED(result)) return result;

  ComPtr<IAudioCaptureClient> captureClient;
  result = audioClient->GetService(__uuidof(IAudioCaptureClient),
                                   reinterpret_cast<void**>(captureClient.GetAddressOf()));
  if (FAILED(result)) return result;

  const HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
  if (!output || output == INVALID_HANDLE_VALUE) return HRESULT_FROM_WIN32(ERROR_INVALID_HANDLE);

  result = audioClient->Start();
  if (FAILED(result)) return result;

  std::ostringstream metadata;
  metadata << "{\"sampleRate\":" << kSampleRate << ",\"channels\":" << kChannels
           << ",\"sampleFormat\":\"s16le\",\"excludedApplication\":\""
           << excludedProcess.displayName << "\",\"excludedPid\":" << excludedProcess.pid
           << "}\n";
  const std::string metadataText = metadata.str();
  if (!WriteAll(output, metadataText.data(), metadataText.size())) {
    audioClient->Stop();
    return HRESULT_FROM_WIN32(ERROR_BROKEN_PIPE);
  }

  std::vector<std::uint8_t> silence;
  while (g_keepRunning.load()) {
    const HANDLE waitHandles[] = {sampleReadyEvent.get(), excludedProcessHandle.get()};
    const DWORD waitResult = WaitForMultipleObjects(2, waitHandles, FALSE, 1000);
    if (waitResult == WAIT_TIMEOUT) continue;
    if (waitResult == WAIT_OBJECT_0 + 1) {
      result = HRESULT_FROM_WIN32(ERROR_PROCESS_ABORTED);
      break;
    }
    if (waitResult != WAIT_OBJECT_0) {
      result = HRESULT_FROM_WIN32(GetLastError());
      break;
    }

    UINT32 packetFrames = 0;
    result = captureClient->GetNextPacketSize(&packetFrames);
    while (SUCCEEDED(result) && packetFrames > 0) {
      BYTE* data = nullptr;
      DWORD flags = 0;
      UINT64 devicePosition = 0;
      UINT64 performancePosition = 0;
      UINT32 capturedFrames = 0;
      result = captureClient->GetBuffer(&data, &capturedFrames, &flags, &devicePosition,
                                        &performancePosition);
      if (FAILED(result)) break;

      const size_t capturedBytes =
          static_cast<size_t>(capturedFrames) * captureFormat.nBlockAlign;
      const void* outputData = data;
      if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0) {
        silence.assign(capturedBytes, 0);
        outputData = silence.data();
      }
      const bool wroteAudio = WriteAll(output, outputData, capturedBytes);
      const HRESULT releaseResult = captureClient->ReleaseBuffer(capturedFrames);
      if (!wroteAudio) {
        result = HRESULT_FROM_WIN32(ERROR_BROKEN_PIPE);
        break;
      }
      if (FAILED(releaseResult)) {
        result = releaseResult;
        break;
      }
      result = captureClient->GetNextPacketSize(&packetFrames);
    }
    if (FAILED(result)) break;
  }

  const HRESULT stopResult = audioClient->Stop();
  return FAILED(result) ? result : stopResult;
}

BOOL WINAPI ConsoleControlHandler(DWORD controlType) {
  if (controlType == CTRL_C_EVENT || controlType == CTRL_BREAK_EVENT ||
      controlType == CTRL_CLOSE_EVENT || controlType == CTRL_SHUTDOWN_EVENT) {
    g_keepRunning.store(false);
    return TRUE;
  }
  return FALSE;
}

}  // namespace

int wmain() {
  _setmode(_fileno(stdout), _O_BINARY);
  SetConsoleCtrlHandler(ConsoleControlHandler, TRUE);

  const HRESULT initializeResult = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(initializeResult)) {
    std::cerr << "Could not initialize COM: " << DescribeHRESULT(initializeResult) << '\n';
    return 2;
  }

  std::string processError;
  const auto excludedProcess = FindCommunicationProcess(processError);
  if (!excludedProcess) {
    std::cerr << processError << '\n';
    CoUninitialize();
    return 3;
  }

  const HRESULT captureResult = CaptureFilteredAudio(*excludedProcess);
  CoUninitialize();
  if (FAILED(captureResult) && captureResult != HRESULT_FROM_WIN32(ERROR_BROKEN_PIPE)) {
    std::cerr << "Windows process-loopback capture failed: " << DescribeHRESULT(captureResult)
              << '\n';
    return 4;
  }
  return 0;
}
