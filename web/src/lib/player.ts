/** Plays clips one at a time; starting a new one stops the previous. */
class Player {
  private audio: HTMLAudioElement | null = null

  play(url: string): Promise<void> {
    this.stop()
    const audio = new Audio(url)
    this.audio = audio
    return new Promise((resolve) => {
      audio.onended = audio.onerror = audio.onpause = () => resolve()
      audio.play().catch(() => resolve())
    })
  }

  stop() {
    this.audio?.pause()
    this.audio = null
  }
}

export const player = new Player()
