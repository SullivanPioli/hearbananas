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
[GitHub releases page](https://github.com/mistweaverco/bananas/releases/latest).

Or if you are on Mac you can install it via homebrew with

```shell
brew install --cask bananas
```

## System audio sharing

When hosting a session, enable **Share system audio** before starting it.

- **Windows:** the app uses Electron's native loopback capture. No virtual audio device is
  required.
- **Linux:** the app uses `pactl` to expose the default PipeWire or PulseAudio output monitor as a
  temporary `hearBananas System Audio` input. It is selected automatically when available.
- **AppImage:** system audio uses the same PipeWire/PulseAudio devices exposed by the host system,
  so the AppImage does not need a bundled audio server or native Node module. The host must provide
  `pactl` (on Arch Linux, it is supplied by the `libpulse` package).

If automatic setup fails, check that `pactl info` works and that `@DEFAULT_MONITOR@` resolves to the
output you want to share. Existing virtual or loopback inputs can be selected manually in the app.
Whole-system loopback can also capture remote participant audio played by Bananas. If that causes an
echo, mute participant microphone return or route Bananas playback to an output that is not being
captured.
