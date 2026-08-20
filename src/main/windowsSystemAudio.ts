import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { WebContents } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

const AUDIO_DATA_CHANNEL = 'windowsSystemAudioData'
const AUDIO_ERROR_CHANNEL = 'windowsSystemAudioError'
const MAX_METADATA_BYTES = 4096
const HELPER_START_TIMEOUT_MS = 15000

export type WindowsSystemAudioInfo = {
  sampleRate: number
  channels: number
  sampleFormat: 's16le'
  excludedApplication: string
  excludedPid: number
}

type ActiveCapture = {
  child: ChildProcessWithoutNullStreams
  sender: WebContents
  stopping: boolean
  pcmRemainder: Buffer
  onSenderDestroyed: () => void
}

let activeCapture: ActiveCapture | null = null

const getHelperPath = (): string => {
  const executableName = 'hearbananas-system-audio.exe'
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, executableName)]
    : [
        join(app.getAppPath(), 'resources', 'bin', 'win32-x64', executableName),
        join(app.getAppPath(), 'native', 'windows-system-audio', 'build', 'Release', executableName)
      ]
  const helperPath = candidates.find((candidate) => existsSync(candidate))
  if (!helperPath) {
    throw new Error(
      'The Windows filtered-audio helper is missing. Reinstall hearBananas or rebuild the Windows package.'
    )
  }
  return helperPath
}

const parseMetadata = (rawMetadata: Buffer): WindowsSystemAudioInfo => {
  const parsed: unknown = JSON.parse(rawMetadata.toString('utf8'))
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('The Windows audio helper returned invalid metadata')
  }
  const metadata = parsed as Record<string, unknown>
  if (
    typeof metadata.sampleRate !== 'number' ||
    metadata.sampleRate < 8000 ||
    metadata.sampleRate > 192000 ||
    metadata.channels !== 2 ||
    metadata.sampleFormat !== 's16le' ||
    typeof metadata.excludedApplication !== 'string' ||
    typeof metadata.excludedPid !== 'number'
  ) {
    throw new Error('The Windows audio helper returned unsupported stream metadata')
  }
  return metadata as WindowsSystemAudioInfo
}

const deliverPcm = (capture: ActiveCapture, chunk: Buffer, frameBytes: number): void => {
  if (capture.stopping || chunk.length === 0) return
  if (capture.sender.isDestroyed()) {
    if (activeCapture === capture) releaseWindowsSystemAudioSync()
    return
  }
  const pending =
    capture.pcmRemainder.length > 0 ? Buffer.concat([capture.pcmRemainder, chunk]) : chunk
  const alignedLength = pending.length - (pending.length % frameBytes)
  if (alignedLength === 0) {
    capture.pcmRemainder = Buffer.from(pending)
    return
  }

  const packet = Buffer.from(pending.subarray(0, alignedLength))
  capture.pcmRemainder = Buffer.from(pending.subarray(alignedLength))
  try {
    capture.sender.send(AUDIO_DATA_CHANNEL, packet)
  } catch {
    if (activeCapture === capture) releaseWindowsSystemAudioSync()
  }
}

export const prepareWindowsSystemAudio = async (
  sender: WebContents
): Promise<WindowsSystemAudioInfo | null> => {
  if (process.platform !== 'win32') return null

  releaseWindowsSystemAudioSync()
  const helperPath = getHelperPath()
  const child = spawn(helperPath, [], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  child.stdin.end()
  const capture: ActiveCapture = {
    child,
    sender,
    stopping: false,
    pcmRemainder: Buffer.alloc(0),
    onSenderDestroyed: () => {
      if (activeCapture === capture) releaseWindowsSystemAudioSync()
    }
  }
  activeCapture = capture
  sender.once('destroyed', capture.onSenderDestroyed)

  return await new Promise<WindowsSystemAudioInfo>((resolve, reject) => {
    let metadataBuffer = Buffer.alloc(0)
    let metadata: WindowsSystemAudioInfo | null = null
    let stderr = ''
    let settled = false

    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      capture.stopping = true
      child.kill()
      reject(new Error('Windows filtered-audio capture took too long to start'))
    }, HELPER_START_TIMEOUT_MS)

    const rejectBeforeStart = (message: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(new Error(message))
    }

    child.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-8192)
    })

    child.stdout.on('data', (chunk: Buffer) => {
      if (metadata) {
        deliverPcm(capture, chunk, metadata.channels * 2)
        return
      }

      metadataBuffer = Buffer.concat([metadataBuffer, chunk])
      if (metadataBuffer.length > MAX_METADATA_BYTES && !metadataBuffer.includes(0x0a)) {
        capture.stopping = true
        child.kill()
        rejectBeforeStart('The Windows audio helper did not return valid startup metadata')
        return
      }

      const newlineIndex = metadataBuffer.indexOf(0x0a)
      if (newlineIndex < 0) return
      try {
        metadata = parseMetadata(metadataBuffer.subarray(0, newlineIndex))
      } catch (error) {
        capture.stopping = true
        child.kill()
        rejectBeforeStart(error instanceof Error ? error.message : String(error))
        return
      }

      clearTimeout(timeout)
      settled = true
      resolve(metadata)
      deliverPcm(capture, metadataBuffer.subarray(newlineIndex + 1), metadata.channels * 2)
      metadataBuffer = Buffer.alloc(0)
    })

    child.once('error', (error) => {
      if (activeCapture === capture) activeCapture = null
      sender.removeListener('destroyed', capture.onSenderDestroyed)
      rejectBeforeStart(`Could not launch Windows filtered-audio capture: ${error.message}`)
    })

    child.once('close', (code) => {
      if (activeCapture === capture) activeCapture = null
      sender.removeListener('destroyed', capture.onSenderDestroyed)
      const detail = stderr.trim()
      if (!metadata) {
        rejectBeforeStart(
          detail ||
            `Windows filtered-audio capture exited before starting (code ${code ?? 'unknown'})`
        )
        return
      }
      if (!capture.stopping && !sender.isDestroyed()) {
        try {
          sender.send(
            AUDIO_ERROR_CHANNEL,
            detail ||
              `Windows filtered-audio capture stopped unexpectedly (code ${code ?? 'unknown'})`
          )
        } catch {
          // The renderer can disappear between isDestroyed() and send().
        }
      }
    })
  })
}

export const releaseWindowsSystemAudio = async (): Promise<void> => {
  releaseWindowsSystemAudioSync()
}

export const releaseWindowsSystemAudioSync = (): void => {
  const capture = activeCapture
  activeCapture = null
  if (!capture) return

  capture.stopping = true
  capture.sender.removeListener('destroyed', capture.onSenderDestroyed)
  capture.pcmRemainder = Buffer.alloc(0)
  if (capture.child.exitCode === null && !capture.child.killed) capture.child.kill()
}
