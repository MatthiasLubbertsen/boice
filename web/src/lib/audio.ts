import { Mp3Encoder } from '@breezystack/lamejs'

/** Every clip is stored as 44.1 kHz mono MP3 so the server can join clips without re-encoding. */
export const SAMPLE_RATE = 44100
const BLOCK = 1024 // samples per block from the worklet (~23 ms)

export interface TakeOptions {
  /** End the take automatically once the speaker goes quiet. */
  auto: boolean
  /** How long a pause must last before the take ends, in ms. */
  silenceMs: number
  /** 0 (only loud speech counts) … 1 (picks up quiet speech). */
  sensitivity: number
  onSpeechStart?: () => void
  /** Called with the finished take when it ends on its own. */
  onTake?: (samples: Float32Array) => void
}

type Phase = 'idle' | 'waiting' | 'speaking'

const PRE_ROLL_BLOCKS = 10 // ~230 ms kept from before speech starts
const TAIL_BLOCKS = 9 // ~210 ms kept after the last voiced block
const START_BLOCKS = 3 // consecutive loud blocks that count as speech
const MIN_SPEECH_BLOCKS = 8 // shorter than ~190 ms is a click, not a word
const MAX_TAKE_BLOCKS = Math.round((20 * SAMPLE_RATE) / BLOCK)

/**
 * Mic owns the microphone and cuts the stream into takes with a small
 * energy-based voice detector: speech starts when the level stays above an
 * adaptive noise floor, and ends after a pause.
 */
export class Mic {
  /** Latest input level, 0…1, for the meter. */
  level = 0
  /** Whether the current block counts as speech. */
  voiced = false
  onLevel?: () => void

  private phase: Phase = 'idle'
  private opts: TakeOptions | null = null
  private blocks: Float32Array[] = []
  private noise = 0.004
  private loudRun = 0
  private quietRun = 0
  private speechBlocks = 0
  private lastVoiced = 0
  private ctx: AudioContext
  private stream: MediaStream
  private rate: number

  private constructor(ctx: AudioContext, stream: MediaStream) {
    this.ctx = ctx
    this.stream = stream
    this.rate = ctx.sampleRate
  }

