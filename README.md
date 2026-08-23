<div align="center">

![Bananas Screen Sharing Logo](logo.svg)

# Bananas Screen Sharing

[![Downloads](https://img.shields.io/github/downloads/mistweaverco/bananas/total.svg?style=for-the-badge)](https://getbananas.net/)
[![GitHub release (latest by date)](https://img.shields.io/github/v/release/mistweaverco/bananas?style=for-the-badge)](https://github.com/mistweaverco/bananas/releases/latest)

[Install](#install) • [Website](https://getbananas.net/) • [Tutorial](https://getbananas.net/tutorial) • [Privacy Policy](./PRIVACY.md) • [Terms of Service](./TOS.md) • [Code of Conduct](./CODE_OF_CONDUCT.md)

<p></p>

Bananas Screen Sharing is a simple and
easy-to-use screen sharing tool for Mac, Windows, and Linux.

It utilizes a peer-to-peer connection to share your screen with others,
without the need for an account or any server infrastructure
(except for the stun, turn and signaling servers that are needed for exchanging the initial connection information)

<p></p>

</div>

## Install

Grab the latest release from the
[GitHub releases page](https://github.com/SullivanPioli/hearbananas/releases/latest).

Or if you are on Mac you can install it via homebrew with

```shell
brew install --cask bananas
```

## Connecting friends

hearBananas uses short, compressed, serverless connection strings. The host clicks **Copy a new
friend invitation** once per friend and sends each person a different invitation. Each friend joins
with their invitation, copies the answer string, and sends that answer back. The host can paste and
add the returned answers in any order while the stream stays open.

A host can have up to eight pending invitations or connected friends in one session. Invitations
are single-use because every friend has a separate encrypted peer-to-peer WebRTC connection. The
host's upload bandwidth grows with every connected friend, so lower the capture resolution or
frame rate if several viewers experience stuttering.

New connection strings use a compact format designed to fit under Discord's 2,000-character
message limit on ordinary networks. The parser accepts codes pasted inside Discord angle brackets,
Markdown code blocks, or surrounding text, and remains compatible with v2 compact and original
legacy codes. The app displays the exact length after copying. Unusually large ICE/TURN
configurations can still exceed the limit; in that case, send the string as a text file without
editing it.

After a friend returns an answer, the host's **Room members** list shows their connection state. The
host can mute an individual hearBananas microphone (without muting that person in Discord/Vesktop)
or kick that participant without disconnecting anyone else.

## System audio sharing

When hosting a session, enable **Share system audio** before starting it.

- **Windows:** with **Keep Discord/Vesktop out of the stream** enabled, a bundled WASAPI helper
  captures the system mix while excluding the running Discord, Discord Canary/PTB, or Vesktop
  process tree. The call remains audible locally and no virtual audio device is required. Exactly
  one independent Discord-family/Vesktop process tree must be running. Turning the option off uses
  Electron's ordinary whole-system loopback instead. Microsoft documents process-loopback capture
  for Windows build 20348 or later; on an older or unsupported build, use the whole-system fallback.
- **Linux:** the app uses `pactl` to expose a temporary `hearBananas System Audio` input. With
  **Keep Discord/Vesktop out of the stream** enabled, it creates a separate outgoing mix, routes
  normal game/video audio through it, and lets Discord, Discord Canary/PTB, Vesktop, and
  hearBananas playback bypass it. Bypassed apps remain audible through the same real output.
- **AppImage:** system audio uses the same PipeWire/PulseAudio devices exposed by the host system,
  so the AppImage does not need a bundled audio server or native Node module. The host must provide
  `pactl` (on Arch Linux, it is supplied by the `libpulse` package).

Before copying the connection string, play some game or video audio and wait for the app to report
that sound is being detected. The connection-string button remains disabled until a valid audio
track is ready. If the receiving computer blocks automatic playback, use the **Enable stream
audio** warning or the volume button in the session toolbar.

If automatic Linux setup fails, check that `pactl info` and `pactl get-default-sink` work and that
the default sink has a matching `.monitor` source in `pactl list short sources`. Existing virtual
or loopback inputs can be selected manually in the app. Disconnecting restores streams to their
previous outputs and removes the temporary mix. If the output device changes during a session,
cancel and start a new session so the mix can follow the new default output.

The exclusions recognize installed Discord-family desktop applications from their process or audio
stream identity. Discord running inside a general web browser is seen as browser audio and is
therefore not excluded. On Windows, filtered capture fails closed if no supported application is
running or if multiple independent Discord/Vesktop process trees are detected; cancel the session
and correct that condition, or turn the exclusion option off if whole-system loopback is acceptable.
When exclusion is enabled, newly joined hearBananas participants also start host-muted. This keeps
their return-audio playback from being captured and rebroadcast as part of the Windows system mix;
the host can unmute them individually from **Room members** when wanted.

Building the Windows installer from source requires CMake and the Visual Studio C++ toolchain. The
Windows build script compiles the helper first and packages it beside the Electron application.
