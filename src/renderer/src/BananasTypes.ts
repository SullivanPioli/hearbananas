export type BananasRemoteCursorData = {
  id: string
  name: string
  color: string
  x: number
  y: number
}

export type HostParticipant = {
  id: string
  name: string
  state: 'connecting' | 'connected' | 'disconnected'
  muted: boolean
}

type IceServer = {
  urls: string
  username?: string
  credential?: string
}

export type SettingsData = {
  username: string
  color: string
  isMicrophoneEnabledOnConnect: boolean
  iceServers: IceServer[]
}
