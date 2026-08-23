export const enum ConnectionType {
  HOST = 'host',
  PARTICIPANT = 'participant'
}

export type RTCSessionDescriptionOptions = RTCSessionDescriptionInit

export type BananasConnectionData = {
  type: ConnectionType
  data: { username: string }
  invitationId: string
  rtcSessionDescription: RTCSessionDescriptionInit
}

const COMPACT_CONNECTION_VERSION = 3
const SUPPORTED_COMPACT_CONNECTION_VERSIONS = new Set(['2', '3'])
const MAX_CONNECTION_TOKEN_CHARACTERS = 100_000
const MAX_DECOMPRESSED_SDP_CHARACTERS = 1_000_000

export const externalLinkClickHandler = (root: HTMLButtonElement, url: string): void => {
  root.classList.add('is-loading')
  setTimeout(() => {
    root.classList.remove('is-loading')
  }, 3000)
  window.open(url)
}

export const getUUIDv4 = (): string => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

const base64ToBytes = (data: string): Uint8Array => {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

const bytesToBase64Url = (bytes: Uint8Array): string => {
  return bytesToBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

const base64UrlToBytes = (data: string): Uint8Array => {
  const base64 = data.replaceAll('-', '+').replaceAll('_', '/')
  return base64ToBytes(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))
}

const compressText = async (data: string, format: 'gzip' | 'deflate-raw'): Promise<Uint8Array> => {
  const compressedStream = new Blob([data]).stream().pipeThrough(new CompressionStream(format))
  return new Uint8Array(await new Response(compressedStream).arrayBuffer())
}

const decompressText = async (
  data: Uint8Array,
  format: 'gzip' | 'deflate-raw'
): Promise<string> => {
  const decompressedStream = new Blob([data]).stream().pipeThrough(new DecompressionStream(format))
  return await new Response(decompressedStream).text()
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export const compressJson = async (data: any): Promise<string> => {
  return bytesToBase64(await compressText(JSON.stringify(data), 'gzip'))
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export const decompressJson = async (data: string): Promise<any> => {
  return JSON.parse(await decompressText(base64ToBytes(data), 'gzip'))
}

export const compressSessionDescription = async (sdp: string): Promise<string> => {
  const normalizedSdp = sdp.replaceAll('\r\n', '\n').replace(/\n$/, '')
  return bytesToBase64Url(await compressText(normalizedSdp, 'deflate-raw'))
}

export const decompressSessionDescription = async (data: string): Promise<string> => {
  if (data.length > MAX_CONNECTION_TOKEN_CHARACTERS) {
    throw new Error('The connection string is too large')
  }
  const normalizedSdp = await decompressText(base64UrlToBytes(data), 'deflate-raw')
  if (normalizedSdp.length > MAX_DECOMPRESSED_SDP_CHARACTERS) {
    throw new Error('The connection string expands beyond the supported size')
  }
  return `${normalizedSdp.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n')}\r\n`
}

const getConnectionTypeFromUrl = (url: URL): ConnectionType | null => {
  if (url.protocol !== 'bananas:') return null
  const identifier = (url.hostname || url.pathname).replace(/^\/+/, '').toLowerCase()
  if (identifier === 'h' || identifier === ConnectionType.HOST) return ConnectionType.HOST
  if (identifier === 'p' || identifier === ConnectionType.PARTICIPANT) {
    return ConnectionType.PARTICIPANT
  }
  return null
}

export const createInvitationId = (): string => {
  const bytes = new Uint8Array(9)
  crypto.getRandomValues(bytes)
  return bytesToBase64Url(bytes)
}

export const normalizeConnectionStringInput = (value: string): string => {
  const decodedHtml = value.replaceAll(/&amp;/gi, '&').trim()
  const match = decodedHtml.match(/bananas:[^\s<>"'`]+/i)
  if (!match) return decodedHtml

  // Discord commonly surrounds links with angle brackets or Markdown code markers. Extracting the
  // scheme also lets people paste a connection code from a sentence instead of carefully selecting
  // only the URL.
  return match[0].replace(/[),.\];!?]+$/, '')
}

const parseConnectionUrl = (value: string): { url: URL; type: ConnectionType } => {
  const url = new URL(normalizeConnectionStringInput(value))
  const type = getConnectionTypeFromUrl(url)
  if (!type) throw new Error('This is not a hearBananas connection string')
  return { url, type }
}

export const mayBeConnectionString = (ct: ConnectionType, str: string): boolean => {
  try {
    const { url, type } = parseConnectionUrl(str)
    if (type !== ct) return false
    const username = url.searchParams.get('u') ?? url.searchParams.get('username')
    const compactToken = url.searchParams.get('s')
    const legacyToken = url.searchParams.get('token')
    const token = compactToken ?? legacyToken
    if (!token || !username || token.length > MAX_CONNECTION_TOKEN_CHARACTERS) return false
    if (
      compactToken &&
      !SUPPORTED_COMPACT_CONNECTION_VERSIONS.has(url.searchParams.get('v') ?? '')
    ) {
      return false
    }
    return true
  } catch {
    return false
  }
}

export const getConnectionString = async (
  ct: ConnectionType,
  description: RTCSessionDescriptionInit,
  data: {
    username: string
    invitationId?: string
  }
): Promise<string> => {
  if (!description.sdp) throw new Error('The WebRTC session description is empty')
  const expectedType = ct === ConnectionType.HOST ? 'offer' : 'answer'
  if (description.type !== expectedType) {
    throw new Error(`Expected a WebRTC ${expectedType}, received ${description.type ?? 'nothing'}`)
  }

  const params = new URLSearchParams()
  params.set('v', COMPACT_CONNECTION_VERSION.toString())
  params.set('u', data.username)
  if (data.invitationId) params.set('i', data.invitationId)
  params.set('s', await compressSessionDescription(description.sdp))
  return `bananas://${ct}?${params.toString()}`
}

export const getDataFromBananasUrl = async (value: string): Promise<BananasConnectionData> => {
  const { url, type } = parseConnectionUrl(value)
  const username = url.searchParams.get('u') ?? url.searchParams.get('username')
  if (!username) throw new Error('The connection string does not identify its sender')

  const compactToken = url.searchParams.get('s')
  if (compactToken) {
    const version = url.searchParams.get('v') ?? ''
    if (!SUPPORTED_COMPACT_CONNECTION_VERSIONS.has(version)) {
      throw new Error('This connection string was made by an unsupported hearBananas version')
    }
    const expectedType = type === ConnectionType.HOST ? 'offer' : 'answer'
    return {
      type,
      data: { username },
      invitationId: url.searchParams.get('i') ?? '',
      rtcSessionDescription: {
        type: expectedType,
        sdp: await decompressSessionDescription(compactToken)
      }
    }
  }

  const legacyToken = url.searchParams.get('token')
  if (!legacyToken) throw new Error('The connection string does not contain a session')
  return {
    type,
    data: { username },
    invitationId: url.searchParams.get('i') ?? '',
    rtcSessionDescription: await decompressJson(legacyToken)
  }
}

export const getParticipantAudioSection = (
  sdp: string
): { mid: string; direction: 'sendrecv' | 'sendonly' } | null => {
  const mediaSections = sdp.replaceAll('\r\n', '\n').split(/\nm=/)
  for (let index = 1; index < mediaSections.length; index += 1) {
    const lines = `m=${mediaSections[index]}`.split('\n')
    if (!lines[0].startsWith('m=audio ')) continue

    const remoteDirection =
      lines.find((line) => /^a=(sendrecv|sendonly|recvonly|inactive)$/.test(line))?.slice(2) ??
      'sendrecv'
    if (remoteDirection !== 'sendrecv' && remoteDirection !== 'recvonly') continue

    const mid = lines.find((line) => line.startsWith('a=mid:'))?.slice('a=mid:'.length)
    if (!mid) continue
    return {
      mid,
      direction: remoteDirection === 'sendrecv' ? 'sendrecv' : 'sendonly'
    }
  }
  return null
}

export const makeVideoDraggable = (video: HTMLVideoElement): void => {
  let startX: number
  let startY: number
  let initialX: number
  let initialY: number
  let isDragging = false
  video.addEventListener('mousedown', (e) => {
    isDragging = true
    startX = e.clientX
    startY = e.clientY
    const transform = getComputedStyle(video).transform

    if (transform !== 'none') {
      const values = transform.split('(')[1].split(')')[0].split(',')
      initialX = parseFloat(values[4])
      initialY = parseFloat(values[5])
    } else {
      initialX = 0
      initialY = 0
    }
    video.style.cursor = 'grabbing'
  })
  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return

    const deltaX = e.clientX - startX
    const deltaY = e.clientY - startY

    const moveX = initialX + deltaX
    const moveY = initialY + deltaY

    video.style.transform = `translate(${moveX}px, ${moveY}px)`
  })

  document.addEventListener('mouseup', () => {
    if (!isDragging) return
    isDragging = false
    video.style.cursor = 'default'
  })
}

export const debounce = <T extends (...args: unknown[]) => void>(
  func: T,
  wait: number
): ((...args: Parameters<T>) => void) => {
  let timeout: ReturnType<typeof setTimeout>
  return (...args: Parameters<T>): void => {
    clearTimeout(timeout)
    timeout = setTimeout(() => {
      func(...args)
    }, wait)
  }
}

export const throttle = <T extends (...args: unknown[]) => void>(
  func: T,
  wait: number
): ((...args: Parameters<T>) => void) => {
  let lastCalled = 0
  return (...args: Parameters<T>): void => {
    const now = Date.now()
    if (now - lastCalled < wait) return
    lastCalled = now
    func(...args)
  }
}
