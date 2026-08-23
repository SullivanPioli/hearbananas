<script lang="ts">
  import type { RTCSessionDescriptionOptions } from './Utils'
  import type { BananasRemoteCursorData, HostParticipant, SettingsData } from './BananasTypes'
  import {
    createInvitationId,
    getConnectionString,
    getParticipantAudioSection,
    ConnectionType
  } from './Utils'
  import { getRTCPeerConnectionConfig } from './Config'
  import {
    isParticipantMicrophoneEnabled,
    parseHostControlMessage,
    summarizeHostPeerState
  } from './WebRTCState'
  import type { HostControlMessage } from './WebRTCState'
  import windowsSystemAudioProcessorUrl from './windowsSystemAudioProcessor.js?worker&url'

  export let connectionState: string = 'disconnected'
  export let connectedParticipantCount = 0
  export let pendingParticipantCount = 0
  export let hostParticipants: HostParticipant[] = []
  export let hasRemoteAudio = false
  export let remoteAudioActive = false
  export let remoteAudioPlaybackBlocked = false
  export let systemAudioCaptureError = ''
  export let microphoneMutedByHost = false

  type SetupOptions = {
    shareSystemAudio?: boolean
    remoteAudioElement?: HTMLAudioElement | null
    muteParticipantMicrophonesOnConnect?: boolean
  }

  type HostPeer = {
    invitationId: string
    participantName: string
    pc: RTCPeerConnection
    systemAudioSender: RTCRtpSender
    remoteAudioTracks: Set<MediaStreamTrack>
    controlChannel: RTCDataChannel
    mutedByHost: boolean
  }

  const ICE_GATHERING_TIMEOUT_MS = 20000
  const MAX_HOST_PARTICIPANTS = 8

  const errorHander = (error: unknown): void => {
    console.error(error)
  }

  let remoteVideo: HTMLVideoElement | null = null
  let participantPc: RTCPeerConnection | null = null
  const hostPeers = new Map<string, HostPeer>()
  let shuttingDown = false
  let muteParticipantMicrophonesOnConnect = false
  let participantMicrophoneEnabledByUser = false
  let remoteCursorPositionsEnabled = false
  let remoteMouseCursorPositionsChannel: RTCDataChannel | null = null
  let remoteCursorPingChannel: RTCDataChannel | null = null
  let audioStream: MediaStream | null = null
  let systemAudioStream: MediaStream | null = null
  let remoteAudioStream: MediaStream | null = null
  let stream: MediaStream | null = null
  let audioElement: HTMLAudioElement | null = null
  let userSettings: SettingsData | null = null
  let windowsSystemAudioContext: AudioContext | null = null
  let windowsSystemAudioNode: AudioWorkletNode | null = null
  let windowsSystemAudioDestination: MediaStreamAudioDestinationNode | null = null

  const remoteMouseCursorPositionsChannelIsReady = (): boolean => {
    return remoteMouseCursorPositionsChannel?.readyState === 'open'
  }

  const remoteCursorPingChannelIsReady = (): boolean => {
    return remoteCursorPingChannel?.readyState === 'open'
  }

  const applyParticipantMicrophoneState = (): void => {
    for (const track of audioStream?.getAudioTracks() ?? []) {
      track.enabled = isParticipantMicrophoneEnabled(
        participantMicrophoneEnabledByUser,
        microphoneMutedByHost
      )
    }
  }

  const setupDataChannel = (dataChannel: RTCDataChannel, participantSide: boolean): void => {
    if (dataChannel.label === 'remoteMouseCursorPositions') {
      if (participantSide) remoteMouseCursorPositionsChannel = dataChannel
      dataChannel.onmessage = (event: MessageEvent): void => {
        if (!remoteCursorPositionsEnabled || participantSide) return
        const data = JSON.parse(event.data)
        window.BananasApi.updateRemoteCursor(data)
      }
    }
    if (dataChannel.label === 'remoteCursorPing') {
      if (participantSide) remoteCursorPingChannel = dataChannel
      dataChannel.onmessage = (event: MessageEvent): void => {
        if (!remoteCursorPositionsEnabled || participantSide) return
        window.BananasApi.remoteCursorPing(event.data)
      }
    }
    if (dataChannel.label === 'hostControl' && participantSide) {
      dataChannel.onmessage = (event: MessageEvent): void => {
        const message = parseHostControlMessage(event.data)
        if (!message) return
        microphoneMutedByHost = message.muted
        applyParticipantMicrophoneState()
      }
    }
  }

  export function PingRemoteCursor(cursorId: string): void {
    if (!remoteCursorPingChannelIsReady()) return
    remoteCursorPingChannel?.send(cursorId)
  }

  export function UpdateRemoteCursor(cursorData: BananasRemoteCursorData): void {
    if (!remoteMouseCursorPositionsChannelIsReady()) return
    remoteMouseCursorPositionsChannel?.send(JSON.stringify(cursorData))
  }

  export function HasAudioInput(): boolean {
    return audioStream !== null
  }

  export function GetAudioStream(): MediaStream | null {
    return audioStream
  }

  const getSystemAudioTracks = (): MediaStreamTrack[] => {
    return [...(stream?.getAudioTracks() ?? []), ...(systemAudioStream?.getAudioTracks() ?? [])]
  }

  const getLiveSystemAudioTrack = (): MediaStreamTrack | null => {
    return getSystemAudioTracks().find((track) => track.readyState === 'live') ?? null
  }

  export function HasSystemAudioInput(): boolean {
    return getLiveSystemAudioTrack() !== null
  }

  export function GetSystemAudioStream(): MediaStream | null {
    const tracks = getSystemAudioTracks()
    return tracks.length > 0 ? new MediaStream(tracks) : null
  }

  export async function GetSystemAudioInputDevices(): Promise<MediaDeviceInfo[]> {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const microphoneDeviceIds = new Set(
      (audioStream?.getAudioTracks() ?? [])
        .map((track) => track.getSettings().deviceId)
        .filter((deviceId): deviceId is string => Boolean(deviceId))
    )

    const audioInputDevices = devices.filter(
      (device) => device.kind === 'audioinput' && !microphoneDeviceIds.has(device.deviceId)
    )
    const likelySystemAudioDevices = audioInputDevices.filter((device) =>
      /hear.?bananas|monitor|loopback|stereo.?mix|what.?u.?hear|wave.?out|mixed.?output/i.test(
        device.label
      )
    )

    return likelySystemAudioDevices.length > 0 ? likelySystemAudioDevices : audioInputDevices
  }

  const replaceHostSystemAudioTrack = async (track: MediaStreamTrack | null): Promise<void> => {
    await Promise.all(
      [...hostPeers.values()].map(async (peer) => {
        await peer.systemAudioSender.replaceTrack(track).catch(errorHander)
      })
    )
  }

  export async function SetSystemAudioDevice(deviceId: string): Promise<boolean> {
    if (remoteVideo || !deviceId) return false

    await stopSystemAudioStream()
    try {
      systemAudioStream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: {
          deviceId: { exact: deviceId },
          autoGainControl: false,
          echoCancellation: false,
          noiseSuppression: false,
          channelCount: { ideal: 2 }
        }
      })
      const [track] = systemAudioStream.getAudioTracks()
      if (!track) {
        systemAudioStream = null
        return false
      }
      await replaceHostSystemAudioTrack(track)
      return track.readyState === 'live'
    } catch (error) {
      for (const track of systemAudioStream?.getTracks() ?? []) track.stop()
      systemAudioStream = null
      errorHander(error)
      return false
    }
  }

  export async function StartWindowsFilteredSystemAudio(): Promise<string> {
    if (remoteVideo) throw new Error('Filtered system audio can only be started by the host')

    await stopSystemAudioStream()
    systemAudioCaptureError = ''
    const pendingPcmBuffers: ArrayBuffer[] = []
    const sendPcmToWorklet = (buffer: ArrayBuffer): void => {
      if (windowsSystemAudioNode) {
        windowsSystemAudioNode.port.postMessage(buffer, [buffer])
        return
      }
      if (pendingPcmBuffers.length >= 64) pendingPcmBuffers.shift()
      pendingPcmBuffers.push(buffer)
    }

    window.BananasApi.onWindowsSystemAudioData((data) => {
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
      const copy = new Uint8Array(bytes.byteLength)
      copy.set(bytes)
      sendPcmToWorklet(copy.buffer)
    })
    window.BananasApi.onWindowsSystemAudioError((message) => {
      systemAudioCaptureError = message
      for (const track of systemAudioStream?.getAudioTracks() ?? []) track.enabled = false
    })

    try {
      const info = await window.BananasApi.prepareWindowsSystemAudio()
      if (!info) throw new Error('Windows filtered-audio capture is unavailable')

      windowsSystemAudioContext = new AudioContext({
        latencyHint: 'interactive',
        sampleRate: info.sampleRate
      })
      await windowsSystemAudioContext.audioWorklet.addModule(windowsSystemAudioProcessorUrl)
      windowsSystemAudioNode = new AudioWorkletNode(
        windowsSystemAudioContext,
        'hearbananas-windows-system-audio',
        {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [2]
        }
      )
      windowsSystemAudioDestination = windowsSystemAudioContext.createMediaStreamDestination()
      windowsSystemAudioNode.connect(windowsSystemAudioDestination)
      await windowsSystemAudioContext.resume()

      for (const buffer of pendingPcmBuffers.splice(0)) {
        windowsSystemAudioNode.port.postMessage(buffer, [buffer])
      }

      systemAudioStream = windowsSystemAudioDestination.stream
      const [track] = systemAudioStream.getAudioTracks()
      if (!track) throw new Error('Windows filtered-audio capture did not create an audio track')
      await replaceHostSystemAudioTrack(track)
      return info.excludedApplication
    } catch (error) {
      await stopSystemAudioStream()
      throw error
    }
  }

  export function ToggleRemoteCursors(enabled: boolean): boolean {
    remoteCursorPositionsEnabled = enabled
    return enabled
  }

  export async function EnableRemoteAudio(): Promise<boolean> {
    if (!audioElement || !hasRemoteAudio) return false
    audioElement.muted = false
    try {
      await audioElement.play()
      remoteAudioActive = true
      remoteAudioPlaybackBlocked = false
      return true
    } catch (error) {
      remoteAudioActive = false
      remoteAudioPlaybackBlocked = true
      console.warn('Remote audio playback could not start', error)
      return false
    }
  }

  export async function ToggleRemoteAudio(): Promise<boolean> {
    if (!audioElement || !hasRemoteAudio) return false
    if (remoteAudioActive && !audioElement.muted) {
      audioElement.muted = true
      remoteAudioActive = false
      return false
    }
    return await EnableRemoteAudio()
  }

  const waitForIceGatheringComplete = async (pc: RTCPeerConnection): Promise<void> => {
    if (pc.iceGatheringState !== 'complete') {
      await new Promise<void>((resolve) => {
        const cleanup = (): void => {
          pc.removeEventListener('icegatheringstatechange', onStateChange)
          clearTimeout(timeoutId)
        }
        const onStateChange = (): void => {
          if (pc.iceGatheringState !== 'complete') return
          cleanup()
          resolve()
        }
        const timeoutId = setTimeout(() => {
          cleanup()
          console.warn('ICE gathering timed out; continuing with current candidates')
          resolve()
        }, ICE_GATHERING_TIMEOUT_MS)
        pc.addEventListener('icegatheringstatechange', onStateChange)
        onStateChange()
      })
    }

    if (!pc.localDescription?.sdp.includes('a=candidate:')) {
      throw new Error(
        'No network route was added to the connection code. Check the STUN/TURN settings and retry.'
      )
    }
  }

  const configureCompactCodecs = (pc: RTCPeerConnection): void => {
    for (const transceiver of pc.getTransceivers()) {
      const kind = transceiver.receiver.track.kind
      const capabilities = RTCRtpReceiver.getCapabilities(kind)
      const codecs = capabilities?.codecs.filter((codec) => {
        const mimeType = codec.mimeType.toLowerCase()
        return kind === 'audio' ? mimeType === 'audio/opus' : mimeType === 'video/vp8'
      })
      if (codecs?.length) transceiver.setCodecPreferences(codecs)
    }
  }

  const refreshRemoteAudioState = (): void => {
    hasRemoteAudio =
      remoteAudioStream?.getAudioTracks().some((track) => track.readyState === 'live') === true
    if (!hasRemoteAudio) remoteAudioActive = false
  }

  const addRemoteAudioTrack = (track: MediaStreamTrack, peer?: HostPeer): void => {
    if (!remoteAudioStream) return
    if (peer) track.enabled = !peer.mutedByHost
    if (!remoteAudioStream.getTracks().some((candidate) => candidate.id === track.id)) {
      remoteAudioStream.addTrack(track)
    }
    peer?.remoteAudioTracks.add(track)
    track.addEventListener(
      'ended',
      () => {
        remoteAudioStream?.removeTrack(track)
        peer?.remoteAudioTracks.delete(track)
        refreshRemoteAudioState()
      },
      { once: true }
    )
    refreshRemoteAudioState()
    if (!peer?.mutedByHost) void EnableRemoteAudio()
  }

  const addRemoteVideoTrack = (track: MediaStreamTrack): void => {
    if (!remoteVideo) return
    const videoStream =
      remoteVideo.srcObject instanceof MediaStream ? remoteVideo.srcObject : new MediaStream()
    if (!videoStream.getTracks().some((candidate) => candidate.id === track.id)) {
      videoStream.addTrack(track)
    }
    remoteVideo.srcObject = videoStream
  }

  const updateHostPeerState = (): void => {
    const summary = summarizeHostPeerState(
      [...hostPeers.values()].map((peer) => ({
        id: peer.invitationId,
        name: peer.participantName,
        connectionState: peer.pc.connectionState,
        muted: peer.mutedByHost
      }))
    )
    connectedParticipantCount = summary.connectedCount
    pendingParticipantCount = summary.pendingCount
    hostParticipants = summary.participants
  }

  const sendParticipantMuteState = (peer: HostPeer): void => {
    if (peer.controlChannel.readyState !== 'open') return
    const message: HostControlMessage = {
      type: 'set-microphone-muted',
      muted: peer.mutedByHost
    }
    peer.controlChannel.send(JSON.stringify(message))
  }

  const closeHostPeer = (invitationId: string): void => {
    const peer = hostPeers.get(invitationId)
    if (!peer) return
    hostPeers.delete(invitationId)
    for (const track of peer.remoteAudioTracks) remoteAudioStream?.removeTrack(track)
    peer.remoteAudioTracks.clear()
    peer.pc.close()
    refreshRemoteAudioState()
    updateHostPeerState()
  }

  export function SetHostParticipantMuted(invitationId: string, muted: boolean): void {
    const peer = hostPeers.get(invitationId)
    if (!peer || !peer.participantName) return
    peer.mutedByHost = muted
    for (const track of peer.remoteAudioTracks) track.enabled = !muted
    sendParticipantMuteState(peer)
    updateHostPeerState()
    if (!muted) void EnableRemoteAudio()
  }

  export function KickHostParticipant(invitationId: string): void {
    closeHostPeer(invitationId)
  }

  const configureHostPeerEvents = (peer: HostPeer): void => {
    const { pc } = peer
    pc.ontrack = (event): void => {
      if (event.track.kind === 'audio') addRemoteAudioTrack(event.track, peer)
    }
    const onStateChange = (): void => {
      if (shuttingDown) return
      const state = pc.connectionState
      if (state === 'connected') connectionState = 'connected'
      if (state === 'failed') connectionState = 'failed'
      if (state === 'closed') connectionState = 'closed'
      updateHostPeerState()
      if (state === 'failed' || state === 'closed') {
        queueMicrotask(() => closeHostPeer(peer.invitationId))
      }
    }
    pc.onconnectionstatechange = onStateChange
    pc.oniceconnectionstatechange = (): void => {
      if (!shuttingDown && pc.iceConnectionState === 'failed') connectionState = 'failed'
    }
  }

  const createHostPeer = async (invitationId: string): Promise<HostPeer> => {
    const pc = new RTCPeerConnection(await getRTCPeerConnectionConfig())
    const systemAudioTrack = getLiveSystemAudioTrack()
    const microphoneTrack =
      audioStream?.getAudioTracks().find((track) => track.readyState === 'live') ?? null
    const systemAudioTransceiver = pc.addTransceiver(systemAudioTrack ?? 'audio', {
      direction: 'sendonly',
      ...(systemAudioTrack ? { streams: [new MediaStream([systemAudioTrack])] } : {})
    })
    pc.addTransceiver(microphoneTrack ?? 'audio', {
      direction: microphoneTrack ? 'sendrecv' : 'recvonly',
      ...(microphoneTrack ? { streams: [audioStream as MediaStream] } : {})
    })

    for (const track of stream?.getVideoTracks() ?? []) {
      pc.addTransceiver(track, {
        direction: 'sendonly',
        streams: [stream as MediaStream]
      })
    }

    const controlChannel = pc.createDataChannel('hostControl')
    const peer: HostPeer = {
      invitationId,
      participantName: '',
      pc,
      systemAudioSender: systemAudioTransceiver.sender,
      remoteAudioTracks: new Set(),
      controlChannel,
      mutedByHost: muteParticipantMicrophonesOnConnect
    }
    hostPeers.set(invitationId, peer)
    configureHostPeerEvents(peer)
    controlChannel.onopen = (): void => sendParticipantMuteState(peer)

    const cursorPositionsChannel = pc.createDataChannel('remoteMouseCursorPositions')
    const cursorPingChannel = pc.createDataChannel('remoteCursorPing')
    setupDataChannel(cursorPositionsChannel, false)
    setupDataChannel(cursorPingChannel, false)
    configureCompactCodecs(pc)
    updateHostPeerState()
    return peer
  }

  const createParticipantPeer = async (): Promise<RTCPeerConnection> => {
    const pc = new RTCPeerConnection(await getRTCPeerConnectionConfig())
    pc.ondatachannel = (event: RTCDataChannelEvent): void => {
      setupDataChannel(event.channel, true)
    }
    pc.ontrack = (event): void => {
      if (event.track.kind === 'video') addRemoteVideoTrack(event.track)
      if (event.track.kind === 'audio') addRemoteAudioTrack(event.track)
    }
    pc.oniceconnectionstatechange = (): void => {
      if (!shuttingDown) connectionState = pc.iceConnectionState
    }
    participantPc = pc
    return pc
  }

  const addGuestAudioTracks = async (
    pc: RTCPeerConnection,
    remoteOfferSdp: string
  ): Promise<void> => {
    if (!audioStream || !userSettings) return
    const microphoneTrack = audioStream.getAudioTracks()[0]
    if (!microphoneTrack) return

    microphoneTrack.enabled = isParticipantMicrophoneEnabled(
      participantMicrophoneEnabledByUser,
      microphoneMutedByHost
    )
    const participantAudioSection = getParticipantAudioSection(remoteOfferSdp)
    const microphoneTransceiver = participantAudioSection
      ? pc
          .getTransceivers()
          .find(
            (transceiver) =>
              transceiver.mid === participantAudioSection.mid &&
              transceiver.receiver.track.kind === 'audio'
          )
      : undefined
    if (!microphoneTransceiver) {
      throw new Error('The host invitation does not include a participant-audio channel')
    }
    microphoneTransceiver.direction = participantAudioSection.direction
    await microphoneTransceiver.sender.replaceTrack(microphoneTrack)
  }

  const stopWindowsSystemAudioBridge = async (): Promise<void> => {
    window.BananasApi.removeWindowsSystemAudioListeners()
    windowsSystemAudioNode?.disconnect()
    windowsSystemAudioNode = null
    windowsSystemAudioDestination = null
    if (windowsSystemAudioContext) {
      await windowsSystemAudioContext.close().catch(errorHander)
      windowsSystemAudioContext = null
    }
    await window.BananasApi.releaseWindowsSystemAudio().catch(errorHander)
  }

  const stopSystemAudioStream = async (): Promise<void> => {
    await replaceHostSystemAudioTrack(null)
    if (systemAudioStream) {
      for (const track of systemAudioStream.getTracks()) track.stop()
      systemAudioStream = null
    }
    await stopWindowsSystemAudioBridge()
  }

  export async function Setup(
    video: HTMLVideoElement = null,
    options: SetupOptions = {}
  ): Promise<void> {
    userSettings = await window.BananasApi.getSettings()
    remoteVideo = video
    shuttingDown = false
    connectedParticipantCount = 0
    pendingParticipantCount = 0
    hostParticipants = []
    hasRemoteAudio = false
    remoteAudioActive = false
    remoteAudioPlaybackBlocked = false
    systemAudioCaptureError = ''
    microphoneMutedByHost = false
    muteParticipantMicrophonesOnConnect = options.muteParticipantMicrophonesOnConnect === true
    participantMicrophoneEnabledByUser = userSettings.isMicrophoneEnabledOnConnect
    audioElement = options.remoteAudioElement ?? document.createElement('audio')
    audioElement.autoplay = true
    audioElement.muted = false
    remoteAudioStream = new MediaStream()
    audioElement.srcObject = remoteAudioStream
    audioElement.onplaying = (): void => {
      remoteAudioActive = !audioElement?.muted
      remoteAudioPlaybackBlocked = false
    }
    audioElement.onpause = (): void => {
      remoteAudioActive = false
    }
    audioElement.onvolumechange = (): void => {
      remoteAudioActive = !audioElement?.muted && !audioElement?.paused
    }

    try {
      audioStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true })
      for (const track of audioStream.getAudioTracks()) {
        track.enabled = participantMicrophoneEnabledByUser
      }
    } catch (error) {
      errorHander(error)
    }

    if (remoteVideo) {
      await createParticipantPeer()
      return
    }

    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: options.shareSystemAudio === true
      })
    } catch (error) {
      errorHander(error)
    }
  }

  export async function AcceptHostOffer(description: RTCSessionDescriptionOptions): Promise<void> {
    const pc = participantPc
    if (!pc) throw new Error('The participant connection is not ready')
    if (pc.remoteDescription) throw new Error('This participant has already accepted an invitation')
    const remoteDescription = new RTCSessionDescription(description)
    if (remoteDescription.type !== 'offer') throw new Error('Expected a host invitation')
    await pc.setRemoteDescription(remoteDescription)
    await addGuestAudioTracks(pc, remoteDescription.sdp)
    await pc.setLocalDescription(await pc.createAnswer())
  }

  export async function CreateParticipantUrl(data: {
    username: string
    invitationId?: string
  }): Promise<string> {
    const pc = participantPc
    if (!pc?.localDescription || pc.localDescription.type !== 'answer') {
      throw new Error('The participant answer is not ready')
    }
    await waitForIceGatheringComplete(pc)
    return await getConnectionString(ConnectionType.PARTICIPANT, pc.localDescription, data)
  }

  export async function CreateHostUrl(data: { username: string }): Promise<string> {
    if (remoteVideo) throw new Error('A participant cannot create host invitations')
    if (hostPeers.size >= MAX_HOST_PARTICIPANTS) {
      throw new Error(`A host can keep up to ${MAX_HOST_PARTICIPANTS} invitations or participants`)
    }

    const invitationId = createInvitationId()
    const peer = await createHostPeer(invitationId)
    try {
      await peer.pc.setLocalDescription(await peer.pc.createOffer())
      await waitForIceGatheringComplete(peer.pc)
      if (!peer.pc.localDescription) throw new Error('The host invitation is not ready')
      return await getConnectionString(ConnectionType.HOST, peer.pc.localDescription, {
        ...data,
        invitationId
      })
    } catch (error) {
      closeHostPeer(invitationId)
      throw error
    }
  }

  export async function AcceptParticipantAnswer(
    description: RTCSessionDescriptionOptions,
    invitationId: string,
    participantName: string
  ): Promise<void> {
    const availablePeers = [...hostPeers.values()].filter((peer) => !peer.pc.remoteDescription)
    const peer = invitationId
      ? hostPeers.get(invitationId)
      : availablePeers.length === 1
        ? availablePeers[0]
        : undefined
    if (!peer) {
      throw new Error('This answer does not match a pending invitation from this host')
    }
    if (peer.pc.remoteDescription) throw new Error('This invitation has already been used')

    const remoteDescription = new RTCSessionDescription(description)
    if (remoteDescription.type !== 'answer') throw new Error('Expected a participant answer')
    await peer.pc.setRemoteDescription(remoteDescription)
    peer.participantName = participantName
    sendParticipantMuteState(peer)
    updateHostPeerState()
  }

  export function ToggleDisplayStream(): void {
    for (const track of stream?.getVideoTracks() ?? []) track.enabled = !track.enabled
  }

  export function ToggleMicrophone(): boolean {
    if (remoteVideo) {
      if (microphoneMutedByHost) return false
      participantMicrophoneEnabledByUser = !participantMicrophoneEnabledByUser
      applyParticipantMicrophoneState()
      return participantMicrophoneEnabledByUser
    }

    const enabled = !IsMicrophoneActive()
    for (const track of audioStream?.getAudioTracks() ?? []) track.enabled = enabled
    return enabled
  }

  export function ToggleSystemAudio(): void {
    const tracks = getSystemAudioTracks()
    const enabled = !tracks.some((track) => track.enabled)
    for (const track of tracks) track.enabled = enabled
  }

  export function IsSystemAudioActive(): boolean {
    return getSystemAudioTracks().some((track) => track.readyState === 'live' && track.enabled)
  }

  export function IsMicrophoneActive(): boolean {
    return audioStream?.getAudioTracks().some((track) => track.enabled) === true
  }

  export function IsConnected(): boolean {
    if (remoteVideo) return participantPc?.connectionState === 'connected'
    return connectedParticipantCount > 0
  }

  export async function Disconnect(): Promise<void> {
    try {
      shuttingDown = true
      await stopSystemAudioStream()
      participantPc?.close()
      participantPc = null
      for (const invitationId of [...hostPeers.keys()]) closeHostPeer(invitationId)

      for (const track of stream?.getTracks() ?? []) track.stop()
      stream = null
      for (const track of audioStream?.getTracks() ?? []) track.stop()
      audioStream = null

      if (remoteVideo) remoteVideo.srcObject = null
      if (audioElement) {
        audioElement.pause()
        audioElement.srcObject = null
        audioElement.onplaying = null
        audioElement.onpause = null
        audioElement.onvolumechange = null
        audioElement = null
      }
      remoteAudioStream = null
      remoteMouseCursorPositionsChannel = null
      remoteCursorPingChannel = null
      remoteCursorPositionsEnabled = false
      connectedParticipantCount = 0
      pendingParticipantCount = 0
      hostParticipants = []
      hasRemoteAudio = false
      remoteAudioActive = false
      remoteAudioPlaybackBlocked = false
      systemAudioCaptureError = ''
      microphoneMutedByHost = false
      muteParticipantMicrophonesOnConnect = false
      participantMicrophoneEnabledByUser = false
      connectionState = 'disconnected'
      userSettings = null
    } catch (error) {
      errorHander(error)
    } finally {
      shuttingDown = false
    }
  }
</script>
