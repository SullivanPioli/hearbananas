class HearBananasWindowsSystemAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffers = []
    this.currentBuffer = null
    this.currentOffset = 0
    this.port.onmessage = (event) => {
      if (!(event.data instanceof ArrayBuffer)) return
      if (this.buffers.length >= 64) this.buffers.splice(0, 32)
      this.buffers.push(new Int16Array(event.data))
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0]
    if (!output || output.length === 0) return true
    const left = output[0]
    const right = output[1] ?? output[0]
    left.fill(0)
    right.fill(0)

    let outputFrame = 0
    while (outputFrame < left.length) {
      if (!this.currentBuffer || this.currentOffset >= this.currentBuffer.length) {
        this.currentBuffer = this.buffers.shift() ?? null
        this.currentOffset = 0
        if (!this.currentBuffer) break
      }

      const availableFrames = Math.floor((this.currentBuffer.length - this.currentOffset) / 2)
      const framesToCopy = Math.min(availableFrames, left.length - outputFrame)
      for (let frame = 0; frame < framesToCopy; frame += 1) {
        left[outputFrame + frame] = this.currentBuffer[this.currentOffset] / 32768
        right[outputFrame + frame] = this.currentBuffer[this.currentOffset + 1] / 32768
        this.currentOffset += 2
      }
      outputFrame += framesToCopy
    }
    return true
  }
}

registerProcessor('hearbananas-windows-system-audio', HearBananasWindowsSystemAudioProcessor)