  static async open(): Promise<Mic> {
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) {
      throw new Error('This browser cannot record audio. Recording needs HTTPS and a recent browser.')
    }
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
    } catch (e) {
      const name = (e as DOMException).name
      throw new Error(
        name === 'NotAllowedError'
          ? 'Microphone access was blocked. Allow it in your browser’s site settings, then try again.'
          : 'No microphone found. Plug one in and try again.',
      )
    }
    // Ask for 44.1 kHz; browsers that can't mix rates fall back to the device rate and we resample.
    let ctx: AudioContext
    let source: MediaStreamAudioSourceNode
    try {
      ctx = new AudioContext({ sampleRate: SAMPLE_RATE })
      source = ctx.createMediaStreamSource(stream)
    } catch {
      ctx = new AudioContext()
      source = ctx.createMediaStreamSource(stream)
    }
    await ctx.audioWorklet.addModule('/recorder-worklet.js')
    const mic = new Mic(ctx, stream)
    const node = new AudioWorkletNode(ctx, 'boice-recorder')
    node.port.onmessage = (e) => mic.onBlock(e.data as Float32Array)
    const mute = ctx.createGain()
    mute.gain.value = 0
    source.connect(node).connect(mute).connect(ctx.destination) // keeps the graph running, silently
    if (ctx.state === 'suspended') await ctx.resume()
    return mic
  }

  close() {
    this.phase = 'idle'
    this.stream.getTracks().forEach((t) => t.stop())
    void this.ctx.close()
  }

  /** Starts listening for a new take. */
  arm(opts: TakeOptions) {
    this.opts = opts
    this.blocks = []
    this.loudRun = this.quietRun = this.speechBlocks = this.lastVoiced = 0
    this.phase = 'waiting'
  }

  /** Stops listening and throws away the take in progress. */
  disarm() {
    this.phase = 'idle'
    this.blocks = []
  }

  get speaking() {
    return this.phase === 'speaking'
  }

  /** Ends the take by hand. Returns the audio, or null if nothing was said. */
  finish(): Float32Array | null {
    const { phase, blocks } = this
    this.phase = 'idle'
    this.blocks = []
    if (phase === 'speaking' && this.speechBlocks >= MIN_SPEECH_BLOCKS) return this.cut(blocks)
    return null
  }

  private threshold() {
    const s = this.opts?.sensitivity ?? 0.5
    const factor = 5 - 3.2 * s // 5× noise floor (strict) … 1.8× (sensitive)
    const floor = 0.03 - 0.024 * s
    return Math.max(this.noise * factor, floor)
  }

  private cut(blocks: Float32Array[]) {
    return join(blocks.slice(0, Math.min(blocks.length, this.lastVoiced + TAIL_BLOCKS)))
  }

  private onBlock(block: Float32Array) {
    let sum = 0
    for (let i = 0; i < block.length; i++) sum += block[i] * block[i]
    const rms = Math.sqrt(sum / block.length)
    const loud = rms > this.threshold()
    this.voiced = loud && this.phase !== 'idle'
    this.level = Math.min(1, Math.sqrt(rms) * 1.6) // perceptual-ish scaling for the meter
    this.onLevel?.()

    // Track the room's noise floor while nobody is speaking.
    if (this.phase !== 'speaking') {
      this.noise = rms < this.noise ? rms * 0.3 + this.noise * 0.7 : rms * 0.02 + this.noise * 0.98
      this.noise = Math.min(this.noise, 0.05)
    }
    if (this.phase === 'idle' || !this.opts) return

    this.blocks.push(block)
    if (this.phase === 'waiting') {
      this.loudRun = loud ? this.loudRun + 1 : 0
      // Only keep a short pre-roll while waiting for speech.
      if (this.loudRun < START_BLOCKS && this.blocks.length > PRE_ROLL_BLOCKS + START_BLOCKS) this.blocks.shift()
      if (this.loudRun >= START_BLOCKS) {
        this.phase = 'speaking'
        this.speechBlocks = this.loudRun
        this.quietRun = 0
        this.lastVoiced = this.blocks.length
        this.opts.onSpeechStart?.()
      }
      return
    }

    // speaking
    if (loud) {
      this.speechBlocks++
      this.quietRun = 0
      this.lastVoiced = this.blocks.length
    } else {
      this.quietRun++
    }
    const quietMs = (this.quietRun * BLOCK * 1000) / this.rate
    const tooLong = this.blocks.length >= MAX_TAKE_BLOCKS
    if ((this.opts.auto && quietMs >= this.opts.silenceMs) || tooLong) {
      const { opts, blocks } = this
      const enough = this.speechBlocks >= MIN_SPEECH_BLOCKS
      if (!enough) {
        this.arm(opts) // a cough or a click: keep waiting
        return
      }
      this.phase = 'idle'
      this.blocks = []
      opts.onTake?.(this.cut(blocks))
    }
  }

  /** Encodes a take as a 44.1 kHz mono MP3. */
  encode(samples: Float32Array): Blob {
    return encodeMp3(this.rate === SAMPLE_RATE ? samples : resample(samples, this.rate, SAMPLE_RATE))
  }
}

function join(blocks: Float32Array[]) {
  const out = new Float32Array(blocks.reduce((n, b) => n + b.length, 0))
  let offset = 0
  for (const b of blocks) {
    out.set(b, offset)
    offset += b.length
  }
  return out
}

function resample(input: Float32Array, from: number, to: number) {
  const out = new Float32Array(Math.floor((input.length * to) / from))
  const step = from / to
  for (let i = 0; i < out.length; i++) {
    const pos = i * step
    const i0 = Math.floor(pos)
    const i1 = Math.min(i0 + 1, input.length - 1)
    out[i] = input[i0] + (input[i1] - input[i0]) * (pos - i0)
  }
  return out
}

function encodeMp3(samples: Float32Array): Blob {
  // Even out the volume between takes, and fade the edges so joins don't click.
  let peak = 0
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]))
  const gain = peak > 0.001 ? Math.min(0.89 / peak, 12) : 1
  const fade = Math.min(Math.round(SAMPLE_RATE * 0.012), samples.length >> 1)
  const pcm = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const edge = Math.min(1, i / fade, (samples.length - 1 - i) / fade)
    pcm[i] = Math.max(-1, Math.min(1, samples[i] * gain * edge)) * 32767
  }
  const encoder = new Mp3Encoder(1, SAMPLE_RATE, 96)
  const parts: Uint8Array[] = []
  for (let i = 0; i < pcm.length; i += 1152) {
    const chunk = encoder.encodeBuffer(pcm.subarray(i, i + 1152))
    if (chunk.length) parts.push(new Uint8Array(chunk))
  }
  const end = encoder.flush()
  if (end.length) parts.push(new Uint8Array(end))
  return new Blob(parts as BlobPart[], { type: 'audio/mpeg' })
}
