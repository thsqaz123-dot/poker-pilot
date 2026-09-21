export type PokerSound = 'chip' | 'check' | 'fold' | 'deal' | 'showdown' | 'win'

let audioContext: AudioContext | null = null

function context() {
  if (audioContext) return audioContext
  const AudioContextClass = window.AudioContext
    ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextClass) return null
  audioContext = new AudioContextClass()
  return audioContext
}

function tone(ctx: AudioContext, frequency: number, start: number, duration: number, volume = 0.05, type: OscillatorType = 'sine') {
  const oscillator = ctx.createOscillator()
  const gain = ctx.createGain()
  oscillator.type = type
  oscillator.frequency.setValueAtTime(frequency, start)
  gain.gain.setValueAtTime(volume, start)
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration)
  oscillator.connect(gain).connect(ctx.destination)
  oscillator.start(start)
  oscillator.stop(start + duration)
}

function noise(ctx: AudioContext, start: number, duration: number, volume: number) {
  const sampleCount = Math.max(1, Math.floor(ctx.sampleRate * duration))
  const buffer = ctx.createBuffer(1, sampleCount, ctx.sampleRate)
  const channel = buffer.getChannelData(0)
  for (let i = 0; i < sampleCount; i += 1) channel[i] = (Math.random() * 2 - 1) * (1 - i / sampleCount)
  const source = ctx.createBufferSource()
  const gain = ctx.createGain()
  source.buffer = buffer
  gain.gain.setValueAtTime(volume, start)
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration)
  source.connect(gain).connect(ctx.destination)
  source.start(start)
}

export function playPokerSound(sound: PokerSound) {
  const ctx = context()
  if (!ctx) return
  void ctx.resume()
  const at = ctx.currentTime + 0.01
  if (sound === 'chip') {
    tone(ctx, 920, at, 0.065, 0.14, 'triangle')
    tone(ctx, 1260, at + 0.045, 0.06, 0.11, 'triangle')
    noise(ctx, at, 0.06, 0.055)
  } else if (sound === 'check') {
    tone(ctx, 260, at, 0.08, 0.13, 'square')
    tone(ctx, 210, at + 0.08, 0.07, 0.1, 'square')
  } else if (sound === 'fold') {
    noise(ctx, at, 0.18, 0.075)
    tone(ctx, 180, at + 0.04, 0.14, 0.075, 'triangle')
  } else if (sound === 'deal') {
    ;[0, 0.075, 0.15, 0.225].forEach((offset, index) => {
      noise(ctx, at + offset, 0.07, 0.055)
      tone(ctx, 420 + index * 35, at + offset, 0.06, 0.075, 'triangle')
    })
  } else if (sound === 'showdown') {
    tone(ctx, 330, at, 0.14, 0.11)
    tone(ctx, 440, at + 0.1, 0.18, 0.13)
  } else {
    ;[523, 659, 784, 1047].forEach((frequency, index) => tone(ctx, frequency, at + index * 0.09, 0.28, 0.13))
  }
}
