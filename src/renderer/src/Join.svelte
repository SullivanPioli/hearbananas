<script lang="ts">
  import { onMount } from 'svelte'
  import Swal from 'sweetalert2'
  import { L } from './translations'
  import {
    makeVideoDraggable,
    mayBeConnectionString,
    getDataFromBananasUrl,
    ConnectionType,
    getUUIDv4
  } from './Utils'
  import { useNavigationEnabled, useIsWatching, useParticipantUrl } from './stores'
  import WebRTC from './WebRTC.svelte'
  import AudioVisualizer from './AudioVisualizer.svelte'

  const navigationEnabled = useNavigationEnabled()
  const isWatching = useIsWatching()

  let connectionState = 'disconnected'
  let webRTCComponent: WebRTC
  let connectButton: HTMLButtonElement
  let copyButton: HTMLButtonElement
  let remoteScreen: HTMLVideoElement
  let remoteAudioElement: HTMLAudioElement
  let UUID = getUUIDv4()
  let zoomFactor = 1
  let microphoneActive = false
  let isStreaming = false
  let isConnected = false
  let connectionStringIsValid: boolean | null = null
  let connectToUserName = ''
  let copyButtonIsLoading = false
  let copiedAnswerLength = 0
  let hasRemoteAudio = false
  let remoteAudioActive = false
  let remoteAudioPlaybackBlocked = false
  let microphoneMutedByHost = false
  let connectionString = useParticipantUrl()
  let visualizerIsActive: boolean = true

  const onConnectionStringChange = async (): Promise<void> => {
    const value = $connectionString
    connectToUserName = ''
    if (value === '') {
      connectionStringIsValid = null
      return
    }
    if (!mayBeConnectionString(ConnectionType.HOST, value)) {
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

  $: $connectionString, onConnectionStringChange()
  $: connectionState, onConnectionStateChange()
  $: microphoneMutedByHost, syncMicrophoneState()

  function syncMicrophoneState(): void {
    if (webRTCComponent) microphoneActive = webRTCComponent.IsMicrophoneActive()
  }

  onMount(async () => {
    const settings = await window.BananasApi.getSettings()
    microphoneActive = settings.isMicrophoneEnabledOnConnect
    makeVideoDraggable(remoteScreen)
    connectButton.addEventListener('click', async () => {
      try {
        await webRTCComponent.Setup(remoteScreen, { remoteAudioElement })
        const data = await getDataFromBananasUrl($connectionString)
        await webRTCComponent.AcceptHostOffer(data.rtcSessionDescription)
        isConnected = true
        $isWatching = true
        $navigationEnabled = false
      } catch (error) {
        await webRTCComponent.Disconnect()
        Swal.fire({
          icon: 'error',
          title: 'Could not accept invitation',
          text: error instanceof Error ? error.message : String(error)
        })
      }
    })
    copyButton.addEventListener('click', async () => {
      copyButtonIsLoading = true
      try {
        const remoteData = await getDataFromBananasUrl($connectionString)
        const data = await webRTCComponent.CreateParticipantUrl({
          username: settings.username,
          invitationId: remoteData.invitationId
        })
        copiedAnswerLength = data.length
        await navigator.clipboard.writeText(data)
      } catch (error) {
        Swal.fire({
          icon: 'error',
          title: 'Could not create answer',
          text: error instanceof Error ? error.message : String(error)
        })
      } finally {
        setTimeout(() => {
          copyButtonIsLoading = false
        }, 400)
      }
    })
    remoteScreen.addEventListener('dblclick', () => {
      webRTCComponent.PingRemoteCursor('cursor-' + UUID)
    })
    remoteScreen.addEventListener('mousemove', (e) => {
      const { offsetX, offsetY } = e
      // TODO: Batch cursor updates
      webRTCComponent.UpdateRemoteCursor({
        x: offsetX / remoteScreen.clientWidth,
        y: offsetY / remoteScreen.clientHeight,
        name: settings.username,
        id: 'cursor-' + UUID,
        color: settings.color
      })
    })
    remoteScreen.addEventListener('play', () => {
      if (!webRTCComponent.IsConnected()) return
      isStreaming = true
    })
  })
  const reset = (): void => {
    $connectionString = ''
    connectionStringIsValid = null
    isStreaming = false
    microphoneActive = false
    isConnected = false
    hasRemoteAudio = false
    remoteAudioActive = false
    remoteAudioPlaybackBlocked = false
    microphoneMutedByHost = false
    copiedAnswerLength = 0
    $navigationEnabled = true
    $isWatching = false
  }
  const onDisconnectClick = async (): Promise<void> => {
    await webRTCComponent.Disconnect()
    reset()
  }
  const onFullscreenClick = (): void => {
    remoteScreen.requestFullscreen()
  }
  const onZoomInClick = (): void => {
    zoomFactor += 0.1
    remoteScreen.style.scale = zoomFactor.toString()
  }
  const onZoomOutClick = (): void => {
    if (zoomFactor <= 1) return
    zoomFactor -= 0.1
    remoteScreen.style.scale = zoomFactor.toString()
  }
  const onMicrophoneToggle = async (): Promise<void> => {
    microphoneActive = webRTCComponent.ToggleMicrophone()
  }
  const onRemoteAudioToggle = async (): Promise<void> => {
    remoteAudioActive = await webRTCComponent.ToggleRemoteAudio()
  }
</script>

<WebRTC
  bind:connectionState
  bind:hasRemoteAudio
  bind:remoteAudioActive
  bind:remoteAudioPlaybackBlocked
  bind:microphoneMutedByHost
  bind:this={webRTCComponent}
/>
<audio bind:this={remoteAudioElement} autoplay class="is-hidden"></audio>

<div class="container p-5">
  <h1 class="title">{!isStreaming ? L.join_a_session() : L.joined_a_session()}</h1>
  <div class={!isStreaming ? 'is-hidden' : ''}>
    <div class="fixed-grid">
      <div class="grid">
        <div class="cell">
          <button
            aria-label={microphoneMutedByHost
              ? 'Microphone muted by host'
              : microphoneActive
                ? L.microphone_active()
                : L.microphone_inactive()}
            title={microphoneMutedByHost
              ? 'Microphone muted by host'
              : microphoneActive
                ? L.microphone_active()
                : L.microphone_inactive()}
            class="button {microphoneActive ? 'is-success' : 'is-danger'}"
            on:click={onMicrophoneToggle}
            disabled={microphoneMutedByHost}
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
          {#if hasRemoteAudio}
            <button
              title={remoteAudioActive ? 'Stream audio active' : 'Enable stream audio'}
              class="button {remoteAudioActive ? 'is-success' : 'is-danger'}"
              on:click={onRemoteAudioToggle}
            >
              <span class="icon">
                <i class="fas {remoteAudioActive ? 'fa-volume-high' : 'fa-volume-xmark'}"></i>
              </span>
            </button>
          {/if}
        </div>
        <div class="cell has-text-right">
          <button class="button is-danger" aria-label={L.disconnect()} on:click={onDisconnectClick}>
            <span class="icon">
              <i class="fas fa-unlink"></i>
            </span>
            <span>{L.disconnect()}</span>
          </button>
        </div>
      </div>
    </div>
  </div>
  {#if microphoneMutedByHost}
    <div class="notification is-info is-light mt-3">
      The host muted your hearBananas microphone. This does not mute you in Discord or Vesktop.
    </div>
  {/if}
  <div class="fixed-grid has-2-cols">
    <div class="grid">
      <div class="cell">
        <div class="field has-addons {isStreaming || isConnected ? 'is-hidden' : ''}">
          <div class="control has-icons-left has-icons-right">
            <input
              bind:value={$connectionString}
              placeholder={L.host_connection_string()}
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
        <div class="control">
          <button
            class="button is-link {!isConnected || isStreaming
              ? 'is-hidden'
              : ''} {copyButtonIsLoading ? 'is-loading' : ''}"
            bind:this={copyButton}
          >
            <span class="icon">
              <i class="fas fa-copy"></i>
            </span>
            <span>{L.copy_my_connection_string()}</span>
          </button>
          {#if copiedAnswerLength > 0}
            <p class="help {copiedAnswerLength <= 2000 ? 'is-success' : 'is-danger'}">
              Answer copied ({copiedAnswerLength} characters). Send it back to the host.{copiedAnswerLength <=
              2000
                ? ''
                : ' Discord may reject this network-specific answer; send it as a text file.'}
            </p>
          {/if}
        </div>
      </div>
      <div class="cell">
        <button
          class="button is-danger {isStreaming || !isConnected ? 'is-hidden' : ''}"
          on:click={onDisconnectClick}
        >
          <span class="icon">
            <i class="fas fa-unlink"></i>
          </span>
          <span>{L.cancel()}</span>
        </button>
      </div>
    </div>
  </div>
</div>

{#if remoteAudioPlaybackBlocked}
  <div class="container px-5">
    <div class="notification is-warning is-light">
      Stream audio is ready, but automatic playback was blocked.
      <button class="button is-small is-warning" on:click={onRemoteAudioToggle}>
        Enable stream audio
      </button>
    </div>
  </div>
{/if}

<div class={!isStreaming ? 'is-hidden' : ''}>
  <div class="field">
    <label class="label" for="remote_screen">{L.remote_screen()}</label>
    <div class="control">
      <div class="video-overflow">
        <video bind:this={remoteScreen} id="remote_screen" class="video" autoplay playsinline muted
        ></video>
      </div>
    </div>
  </div>
  <div class="field">
    <div class="control">
      <button class="button is-info" on:click={onZoomInClick}>
        <span class="icon">
          <i class="fas fa-search-plus"></i>
        </span>
        <span>{L.zoom_in()}</span>
      </button>
      <button class="button is-info" on:click={onZoomOutClick}>
        <span class="icon">
          <i class="fas fa-search-minus"></i>
        </span>
        <span>{L.zoom_out()}</span>
      </button>
      <button class="button is-info" on:click={onFullscreenClick}>
        <span class="icon">
          <i class="fas fa-expand"></i>
        </span>
        <span>{L.fullscreen()}</span>
      </button>
    </div>
  </div>
</div>

<style>
  .video {
    width: 100%;
    height: auto;
    transition: transform 0.5s linear;
  }
  .video-overflow {
    width: 100%;
    height: auto;
    overflow: hidden;
  }
</style>
