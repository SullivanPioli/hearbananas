import { execFile, execFileSync } from 'node:child_process'

const SYSTEM_AUDIO_SOURCE_NAME = 'hearbananas_system_audio'
const SYSTEM_AUDIO_SOURCE_DESCRIPTION = 'hearBananas_System_Audio'
const SYSTEM_AUDIO_MIX_SINK_NAME = 'hearbananas_stream_mix'
const SYSTEM_AUDIO_MIX_SINK_DESCRIPTION = 'hearBananas_Stream_Mix'
const ROUTING_INTERVAL_MS = 500

const APPLICATION_IDENTITY_PROPERTIES = [
  'application.name',
  'application.id',
  'application.process.binary',
  'application.process.command_line',
  'application.process.argv0',
  'application.icon_name',
  'node.name'
]

type SinkInput = {
  index: number
  sinkIndex: number
  ownerModule: string | null
  properties: Record<string, string>
}

export type PrepareLinuxSystemAudioOptions = {
  excludeDiscordVesktop?: boolean
}

export type PreparedSystemAudioSource = {
  name: string
  label: string
  excludesDiscordVesktop: boolean
}

let systemAudioSourceModuleId: string | null = null
let systemAudioMixSinkModuleId: string | null = null
let systemAudioMasterSinkName: string | null = null
let systemAudioRoutingTimer: ReturnType<typeof setInterval> | null = null
let systemAudioRoutingEnabled = false
let systemAudioRoutingPass: Promise<void> | null = null
const movedSinkInputs = new Map<number, string>()

const pactlEnvironment = {
  ...process.env,
  LC_ALL: 'C'
}

const runPactl = (args: string[]): Promise<string> => {
  return new Promise((resolve, reject) => {
    execFile(
      'pactl',
      args,
      { encoding: 'utf8', env: pactlEnvironment },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message))
          return
        }
        resolve(stdout.trim())
      }
    )
  })
}

const runPactlSync = (args: string[]): void => {
  execFileSync('pactl', args, { stdio: 'ignore', env: pactlEnvironment })
}

const getDefaultSinkName = async (): Promise<string> => {
  const defaultSink = await runPactl(['get-default-sink'])
  if (!defaultSink) {
    throw new Error('PulseAudio/PipeWire did not report a default output sink')
  }
  return defaultSink
}

const getShortListNames = (output: string): string[] => {
  return output
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[1])
    .filter((name): name is string => Boolean(name))
}

const getMonitorSourceName = async (sinkName: string): Promise<string> => {
  const expectedMonitor = `${sinkName}.monitor`
  const sources = getShortListNames(await runPactl(['list', 'short', 'sources']))

  const exactMonitor = sources.find((name) => name === expectedMonitor)
  if (exactMonitor) return exactMonitor

  const matchingMonitor = sources.find(
    (name) => name.endsWith('.monitor') && name.includes(sinkName)
  )
  if (matchingMonitor) return matchingMonitor

  throw new Error(`No monitor source was found for the output sink “${sinkName}”`)
}

const waitForSourceName = async (sourceName: string): Promise<void> => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const sources = getShortListNames(await runPactl(['list', 'short', 'sources']))
    if (sources.includes(sourceName)) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`The Linux audio source “${sourceName}” did not become available`)
}

const unloadStaleSystemAudioModules = async (): Promise<void> => {
  const modules = await runPactl(['list', 'short', 'modules'])
  const lines = modules.split('\n')
  const staleSourceModuleIds = lines
    .filter(
      (line) =>
        line.includes('module-remap-source') &&
        line.includes(`source_name=${SYSTEM_AUDIO_SOURCE_NAME}`)
    )
    .map((line) => line.trim().split(/\s+/)[0])
    .filter(Boolean)
  const staleMixModuleIds = lines
    .filter(
      (line) =>
        line.includes('module-remap-sink') &&
        line.includes(`sink_name=${SYSTEM_AUDIO_MIX_SINK_NAME}`)
    )
    .map((line) => line.trim().split(/\s+/)[0])
    .filter(Boolean)

  for (const moduleId of [...staleSourceModuleIds, ...staleMixModuleIds]) {
    await runPactl(['unload-module', moduleId]).catch((error) => {
      console.warn(`Could not unload stale system-audio module ${moduleId}`, error)
    })
  }
}

