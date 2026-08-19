<script lang="ts">
  import type { RTCSessionDescriptionOptions } from './Utils'
  import type { BananasRemoteCursorData, SettingsData } from './BananasTypes'
  import { getConnectionString, ConnectionType } from './Utils'
  import { getRTCPeerConnectionConfig } from './Config'

  export let connectionState: string = 'disconnected'
  export let hasRemoteAudio = false
  export let remoteAudioActive = false
  export let remoteAudioPlaybackBlocked = false

  type SetupOptions = {
    shareSystemAudio?: boolean
    remoteAudioElement?: HTMLAudioElement | null
  }

  const errorHander = (e: unknown): void => {
    console.error(e)
  }

  let remoteVideo: HTMLVideoElement | null = null
  let pc: RTCPeerConnection | null = null
  let remoteCursorPositionsEnabled = false
  let remoteMouseCursorPositionsChannel: RTCDataChannel | null = null
  let remoteCursorPingChannel: RTCDataChannel | null = null
  let audioStream: MediaStream | null = null
  let systemAudioStream: MediaStream | null = null
  let systemAudioSender: RTCRtpSender | null = null
  let remoteAudioStream: MediaStream | null = null
  let stream: MediaStream | null = null
  let audioElement: HTMLAudioElement | null = null
  let userSettings: SettingsData | null = null

  const remoteMouseCursorPositionsChannelIsReady = (): boolean => {
    if (!remoteMouseCursorPositionsChannel) return false
    if (remoteMouseCursorPositionsChannel.readyState === 'open') return true
    return false
  }

  const remoteCursorPingChannelIsReady = (): boolean => {
    if (!remoteCursorPingChannel) return false
    if (remoteCursorPingChannel.readyState === 'open') return true
    return false
  }

  const setupDataChannel = (dc: RTCDataChannel): void => {
    if (dc.label === 'remoteMouseCursorPositions') {
      remoteMouseCursorPositionsChannel = dc
      dc.onmessage = function (e: MessageEvent): void {
        if (!remoteCursorPositionsEnabled) return
        if (remoteVideo) return
        const data = JSON.parse(e.data)
        window.BananasApi.updateRemoteCursor(data)
      }
    }
    if (dc.label === 'remoteCursorPing') {
      remoteCursorPingChannel = dc
      dc.onmessage = function (e: MessageEvent): void {
        if (!remoteCursorPositionsEnabled) return
        if (remoteVideo) return
        window.BananasApi.remoteCursorPing(e.data)
      }
    }
  }
  export function PingRemoteCursor(cursorId: string): void {
    if (!remoteCursorPingChannelIsReady()) {
      console.error('remoteCursorPingChannel not ready')
      return
    }
    remoteCursorPingChannel.send(cursorId)
  }
  export function UpdateRemoteCursor(cursorData: BananasRemoteCursorData): void {
    if (!remoteMouseCursorPositionsChannelIsReady()) {
      console.error('remoteMouseCursorPositionsChannel not ready')
      return
    }
    remoteMouseCursorPositionsChannel.send(JSON.stringify(cursorData))
  }
  export function HasAudioInput(): boolean {
    return audioStream !== null
  }
  export function GetAudioStream(): MediaStream | null {
    return audioStream
  }
  export function HasSystemAudioInput(): boolean {
    return getSystemAudioTracks().some((track) => track.readyState === 'live')
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
  export async function SetSystemAudioDevice(deviceId: string): Promise<boolean> {
    if (!pc || !systemAudioSender || !deviceId) return false

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
      await systemAudioSender.replaceTrack(track)
      return track.readyState === 'live'
    } catch (e) {
      for (const track of systemAudioStream?.getTracks() ?? []) {
        track.stop()
      }
      systemAudioStream = null
      errorHander(e)
      return false
    }
  }
  export function ToggleRemoteCursors(enabled: boolean): boolean {
    if (!remoteMouseCursorPositionsChannel) return false
    if (remoteMouseCursorPositionsChannel.readyState !== 'open') return false
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

  const ICE_GATHERING_TIMEOUT_MS = 10000

  const waitForIceGatheringComplete = async (): Promise<void> => {
    if (!pc) return
    if (pc.iceGatheringState === 'complete') return
    await new Promise<void>((resolve) => {
      const cleanup = (): void => {
        pc?.removeEventListener('icegatheringstatechange', onStateChange)
        clearTimeout(timeoutId)
      }
      const onStateChange = (): void => {
        if (pc?.iceGatheringState === 'complete') {
          cleanup()
          resolve()
        }
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

  const addGuestAudioTracks = (): void => {
    if (!pc || !audioStream || !userSettings) return
    const senders = pc.getSenders()
    for (const track of audioStream.getTracks()) {
      track.enabled = userSettings.isMicrophoneEnabledOnConnect
      if (!senders.some((sender) => sender.track?.id === track.id)) {
        pc.addTrack(track, audioStream)
      }
    }
  }

  const getSystemAudioTracks = (): MediaStreamTrack[] => {
    return [...(stream?.getAudioTracks() ?? []), ...(systemAudioStream?.getAudioTracks() ?? [])]
  }

  const stopSystemAudioStream = async (): Promise<void> => {
    if (systemAudioSender?.track) {
      await systemAudioSender.replaceTrack(null).catch(errorHander)
    }
    if (systemAudioStream) {
      for (const track of systemAudioStream.getTracks()) {
        track.stop()
      }
      systemAudioStream = null
    }
  }

  export async function Setup(
    v: HTMLVideoElement = null,
    options: SetupOptions = {}
  ): Promise<void> {
    userSettings = await window.BananasApi.getSettings()
    remoteVideo = v
    hasRemoteAudio = false
    remoteAudioActive = false
    remoteAudioPlaybackBlocked = false
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
    if (pc) {
      pc.close()
      pc = null
    }
    pc = new RTCPeerConnection(await getRTCPeerConnectionConfig())
    systemAudioSender = remoteVideo
      ? null
      : pc.addTransceiver('audio', { direction: 'sendonly' }).sender
    pc.ondatachannel = (e: RTCDataChannelEvent): void => {
      if (e.channel.label === 'remoteMouseCursorPositions') {
        setupDataChannel(e.channel)
      }
      if (e.channel.label === 'remoteCursorPing') {
        setupDataChannel(e.channel)
      }
    }
    pc.ontrack = (evt): void => {
      if (evt.track.kind === 'video' && remoteVideo) {
        const videoStream =
          remoteVideo.srcObject instanceof MediaStream ? remoteVideo.srcObject : new MediaStream()
        if (!videoStream.getTracks().some((track) => track.id === evt.track.id)) {
          videoStream.addTrack(evt.track)
        }
        remoteVideo.srcObject = videoStream
      }
      if (evt.track.kind === 'audio' && remoteAudioStream) {
        hasRemoteAudio = true
        if (!remoteAudioStream.getTracks().some((track) => track.id === evt.track.id)) {
          remoteAudioStream.addTrack(evt.track)
        }
        void EnableRemoteAudio()
      }
    }
    pc.onicecandidate = function (e: RTCPeerConnectionIceEvent): void {
      const cand = e.candidate
      if (!cand) {
        console.log('icecandidate gathering: complete')
      } else {
        console.log('new icecandidate')
      }
    }
    pc.oniceconnectionstatechange = function (): void {
      connectionState = pc.iceConnectionState
    }
    try {
      audioStream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: true
      })
    } catch (e) {
      errorHander(e)
    }
    if (!remoteVideo) {
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: options.shareSystemAudio === true
        })
        for (const track of stream.getVideoTracks()) {
          pc.addTrack(track, stream)
        }
        const [displayAudioTrack] = stream.getAudioTracks()
        if (displayAudioTrack && systemAudioSender) {
          await systemAudioSender.replaceTrack(displayAudioTrack)
        }
        if (audioStream) {
          for (const track of audioStream.getTracks()) {
            track.enabled = userSettings.isMicrophoneEnabledOnConnect
            pc.addTrack(track, stream)
          }
        }
      } catch (e) {
        errorHander(e)
      }
    }
  }
  export async function CreateParticipantUrl(
    c: RTCSessionDescriptionOptions,
    data: { username: string }
  ): Promise<string> {
    if (pc?.localDescription?.type !== 'answer') {
      try {
        const desc = new RTCSessionDescription(c)
        await pc.setRemoteDescription(desc)
        if (remoteVideo) {
          addGuestAudioTracks()
        }
        if (desc.type === 'offer') {
          const answer = await pc.createAnswer()
          await pc.setLocalDescription(answer)
        }
      } catch (e) {
        errorHander(e)
      }
    }
    await waitForIceGatheringComplete()
    return await getConnectionString(ConnectionType.PARTICIPANT, pc.localDescription, data)
  }
  export async function CreateHostUrl(data: { username: string }): Promise<string> {
    if (pc?.localDescription?.type !== 'offer') {
      remoteMouseCursorPositionsChannel = pc.createDataChannel('remoteMouseCursorPositions')
      remoteCursorPingChannel = pc.createDataChannel('remoteCursorPing')
      setupDataChannel(remoteMouseCursorPositionsChannel)
      setupDataChannel(remoteCursorPingChannel)
      const desc = await pc.createOffer()
      await pc.setLocalDescription(desc)
    }
    await waitForIceGatheringComplete()
    return await getConnectionString(ConnectionType.HOST, pc.localDescription, data)
  }
  export function ToggleDisplayStream(): void {
    if (stream) {
      for (const track of stream.getVideoTracks()) {
        track.enabled = !track.enabled
      }
    }
  }
  export function ToggleMicrophone(): void {
    if (audioStream) {
      for (const track of audioStream.getAudioTracks()) {
        track.enabled = !track.enabled
      }
    }
  }
  export function ToggleSystemAudio(): void {
    const tracks = getSystemAudioTracks()
    const enabled = !tracks.some((track) => track.enabled)
    for (const track of tracks) {
      track.enabled = enabled
    }
  }
  export function IsSystemAudioActive(): boolean {
    return getSystemAudioTracks().some((track) => track.readyState === 'live' && track.enabled)
  }
  export function IsMicrophoneActive(): boolean {
    if (audioStream) {
      for (const track of audioStream.getAudioTracks()) {
        return track.enabled
      }
    }
    return false
  }
  export async function Connect(c: RTCSessionDescriptionOptions): Promise<void> {
    try {
      const desc = new RTCSessionDescription(c)
      await pc.setRemoteDescription(desc)
      if (remoteVideo) {
        addGuestAudioTracks()
      }
      if (desc.type === 'offer') {
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
      }
    } catch (e) {
      errorHander(e)
    }
  }
  export function IsConnected(): boolean {
    return pc ? pc.connectionState === 'connected' : false
  }
  export async function Disconnect(): Promise<void> {
    try {
      await stopSystemAudioStream()
      pc.close()
      pc = null
      if (stream) {
        for (const track of stream.getTracks()) {
          track.stop()
        }
        stream = null
      }
      if (audioStream) {
        for (const track of audioStream.getTracks()) {
          track.stop()
        }
        audioStream = null
      }
      if (audioElement) {
        audioElement.pause()
        audioElement.srcObject = null
        audioElement.onplaying = null
        audioElement.onpause = null
        audioElement.onvolumechange = null
        audioElement = null
      }
      remoteAudioStream = null
      systemAudioSender = null
      hasRemoteAudio = false
      remoteAudioActive = false
      remoteAudioPlaybackBlocked = false
    } catch (e) {
      errorHander(e)
    }
  }
</script>
