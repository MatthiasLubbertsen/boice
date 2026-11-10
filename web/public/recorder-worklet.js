// Forwards microphone audio to the main thread in fixed-size blocks.
class BoiceRecorder extends AudioWorkletProcessor {
  constructor() {
    super()
    this.block = new Float32Array(1024)
    this.filled = 0
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        this.block[this.filled++] = channel[i]
        if (this.filled === this.block.length) {
          this.port.postMessage(this.block.slice())
          this.filled = 0
        }
      }
    }
    return true
  }
}

registerProcessor('boice-recorder', BoiceRecorder)
