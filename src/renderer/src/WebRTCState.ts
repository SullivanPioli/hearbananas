import type { HostParticipant } from './BananasTypes'

export type HostPeerStateInput = {
  id: string
  name: string
  connectionState: RTCPeerConnectionState
  muted: boolean
}

export type HostPeerStateSummary = {
  connectedCount: number
  pendingCount: number
  participants: HostParticipant[]
}

export type HostControlMessage = {
  type: 'set-microphone-muted'
  muted: boolean
}

export const isParticipantMicrophoneEnabled = (
  enabledByParticipant: boolean,
  mutedByHost: boolean
): boolean => enabledByParticipant && !mutedByHost

export const parseHostControlMessage = (data: unknown): HostControlMessage | null => {
  if (typeof data !== 'string') return null
  try {
    const message = JSON.parse(data) as Partial<HostControlMessage>
    if (message.type !== 'set-microphone-muted' || typeof message.muted !== 'boolean') return null
    return { type: message.type, muted: message.muted }
  } catch {
    return null
  }
}

export const summarizeHostPeerState = (peers: HostPeerStateInput[]): HostPeerStateSummary => {
  const activePeers = peers.filter(
    (peer) => peer.connectionState !== 'closed' && peer.connectionState !== 'failed'
  )
  const connectedCount = activePeers.filter((peer) => peer.connectionState === 'connected').length

  return {
    connectedCount,
    pendingCount: activePeers.length - connectedCount,
    participants: activePeers
      .filter((peer) => peer.name !== '')
      .map((peer) => ({
        id: peer.id,
        name: peer.name,
        state:
          peer.connectionState === 'connected'
            ? 'connected'
            : peer.connectionState === 'disconnected'
              ? 'disconnected'
              : 'connecting',
        muted: peer.muted
      }))
  }
}
