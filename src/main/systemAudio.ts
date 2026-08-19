import { execFile, execFileSync } from 'node:child_process'

const SYSTEM_AUDIO_SOURCE_NAME = 'hearbananas_system_audio'
const SYSTEM_AUDIO_SOURCE_DESCRIPTION = 'hearBananas_System_Audio'

let systemAudioModuleId: string | null = null

const runPactl = (args: string[]): Promise<string> => {
  return new Promise((resolve, reject) => {
    execFile('pactl', args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message))
        return
      }
      resolve(stdout.trim())
    })
  })
}

const getDefaultMonitorSourceName = async (): Promise<string> => {
  const defaultSink = await runPactl(['get-default-sink'])
  if (!defaultSink) {
    throw new Error('PulseAudio/PipeWire did not report a default output sink')
  }

  const expectedMonitor = `${defaultSink}.monitor`
  const sources = await runPactl(['list', 'short', 'sources'])
  const sourceNames = sources
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[1])
    .filter((name): name is string => Boolean(name))

  const exactMonitor = sourceNames.find((name) => name === expectedMonitor)
  if (exactMonitor) return exactMonitor

  const matchingMonitor = sourceNames.find(
    (name) => name.endsWith('.monitor') && name.includes(defaultSink)
  )
  if (matchingMonitor) return matchingMonitor

  throw new Error(`No monitor source was found for the default output sink “${defaultSink}”`)
}

const unloadStaleSystemAudioModules = async (): Promise<void> => {
  const modules = await runPactl(['list', 'short', 'modules'])
  const staleModuleIds = modules
    .split('\n')
    .filter(
      (line) =>
        line.includes('module-remap-source') &&
        line.includes(`source_name=${SYSTEM_AUDIO_SOURCE_NAME}`)
    )
    .map((line) => line.trim().split(/\s+/)[0])
    .filter(Boolean)

  for (const moduleId of staleModuleIds) {
    await runPactl(['unload-module', moduleId]).catch((error) => {
      console.warn(`Could not unload stale system-audio module ${moduleId}`, error)
    })
  }
}

export type PreparedSystemAudioSource = {
  name: string
  label: string
}

export const prepareLinuxSystemAudio = async (): Promise<PreparedSystemAudioSource | null> => {
  if (process.platform !== 'linux') return null

  await releaseLinuxSystemAudio()
  await unloadStaleSystemAudioModules()

  const monitorSourceName = await getDefaultMonitorSourceName()

  systemAudioModuleId = await runPactl([
    'load-module',
    'module-remap-source',
    `master=${monitorSourceName}`,
    `source_name=${SYSTEM_AUDIO_SOURCE_NAME}`,
    `source_properties=device.description=${SYSTEM_AUDIO_SOURCE_DESCRIPTION}`
  ])

  const sources = await runPactl(['list', 'short', 'sources'])
  if (!sources.split('\n').some((line) => line.includes(SYSTEM_AUDIO_SOURCE_NAME))) {
    await releaseLinuxSystemAudio()
    throw new Error('The hearBananas system-audio source was created but did not become available')
  }

  return {
    name: SYSTEM_AUDIO_SOURCE_NAME,
    label: SYSTEM_AUDIO_SOURCE_DESCRIPTION
  }
}

export const releaseLinuxSystemAudio = async (): Promise<void> => {
  if (process.platform !== 'linux' || !systemAudioModuleId) return
  const moduleId = systemAudioModuleId
  systemAudioModuleId = null
  await runPactl(['unload-module', moduleId]).catch((error) => {
    console.warn(`Could not unload system-audio module ${moduleId}`, error)
  })
}

export const releaseLinuxSystemAudioSync = (): void => {
  if (process.platform !== 'linux' || !systemAudioModuleId) return
  const moduleId = systemAudioModuleId
  systemAudioModuleId = null
  try {
    execFileSync('pactl', ['unload-module', moduleId], { stdio: 'ignore' })
  } catch (error) {
    console.warn(`Could not unload system-audio module ${moduleId} while quitting`, error)
  }
}
