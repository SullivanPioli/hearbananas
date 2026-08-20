import { ElectronAPI } from '@electron-toolkit/preload'

type IceServer = {
  urls: string
  username?: string
  credential?: string
}

declare global {
  interface Window {
    electron: ElectronAPI
    BananasApi: {
      getPlatform: () => NodeJS.Platform
      toggleRemoteCursors: (state: boolean) => Promise<void>
      remoteCursorPing: (cursorId: string) => Promise<void>
      updateRemoteCursor: (state: {
        id: string
        name: string
        color: string
        x: number
        y: number
      }) => Promise<void>
      updateSettings: (settings: {
        username: string
        color: string
        isMicrophoneEnabledOnConnect: boolean
        iceServers: IceServer[]
      }) => Promise<void>
      getSettings: () => Promise<{
        username: string
        color: string
        isMicrophoneEnabledOnConnect: boolean
        iceServers: IceServer[]
      }>
      getAppVersion: () => Promise<string>
      prepareLinuxSystemAudio: (options?: { excludeDiscordVesktop?: boolean }) => Promise<{
        name: string
        label: string
        excludesDiscordVesktop: boolean
      } | null>
      releaseLinuxSystemAudio: () => Promise<void>
      prepareWindowsSystemAudio: () => Promise<{
        sampleRate: number
        channels: number
        sampleFormat: 's16le'
        excludedApplication: string
        excludedPid: number
      } | null>
      releaseWindowsSystemAudio: () => Promise<void>
      onWindowsSystemAudioData: (callback: (data: Uint8Array) => void) => void
      onWindowsSystemAudioError: (callback: (message: string) => void) => void
      removeWindowsSystemAudioListeners: () => void
    }
  }
}