const unquotePactlValue = (value: string): string => {
  const trimmed = value.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replaceAll('\\"', '"').replaceAll('\\\\', '\\')
  }
  return trimmed
}

const parseSinkInputs = (output: string): SinkInput[] => {
  const blocks = output.split(/\n(?=Sink Input #)/)
  const sinkInputs: SinkInput[] = []

  for (const block of blocks) {
    const index = Number.parseInt(block.match(/^Sink Input #(\d+)/m)?.[1] ?? '', 10)
    const sinkIndex = Number.parseInt(block.match(/^\s*Sink:\s*(\d+)/m)?.[1] ?? '', 10)
    if (!Number.isInteger(index) || !Number.isInteger(sinkIndex)) continue

    const ownerModuleValue = block.match(/^\s*Owner Module:\s*(\S+)/m)?.[1] ?? null
    const ownerModule = ownerModuleValue && ownerModuleValue !== 'n/a' ? ownerModuleValue : null
    const properties: Record<string, string> = {}
    for (const match of block.matchAll(/^\s*([\w.-]+)\s*=\s*(.+)$/gm)) {
      properties[match[1]] = unquotePactlValue(match[2])
    }

    sinkInputs.push({ index, sinkIndex, ownerModule, properties })
  }

  return sinkInputs
}

const parseSinkNamesByIndex = (output: string): Map<number, string> => {
  const sinkNames = new Map<number, string>()
  for (const line of output.split('\n')) {
    const [rawIndex, name] = line.trim().split(/\s+/)
    const index = Number.parseInt(rawIndex, 10)
    if (Number.isInteger(index) && name) sinkNames.set(index, name)
  }
  return sinkNames
}

const getApplicationIdentity = (sinkInput: SinkInput): string[] => {
  return APPLICATION_IDENTITY_PROPERTIES.map((key) => sinkInput.properties[key]).filter(
    (value): value is string => Boolean(value)
  )
}

const isDiscordOrVesktop = (sinkInput: SinkInput): boolean => {
  const applicationPattern =
    /(?:^|[./\\ _-])(?:discord(?:canary|ptb|development)?|vesktop)(?:$|[./\\ _-])/i
  return getApplicationIdentity(sinkInput).some((value) => applicationPattern.test(value))
}

const isHearBananas = (sinkInput: SinkInput): boolean => {
  const applicationPattern = /(?:^|[./\\ _-])(?:(?:hear|get)?bananas)(?:$|[./\\ _-])/i
  return getApplicationIdentity(sinkInput).some((value) => applicationPattern.test(value))
}

const moveSinkInput = async (sinkInputIndex: number, sinkName: string): Promise<void> => {
  await runPactl(['move-sink-input', sinkInputIndex.toString(), sinkName])
}

const runSystemAudioRoutingPass = async (): Promise<void> => {
  if (!systemAudioRoutingEnabled || !systemAudioMasterSinkName || !systemAudioMixSinkModuleId) {
    return
  }

  const [rawSinks, rawSinkInputs] = await Promise.all([
    runPactl(['list', 'short', 'sinks']),
    runPactl(['list', 'sink-inputs'])
  ])
  const sinkNames = parseSinkNamesByIndex(rawSinks)
  const mixSinkIndex = [...sinkNames.entries()].find(
    ([, name]) => name === SYSTEM_AUDIO_MIX_SINK_NAME
  )?.[0]
  if (mixSinkIndex === undefined) {
    throw new Error('The hearBananas outgoing audio mix is no longer available')
  }

  const sinkInputs = parseSinkInputs(rawSinkInputs)
  const currentSinkInputIndexes = new Set(sinkInputs.map((sinkInput) => sinkInput.index))
  for (const trackedIndex of movedSinkInputs.keys()) {
    if (!currentSinkInputIndexes.has(trackedIndex)) movedSinkInputs.delete(trackedIndex)
  }

  for (const sinkInput of sinkInputs) {
    if (sinkInput.ownerModule === systemAudioMixSinkModuleId) continue

    const applicationIdentity = getApplicationIdentity(sinkInput)
    if (applicationIdentity.length === 0) continue

    const shouldBypassMix = isDiscordOrVesktop(sinkInput) || isHearBananas(sinkInput)
    if (shouldBypassMix) {
      if (sinkInput.sinkIndex === mixSinkIndex) {
        const restoreSink = movedSinkInputs.get(sinkInput.index) ?? systemAudioMasterSinkName
        await moveSinkInput(sinkInput.index, restoreSink).catch(async () => {
          await moveSinkInput(sinkInput.index, systemAudioMasterSinkName as string)
        })
        movedSinkInputs.delete(sinkInput.index)
      }
      continue
    }

    if (sinkInput.sinkIndex === mixSinkIndex) {
      if (!movedSinkInputs.has(sinkInput.index)) {
        movedSinkInputs.set(sinkInput.index, systemAudioMasterSinkName)
      }
      continue
    }

    if (!movedSinkInputs.has(sinkInput.index)) {
      movedSinkInputs.set(
        sinkInput.index,
        sinkNames.get(sinkInput.sinkIndex) ?? systemAudioMasterSinkName
      )
    }
    await moveSinkInput(sinkInput.index, SYSTEM_AUDIO_MIX_SINK_NAME).catch((error) => {
      movedSinkInputs.delete(sinkInput.index)
      console.warn(`Could not route audio stream ${sinkInput.index} into the outgoing mix`, error)
    })
  }
}

const scheduleSystemAudioRoutingPass = (): Promise<void> => {
  if (!systemAudioRoutingEnabled) return Promise.resolve()
  if (systemAudioRoutingPass) return systemAudioRoutingPass
  systemAudioRoutingPass = runSystemAudioRoutingPass().finally(() => {
    systemAudioRoutingPass = null
  })
  return systemAudioRoutingPass
}

const startSystemAudioRouting = async (): Promise<void> => {
  systemAudioRoutingEnabled = true
  await scheduleSystemAudioRoutingPass()
  systemAudioRoutingTimer = setInterval(() => {
    void scheduleSystemAudioRoutingPass().catch((error) => {
      console.warn('Could not refresh the hearBananas outgoing audio mix', error)
    })
  }, ROUTING_INTERVAL_MS)
  systemAudioRoutingTimer.unref()
}

const stopSystemAudioRouting = async (): Promise<void> => {
  systemAudioRoutingEnabled = false
  if (systemAudioRoutingTimer) {
    clearInterval(systemAudioRoutingTimer)
    systemAudioRoutingTimer = null
  }
  await systemAudioRoutingPass?.catch(() => undefined)

  for (const [sinkInputIndex, originalSink] of movedSinkInputs) {
    await moveSinkInput(sinkInputIndex, originalSink).catch(async () => {
      await moveSinkInput(sinkInputIndex, '@DEFAULT_SINK@').catch((error) => {
        console.warn(`Could not restore audio stream ${sinkInputIndex}`, error)
      })
    })
  }
  movedSinkInputs.clear()
}

const stopSystemAudioRoutingSync = (): void => {
  systemAudioRoutingEnabled = false
  if (systemAudioRoutingTimer) {
    clearInterval(systemAudioRoutingTimer)
    systemAudioRoutingTimer = null
  }

  for (const [sinkInputIndex, originalSink] of movedSinkInputs) {
    try {
      runPactlSync(['move-sink-input', sinkInputIndex.toString(), originalSink])
    } catch {
      try {
        runPactlSync(['move-sink-input', sinkInputIndex.toString(), '@DEFAULT_SINK@'])
      } catch (error) {
        console.warn(`Could not restore audio stream ${sinkInputIndex} while quitting`, error)
      }
    }
  }
  movedSinkInputs.clear()
}

export const prepareLinuxSystemAudio = async (
  options: PrepareLinuxSystemAudioOptions = {}
): Promise<PreparedSystemAudioSource | null> => {
  if (process.platform !== 'linux') return null

  await releaseLinuxSystemAudio()
  await unloadStaleSystemAudioModules()

  const excludeDiscordVesktop = options.excludeDiscordVesktop === true
  const defaultSink = await getDefaultSinkName()

  try {
    let monitorSourceName: string
    if (excludeDiscordVesktop) {
      systemAudioMasterSinkName = defaultSink
      systemAudioMixSinkModuleId = await runPactl([
        'load-module',
        'module-remap-sink',
        `master=${defaultSink}`,
        `sink_name=${SYSTEM_AUDIO_MIX_SINK_NAME}`,
        `sink_properties=device.description=${SYSTEM_AUDIO_MIX_SINK_DESCRIPTION}`
      ])
      monitorSourceName = `${SYSTEM_AUDIO_MIX_SINK_NAME}.monitor`
      await waitForSourceName(monitorSourceName)
    } else {
      monitorSourceName = await getMonitorSourceName(defaultSink)
    }

    systemAudioSourceModuleId = await runPactl([
      'load-module',
      'module-remap-source',
      `master=${monitorSourceName}`,
      `source_name=${SYSTEM_AUDIO_SOURCE_NAME}`,
      `source_properties=device.description=${SYSTEM_AUDIO_SOURCE_DESCRIPTION}`
    ])
    await waitForSourceName(SYSTEM_AUDIO_SOURCE_NAME)

    if (excludeDiscordVesktop) await startSystemAudioRouting()

    return {
      name: SYSTEM_AUDIO_SOURCE_NAME,
      label: SYSTEM_AUDIO_SOURCE_DESCRIPTION,
      excludesDiscordVesktop: excludeDiscordVesktop
    }
  } catch (error) {
    await releaseLinuxSystemAudio()
    throw error
  }
}

export const releaseLinuxSystemAudio = async (): Promise<void> => {
  if (process.platform !== 'linux') return

  await stopSystemAudioRouting()

  const sourceModuleId = systemAudioSourceModuleId
  const mixSinkModuleId = systemAudioMixSinkModuleId
  systemAudioSourceModuleId = null
  systemAudioMixSinkModuleId = null
  systemAudioMasterSinkName = null

  if (sourceModuleId) {
    await runPactl(['unload-module', sourceModuleId]).catch((error) => {
      console.warn(`Could not unload system-audio source module ${sourceModuleId}`, error)
    })
  }
  if (mixSinkModuleId) {
    await runPactl(['unload-module', mixSinkModuleId]).catch((error) => {
      console.warn(`Could not unload system-audio mix module ${mixSinkModuleId}`, error)
    })
  }
}

export const releaseLinuxSystemAudioSync = (): void => {
  if (process.platform !== 'linux') return

  stopSystemAudioRoutingSync()

  const sourceModuleId = systemAudioSourceModuleId
  const mixSinkModuleId = systemAudioMixSinkModuleId
  systemAudioSourceModuleId = null
  systemAudioMixSinkModuleId = null
  systemAudioMasterSinkName = null

  for (const [moduleId, description] of [
    [sourceModuleId, 'source'],
    [mixSinkModuleId, 'mix']
  ] as const) {
    if (!moduleId) continue
    try {
      runPactlSync(['unload-module', moduleId])
    } catch (error) {
      console.warn(
        `Could not unload system-audio ${description} module ${moduleId} while quitting`,
        error
      )
    }
  }
}
