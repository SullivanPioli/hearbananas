<script lang="ts">
  import { onMount } from 'svelte'
  import Swal from 'sweetalert2'
  import { L } from './translations'
  import { useNavigationEnabled, useIsHosting, useHostUrl } from './stores'
  import { mayBeConnectionString, getDataFromBananasUrl, ConnectionType } from './Utils'
  import AudioVisualizer from './AudioVisualizer.svelte'
  import WebRTC from './WebRTC.svelte'

  const navigationEnabled = useNavigationEnabled()
  const isHosting = useIsHosting()

  let webRTCComponent: WebRTC
  let connectButton: HTMLButtonElement
  let copyButton: HTMLButtonElement
  let platform = ''

  let connectionState = 'disconnected'
  let connectedParticipantCount = 0
  let pendingParticipantCount = 0
  let cursorsActive = false
  let displayStreamActive = false
  let microphoneActive = false
  let isStreaming = false
  let sessionStarted = false
  let connectionStringIsValid: boolean | null = null
  let connectToUserName = ''
  let copyButtonIsLoading = false
  let copiedInvitationLength = 0
  let connectionString = useHostUrl()
  let hasAudioInput = false
  let shareSystemAudio = false
  let excludeDiscordVesktop = true
  let discordVesktopExclusionActive = false
  let windowsExcludedApplication = ''
  let hasSystemAudioInput = false
  let systemAudioActive = false
  let systemAudioDevices: MediaDeviceInfo[] = []
  let selectedSystemAudioDeviceId = ''
  let systemAudioDeviceIsLoading = false
  let systemAudioSignalActive = false
  let remoteAudioElement: HTMLAudioElement
  let hasRemoteAudio = false
  let remoteAudioActive = false
  let remoteAudioPlaybackBlocked = false
  let systemAudioCaptureError = ''
  let lastSystemAudioCaptureError = ''
  let visualizerIsActive: boolean = true

  const onConnectionStringChange = async (): Promise<void> => {
    const value = $connectionString
    connectToUserName = ''
    if (value === '') {
      connectionStringIsValid = null
      return
    }
    if (!mayBeConnectionString(ConnectionType.PARTICIPANT, value)) {
      connectionStringIsValid = false
      return
    }

    connectionStringIsValid = null
    try {
      const bananasData = await getDataFromBananasUrl(value)
      if ($connectionString !== value) return
      connectToUserName = bananasData.data.username
      connectionStringIsValid = true
    } catch {
      if ($connectionString === value) connectionStringIsValid = false
    }
  }

  const onConnectionStateChange = (): void => {
    switch (connectionState) {
      case 'connected':
        Swal.fire({
          position: 'top-end',
          icon: 'success',
          title: 'Connection established',
          showConfirmButton: false,
          timer: 1500
        })
        break
      case 'failed':
        Swal.fire({
          position: 'top-end',
          icon: 'error',
          title: 'Connection failed',
          showConfirmButton: false,
          timer: 1500
        })
        break
      case 'closed':
        Swal.fire({
          position: 'top-end',
          icon: 'info',
          title: 'Connection closed',
          showConfirmButton: false,
          timer: 1500
        })
        break
      default:
        break
    }
  }

  const onSystemAudioCaptureErrorChange = (): void => {
    if (!systemAudioCaptureError || systemAudioCaptureError === lastSystemAudioCaptureError) return
    lastSystemAudioCaptureError = systemAudioCaptureError
    hasSystemAudioInput = false
    systemAudioActive = false
    systemAudioSignalActive = false
    Swal.fire({
      icon: 'error',
      title: 'System audio capture stopped',
      text: systemAudioCaptureError
    })
  }

  $: $connectionString, onConnectionStringChange()
  $: connectionState, onConnectionStateChange()
  $: systemAudioCaptureError, onSystemAudioCaptureErrorChange()

  const toggleRemoteCursors = (): void => {
    cursorsActive = !cursorsActive
    window.BananasApi.toggleRemoteCursors(cursorsActive)
    webRTCComponent.ToggleRemoteCursors(cursorsActive)
  }

  const normalizeAudioDeviceLabel = (label: string): string => {
    return label.replaceAll(/[_\s-]/g, '').toLowerCase()
  }

  const waitForSystemAudioDevice = async (label: string): Promise<MediaDeviceInfo | undefined> => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      systemAudioDevices = await webRTCComponent.GetSystemAudioInputDevices()
      const preparedDevice = systemAudioDevices.find((device) =>
        normalizeAudioDeviceLabel(device.label).includes(normalizeAudioDeviceLabel(label))
      )
      if (preparedDevice) return preparedDevice
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    return undefined
  }

  onMount(async () => {
    platform = window.BananasApi.getPlatform()
    const settings = await window.BananasApi.getSettings()
    microphoneActive = settings.isMicrophoneEnabledOnConnect
    connectButton.addEventListener('click', async () => {
      try {
        const data = await getDataFromBananasUrl($connectionString)
        await webRTCComponent.AcceptParticipantAnswer(
          data.rtcSessionDescription,
          data.invitationId,
          data.data.username
        )
        isStreaming = true
        displayStreamActive = true
        $connectionString = ''
        connectionStringIsValid = null
        connectToUserName = ''
      } catch (error) {
        Swal.fire({
          icon: 'error',
          title: 'Could not add participant',
          text: error instanceof Error ? error.message : String(error)
        })
      }
    })
    copyButton.addEventListener('click', async () => {
      copyButtonIsLoading = true
      try {
        const offer = await webRTCComponent.CreateHostUrl({
          username: settings.username
        })
        copiedInvitationLength = offer.length
        await navigator.clipboard.writeText(offer)
      } catch (error) {
        Swal.fire({
          icon: 'error',
          title: 'Could not create invitation',
          text: error instanceof Error ? error.message : String(error)
        })
      } finally {
        setTimeout(() => {
          copyButtonIsLoading = false
        }, 400)
      }
    })
  })
  const onStartSessionButtonClick = async (): Promise<void> => {
    let preparedLinuxSource: {
      name: string
      label: string
      excludesDiscordVesktop: boolean
    } | null = null
    if (shareSystemAudio && platform === 'linux') {
      try {
        preparedLinuxSource = await window.BananasApi.prepareLinuxSystemAudio({
          excludeDiscordVesktop
        })
        discordVesktopExclusionActive = preparedLinuxSource?.excludesDiscordVesktop === true
      } catch (error) {
        discordVesktopExclusionActive = false
        console.error(error)
        Swal.fire({
          icon: 'warning',
          title: 'Could not prepare Linux system audio',
          text:
            error instanceof Error
              ? error.message
              : 'The AppImage needs pactl and a working PipeWire/PulseAudio default output monitor.'
        })
      }
    }

    await webRTCComponent.Setup(null, {
      shareSystemAudio: shareSystemAudio && platform === 'win32' && !excludeDiscordVesktop,
      remoteAudioElement
    })
    sessionStarted = true
    $navigationEnabled = false
    $isHosting = true
    hasAudioInput = webRTCComponent.HasAudioInput()
    hasSystemAudioInput = webRTCComponent.HasSystemAudioInput()

    if (shareSystemAudio && platform === 'win32' && excludeDiscordVesktop) {
      try {
        windowsExcludedApplication = await webRTCComponent.StartWindowsFilteredSystemAudio()
        discordVesktopExclusionActive = true
        hasSystemAudioInput = webRTCComponent.HasSystemAudioInput()
      } catch (error) {
        windowsExcludedApplication = ''
        discordVesktopExclusionActive = false
        hasSystemAudioInput = false
        console.error(error)
        Swal.fire({
          icon: 'warning',
          title: 'Could not exclude Discord/Vesktop audio',
          text:
            error instanceof Error
              ? error.message
              : 'Windows filtered-audio capture could not start.'
        })
      }
    } else if (shareSystemAudio && platform === 'linux' && preparedLinuxSource) {
      const preparedDevice = await waitForSystemAudioDevice(preparedLinuxSource.label)
      if (preparedDevice) {
        selectedSystemAudioDeviceId = preparedDevice.deviceId
        await selectSystemAudioDevice()
      }
    } else if (shareSystemAudio && platform === 'linux' && !hasSystemAudioInput) {
      systemAudioDevices = await webRTCComponent.GetSystemAudioInputDevices()
    }
    systemAudioActive = webRTCComponent.IsSystemAudioActive()
  }
  const selectSystemAudioDevice = async (): Promise<void> => {
    if (!selectedSystemAudioDeviceId) return
    systemAudioDeviceIsLoading = true
    systemAudioSignalActive = false
    hasSystemAudioInput = await webRTCComponent.SetSystemAudioDevice(selectedSystemAudioDeviceId)
    systemAudioActive = webRTCComponent.IsSystemAudioActive()
    systemAudioDeviceIsLoading = false

    if (!hasSystemAudioInput) {
      Swal.fire({
        icon: 'error',
        title: 'System audio source unavailable',
        text: 'Choose a PipeWire/PulseAudio monitor or loopback input and try again.'
      })
    }
  }
  const reset = (): void => {
    $connectionString = ''
    cursorsActive = false
    displayStreamActive = false
    microphoneActive = true
    shareSystemAudio = false
    discordVesktopExclusionActive = false
    windowsExcludedApplication = ''
    hasSystemAudioInput = false
    systemAudioActive = false
    systemAudioDevices = []
    selectedSystemAudioDeviceId = ''
    systemAudioDeviceIsLoading = false
    systemAudioSignalActive = false
    hasRemoteAudio = false
    remoteAudioActive = false
    remoteAudioPlaybackBlocked = false
    systemAudioCaptureError = ''
    lastSystemAudioCaptureError = ''
    isStreaming = false
    sessionStarted = false
    connectionStringIsValid = null
    copyButtonIsLoading = false
    copiedInvitationLength = 0
    connectedParticipantCount = 0
    pendingParticipantCount = 0
    $navigationEnabled = true
    $isHosting = false
  }
  const onDisconnectClick = async (): Promise<void> => {
    await webRTCComponent.Disconnect()
    await window.BananasApi.releaseLinuxSystemAudio()
    reset()
  }
  const onMicrophoneToggle = async (): Promise<void> => {
    microphoneActive = !microphoneActive
    webRTCComponent.ToggleMicrophone()
  }
  const onDisplayStreamToggle = async (): Promise<void> => {
    displayStreamActive = !displayStreamActive
    webRTCComponent.ToggleDisplayStream()
    if (!displayStreamActive) {
      cursorsActive = false
      window.BananasApi.toggleRemoteCursors(cursorsActive)
      webRTCComponent.ToggleRemoteCursors(cursorsActive)
    }
  }
  const onSystemAudioToggle = (): void => {
    webRTCComponent.ToggleSystemAudio()
    systemAudioActive = webRTCComponent.IsSystemAudioActive()
    if (!systemAudioActive) systemAudioSignalActive = false
  }
  const onRemoteAudioToggle = async (): Promise<void> => {
    remoteAudioActive = await webRTCComponent.ToggleRemoteAudio()
  }
