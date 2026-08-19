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
  let cursorsActive = false
  let displayStreamActive = false
  let microphoneActive = false
  let isStreaming = false
  let sessionStarted = false
  let connectionStringIsValid: boolean | null = null
  let connectToUserName = ''
  let copyButtonIsLoading = false
  let connectionString = useHostUrl()
  let hasAudioInput = false
  let shareSystemAudio = false
  let hasSystemAudioInput = false
  let systemAudioActive = false
  let systemAudioDevices: MediaDeviceInfo[] = []
  let selectedSystemAudioDeviceId = ''
  let systemAudioDeviceIsLoading = false
  let visualizerIsActive: boolean = true

  const onConnectionStringChange = async (): Promise<void> => {
    if ($connectionString === '') {
      connectionStringIsValid = null
      return
    }
    connectionStringIsValid = mayBeConnectionString(ConnectionType.PARTICIPANT, $connectionString)
    if (connectionStringIsValid) {
      const banansData = await getDataFromBananasUrl($connectionString)
      connectToUserName = banansData.data.username
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

  $: $connectionString, onConnectionStringChange()
  $: connectionState, onConnectionStateChange()

  const toggleRemoteCursors = (): void => {
    cursorsActive = !cursorsActive
    window.BananasApi.toggleRemoteCursors(cursorsActive)
    webRTCComponent.ToggleRemoteCursors(cursorsActive)
  }

  onMount(async () => {
    platform = window.BananasApi.getPlatform()
    const settings = await window.BananasApi.getSettings()
    microphoneActive = settings.isMicrophoneEnabledOnConnect
    connectButton.addEventListener('click', async () => {
      const data = await getDataFromBananasUrl($connectionString)
      await webRTCComponent.Connect(data.rtcSessionDescription)
      isStreaming = true
      displayStreamActive = true
    })
    copyButton.addEventListener('click', async () => {
      copyButtonIsLoading = true
      const offer = await webRTCComponent.CreateHostUrl({
        username: settings.username
      })
      navigator.clipboard.writeText(offer)
      setTimeout(() => {
        copyButtonIsLoading = false
      }, 400)
    })
  })
  const onStartSessionButtonClick = async (): Promise<void> => {
    let preparedLinuxSource: { name: string; label: string } | null = null
    if (shareSystemAudio && platform === 'linux') {
      try {
        preparedLinuxSource = await window.BananasApi.prepareLinuxSystemAudio()
      } catch (error) {
        console.error(error)
        Swal.fire({
          icon: 'warning',
          title: 'Could not prepare Linux system audio',
          text: 'The AppImage needs pactl and a working PipeWire/PulseAudio default output monitor.'
        })
      }
    }

    await webRTCComponent.Setup(null, {
      shareSystemAudio: shareSystemAudio && platform === 'win32'
    })
    sessionStarted = true
    $navigationEnabled = false
    $isHosting = true
    hasAudioInput = webRTCComponent.HasAudioInput()
    hasSystemAudioInput = webRTCComponent.HasSystemAudioInput()

    if (shareSystemAudio && platform === 'linux' && preparedLinuxSource) {
      systemAudioDevices = await webRTCComponent.GetSystemAudioInputDevices()
      const preparedDevice = systemAudioDevices.find((device) =>
        device.label
          .replaceAll(/[_\s-]/g, '')
          .toLowerCase()
          .includes(preparedLinuxSource.label.replaceAll(/[_\s-]/g, '').toLowerCase())
      )
      if (preparedDevice) {
        selectedSystemAudioDeviceId = preparedDevice.deviceId
        await selectSystemAudioDevice()
      }
    } else if (shareSystemAudio && !hasSystemAudioInput) {
      systemAudioDevices = await webRTCComponent.GetSystemAudioInputDevices()
    }
    systemAudioActive = webRTCComponent.IsSystemAudioActive()
  }
  const selectSystemAudioDevice = async (): Promise<void> => {
    if (!selectedSystemAudioDeviceId) return
    systemAudioDeviceIsLoading = true
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
    hasSystemAudioInput = false
    systemAudioActive = false
    systemAudioDevices = []
    selectedSystemAudioDeviceId = ''
    systemAudioDeviceIsLoading = false
    isStreaming = false
    sessionStarted = false
    connectionStringIsValid = null
    copyButtonIsLoading = false
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
  }
</script>

<WebRTC bind:connectionState bind:this={webRTCComponent} />

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
                <i class="fas {systemAudioActive ? 'fa-volume-high' : 'fa-volume-xmark'}"></i>
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
          Windows uses automatic loopback capture. Linux creates a temporary PipeWire/PulseAudio
          source for the default output.
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
          class="button is-link {!sessionStarted || isStreaming
            ? 'is-hidden'
            : ''} {copyButtonIsLoading ? 'is-loading' : ''}"
          bind:this={copyButton}
        >
          <span class="icon">
            <i class="fas fa-copy"></i>
          </span>
          <span>{L.copy_my_connection_string()}</span>
        </button>
      </div>
    </div>

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
        No system-audio source was detected. Make sure pactl can access the default PipeWire or
        PulseAudio output monitor, then cancel and start the session again.
      </div>
    {/if}

    <div class="field has-addons {!sessionStarted || isStreaming ? 'is-hidden' : ''}">
      <div class="control has-icons-left has-icons-right">
        <input
          bind:value={$connectionString}
          placeholder="participant connection string"
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
          <span>{L.connect()} {connectionStringIsValid ? connectToUserName : ''} </span>
        </button>
      </div>
    </div>
  </div>
</div>