</script>

<WebRTC
  bind:connectionState
  bind:connectedParticipantCount
  bind:pendingParticipantCount
  bind:hasRemoteAudio
  bind:remoteAudioActive
  bind:remoteAudioPlaybackBlocked
  bind:systemAudioCaptureError
  bind:this={webRTCComponent}
/>
<audio bind:this={remoteAudioElement} autoplay class="is-hidden"></audio>

<div class="container p-5">
  <h1 class="title">{!isStreaming ? L.host_a_session() : L.hosting_a_session()}</h1>
  <div class={!isStreaming ? 'is-hidden' : ''}>
    <div class="fixed-grid">
      <div class="grid">
        <div class="cell">
          <button
            title={displayStreamActive ? L.streaming_your_display() : L.streaming_your_display()}
            class="button {displayStreamActive ? 'is-success' : 'is-danger'}"
            on:click={onDisplayStreamToggle}
          >
            <span class="icon">
              <i class="fa-solid fa-display"></i>
            </span>
          </button>
          {#if hasAudioInput}
            <button
              title={microphoneActive ? 'Microphone active' : 'Microphone muted'}
              class="button {microphoneActive ? 'is-success' : 'is-danger'}"
              on:click={onMicrophoneToggle}
            >
              <span class="icon">
                {#if microphoneActive}
                  <AudioVisualizer
                    className="icon {!visualizerIsActive ? 'is-hidden' : ''}"
                    bind:visualizerIsActive
                    stream={webRTCComponent.GetAudioStream()}
                  />
                  <i class="fas fa-microphone {visualizerIsActive ? 'is-hidden' : ''}"></i>
                {:else}
                  <i class="fas fa-microphone-slash"></i>
                {/if}
              </span>
            </button>
          {/if}
          {#if hasSystemAudioInput}
            <button
              title={systemAudioActive ? 'System audio active' : 'System audio muted'}
              class="button {systemAudioActive ? 'is-success' : 'is-danger'}"
              on:click={onSystemAudioToggle}
            >
              <span class="icon">
                {#key selectedSystemAudioDeviceId}
                  {#if systemAudioActive}
                    <AudioVisualizer
                      className="icon {!systemAudioSignalActive ? 'is-hidden' : ''}"
                      bind:visualizerIsActive={systemAudioSignalActive}
                      stream={webRTCComponent.GetSystemAudioStream()}
                    />
                  {/if}
                {/key}
                <i
                  class="fas {systemAudioActive
                    ? 'fa-volume-high'
                    : 'fa-volume-xmark'} {systemAudioSignalActive ? 'is-hidden' : ''}"
                ></i>
              </span>
            </button>
          {/if}
          {#if hasRemoteAudio}
            <button
              title={remoteAudioActive ? 'Participant audio active' : 'Enable participant audio'}
              class="button {remoteAudioActive ? 'is-success' : 'is-danger'}"
              on:click={onRemoteAudioToggle}
            >
              <span class="icon">
                <i class="fas {remoteAudioActive ? 'fa-headphones' : 'fa-volume-xmark'}"></i>
              </span>
            </button>
          {/if}
          <button
            title={cursorsActive ? L.remote_cursors_enabled() : L.remote_cursors_disabled()}
            class="button {cursorsActive ? 'is-success' : 'is-danger'} {!displayStreamActive
              ? 'is-hidden'
              : ''}"
            on:click={toggleRemoteCursors}
          >
            <span class="icon">
              <i class="fas fa-mouse-pointer"></i>
            </span>
          </button>
        </div>
        <div class="cell has-text-right">
          <button class="button is-danger" on:click={onDisconnectClick}>
            <span class="icon">
              <i class="fas fa-unlink"></i>
            </span>
            <span>{L.disconnect()}</span>
          </button>
        </div>
      </div>
    </div>
  </div>
  <div class="fixed-grid has-2-cols">
    {#if platform === 'win32' || platform === 'linux'}
      <div class="field {sessionStarted ? 'is-hidden' : ''}">
        <label class="checkbox">
          <input type="checkbox" bind:checked={shareSystemAudio} disabled={sessionStarted} />
          Share system audio
        </label>
        <p class="help">
          Windows uses native WASAPI capture. Linux creates a temporary PipeWire/PulseAudio outgoing
          mix.
        </p>
      </div>
    {/if}

    {#if (platform === 'linux' || platform === 'win32') && shareSystemAudio}
      <div class="field {sessionStarted ? 'is-hidden' : ''}">
        <label class="checkbox">
          <input type="checkbox" bind:checked={excludeDiscordVesktop} disabled={sessionStarted} />
          Keep Discord/Vesktop out of the stream
        </label>
        <p class="help">
          Discord, Discord Canary/PTB, and Vesktop remain audible to you but are removed from the
          outgoing stream. On Windows, exactly one of those applications must be running.
        </p>
      </div>
    {/if}

    <div class="grid">
      <div class="cell">
        <button
          class="button is-link {isStreaming ? 'is-hidden' : ''}"
          disabled={sessionStarted}
          on:click={onStartSessionButtonClick}
        >
          <span class="icon">
            <i class="fas fa-play"></i>
          </span>
          <span>{!sessionStarted ? L.start_a_new_session() : L.session_started()}</span>
        </button>
      </div>

      <div class="cell">
        <button
          class="button is-danger {!sessionStarted || isStreaming ? 'is-hidden' : ''}"
          on:click={onDisconnectClick}
        >
          <span class="icon">
            <i class="fas fa-unlink"></i>
          </span>
          <span>{L.cancel()}</span>
        </button>
      </div>

      <div class="cell">
        <button
          class="button is-link {!sessionStarted ? 'is-hidden' : ''} {copyButtonIsLoading
            ? 'is-loading'
            : ''}"
          bind:this={copyButton}
          disabled={shareSystemAudio && !hasSystemAudioInput}
        >
          <span class="icon">
            <i class="fas fa-copy"></i>
          </span>
          <span>Copy a new friend invitation</span>
        </button>
        {#if copiedInvitationLength > 0}
          <p class="help {copiedInvitationLength <= 2000 ? 'is-success' : 'is-danger'}">
            Invitation copied ({copiedInvitationLength} characters). Each invitation is for one friend.{copiedInvitationLength <=
            2000
              ? ''
              : ' Discord may reject this network-specific invitation; send it as a text file.'}
          </p>
        {/if}
      </div>
    </div>

    {#if sessionStarted}
      <div class="notification is-info is-light">
        <strong>{connectedParticipantCount} connected</strong>
        · {pendingParticipantCount} invitation{pendingParticipantCount === 1 ? '' : 's'} waiting or connecting.
        Create a separate invitation for every friend, then paste each returned answer below.
      </div>
    {/if}

    {#if sessionStarted && !isStreaming && shareSystemAudio && systemAudioDevices.length > 0}
      <div class="field">
        <label class="label" for="system_audio_source">System audio source</label>
        <div class="control">
          <div class="select is-fullwidth {systemAudioDeviceIsLoading ? 'is-loading' : ''}">
            <select
              id="system_audio_source"
              bind:value={selectedSystemAudioDeviceId}
              on:change={selectSystemAudioDevice}
            >
              <option value="">Choose a monitor or loopback source</option>
              {#each systemAudioDevices as device, index}
                <option value={device.deviceId}>
                  {device.label || `Audio input ${index + 1}`}
                </option>
              {/each}
            </select>
          </div>
        </div>
        <p class="help">
          Normally Linux selects “hearBananas System Audio” automatically. If needed, choose an
          existing virtual or loopback input here.
        </p>
      </div>
    {/if}

    {#if sessionStarted && !isStreaming && shareSystemAudio && !hasSystemAudioInput && systemAudioDevices.length === 0}
      <div class="notification is-warning is-light">
        {#if platform === 'linux'}
          No system-audio source was detected. Make sure pactl can access the default PipeWire or
          PulseAudio output monitor, then cancel and start the session again.
        {:else}
          Filtered Windows audio is not ready. Cancel and retry with one Discord/Vesktop instance
          running, or turn the exclusion option off to use whole-system loopback.
        {/if}
      </div>
    {/if}

    {#if sessionStarted && !isStreaming && shareSystemAudio && hasSystemAudioInput}
      <div class="notification is-light {systemAudioSignalActive ? 'is-success' : 'is-warning'}">
        {#if systemAudioSignalActive}
          System audio is ready and sound is being detected. You can copy the connection string.
        {:else}
          The system-audio track is ready, but no sound is currently detected. Play some game or
          video audio and confirm that the volume icon starts moving before connecting.
        {/if}
        {#if discordVesktopExclusionActive}
          {windowsExcludedApplication || 'Discord/Vesktop'} audio is excluded from the outgoing mix but
          remains audible locally.
        {/if}
      </div>
    {/if}

    {#if remoteAudioPlaybackBlocked}
      <div class="notification is-warning is-light">
        Participant audio is ready, but automatic playback was blocked.
        <button class="button is-small is-warning" on:click={onRemoteAudioToggle}>
          Enable participant audio
        </button>
      </div>
    {/if}

    <div class="field has-addons {!sessionStarted ? 'is-hidden' : ''}">
      <div class="control has-icons-left has-icons-right">
        <input
          bind:value={$connectionString}
          placeholder="participant answer string"
          class="input {connectionStringIsValid === null
            ? ''
            : connectionStringIsValid
              ? 'is-success'
              : 'is-danger'}"
          type="text"
        />
        <span class="icon is-small is-left">
          <i class="fas fa-user"></i>
        </span>
        <span class="icon is-small is-right">
          <i
            class="fas fa-question {connectionStringIsValid === null
              ? 'fa-question'
              : connectionStringIsValid
                ? 'fa-check'
                : 'fa-times'}"
          ></i>
        </span>
      </div>
      <div class="control">
        <button
          class="button {connectionStringIsValid === null
            ? 'is-link'
            : connectionStringIsValid
              ? 'is-success'
              : 'is-danger'}"
          bind:this={connectButton}
          disabled={connectionStringIsValid ? false : true}
        >
          <span class="icon">
            <i class="fas fa-link"></i>
          </span>
          <span>Add {connectionStringIsValid ? connectToUserName : 'participant'} </span>
        </button>
      </div>
    </div>
  </div>
</div>
