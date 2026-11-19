import { useCallback, useEffect, useRef } from 'react'

/**
 * Listens for the customer's voice, and for the customer's voice only.
 *
 * What keeps background noise out:
 *  - the browser's own echo cancellation, noise suppression, auto gain and (where supported) voice isolation;
 *  - a speech-band filter (120 Hz to 5.2 kHz) before anything is measured or recorded, so rumble, hum and hiss never count and are not sent;
 *  - a gate that learns the room's noise level and only opens for sound clearly louder than it (3.5x the quietest moments, and 1.9x the loudest
 *    recent background, so a television that talks all the time is not mistaken for the customer);
 *  - a customer must keep talking for a moment before it counts as speech, so a door slam or a cough is ignored.
 *
 * The audio is captured as raw samples (not with MediaRecorder) so that the half second BEFORE speech was detected is kept. That is what makes
 * interrupting Spark work: by the time we are sure the customer is talking over Spark, their first words are already in the recording.
 * The recording is sent as 16 kHz mono WAV. The microphone stays open between questions so the browser asks for permission only once.
 */
const SILENCE_END_QUICK_MS = 650    // after a short answer such as "yes": the answer is over as soon as the customer stops
const SILENCE_END_MS = 900          // after a longer answer
const QUICK_ANSWER_MS = 1500
const TAIL_KEEP_MS = 300            // how much trailing silence is kept in what is sent
const GIVE_UP_MS = 10000
const MAX_MS = 30000
const MIN_SPEECH_MS = 250
const SETTLE_MS = 350        // let the end of Spark's voice (and its echo in the room) die away before listening
const MIN_GATE = 0.022       // the quietest sound that can ever count as speech
const GATE_FACTOR = 3.5      // ... and how many times louder than the room it must be
const AMBIENT_MS = 10000     // what the room sounded like over the last 10 s, including a television that talks all the time
const AMBIENT_FACTOR = 1.9   // the customer must be this much louder than the loudest the background was lately (its 90th percentile)
const BIN_MS = 100
const RUN_MS = 300           // speech counts only after this much unbroken talking (gaps under 200 ms are bridged), so TV blips do not add up
const RUN_GAP_MS = 200
const RING_MS = 1500         // how much recent sound is always kept, for the pre-roll
const BARGE_GATE = 0.05      // while Spark is talking, the customer must be clearly louder than Spark's echo
const BARGE_FACTOR = 5
const BARGE_MS = 380         // ... and keep talking for this long before we stop Spark
const BARGE_GRACE_MS = 700   // ignore the first moments of Spark's own voice
const TARGET_RATE = 16000

export interface RecordOptions {
  /** Include this much sound from just before the recording started (used when the customer interrupted Spark). */
  preRollMs?: number
  /** Wait this long after the customer stops before ending (for open questions, where people pause to think). Default: 650 ms after a short answer, 900 ms after a longer one. */
  endSilenceMs?: number
}

export interface Recorder {
  /** Resolves with the recording, or null if nobody spoke / it was cancelled. Rejects if the microphone cannot be used. */
  record: (onLevel: (level: number) => void, opts?: RecordOptions) => Promise<Blob | null>
  /** While Spark speaks: calls onSpeech once if the customer starts talking over it. Returns a function that stops watching. */
  watch: (onSpeech: () => void) => () => void
  /** Ends the current recording now (keeps what was said). */
  stop: () => void
  /** Throws the current recording away. */
  cancel: () => void
  release: () => void
}

const TAP_MODULE = `
class Tap extends AudioWorkletProcessor {
  process(inputs) { const c = inputs[0] && inputs[0][0]; if (c) this.port.postMessage(c.slice()); return true }
}
registerProcessor('spark-tap', Tap)
`

/** Keeps the frames up to keepMs of sound: the silence after the last word only slows the upload and the transcription. */
function trimTail(frames: Float32Array[], rate: number, keepMs: number): Float32Array[] {
  const out: Float32Array[] = []
  let t = 0
  for (const f of frames) {
    out.push(f)
    t += (f.length / rate) * 1000
    if (t >= keepMs) break
  }
  return out
}

function toWav(frames: Float32Array[], inRate: number): Blob {
  let n = 0
  for (const f of frames) n += f.length
  const all = new Float32Array(n)
  let o = 0
  for (const f of frames) { all.set(f, o); o += f.length }
  const ratio = inRate / TARGET_RATE
  const outLen = Math.floor(all.length / ratio)
  const pcm = new Int16Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio
    const i0 = Math.floor(pos)
    const frac = pos - i0
    const s = all[i0] * (1 - frac) + (all[Math.min(i0 + 1, all.length - 1)] ?? 0) * frac
    pcm[i] = Math.max(-1, Math.min(1, s)) * 0x7fff
  }
  const buf = new ArrayBuffer(44 + pcm.length * 2)
  const v = new DataView(buf)
  const str = (off: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)) }
  str(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ')
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, TARGET_RATE, true); v.setUint32(28, TARGET_RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true)
  str(36, 'data'); v.setUint32(40, pcm.length * 2, true)
  new Int16Array(buf, 44).set(pcm)
  return new Blob([buf], { type: 'audio/wav' })
}

export function useRecorder(): Recorder {
  const stream = useRef<MediaStream | null>(null)
  const ctx = useRef<AudioContext | null>(null)
  const ring = useRef<{ f: Float32Array; ms: number }[]>([])
  const floor = useRef(0.01)
  const finish = useRef<((keep: boolean) => void) | null>(null)
  const sink = useRef<((f: Float32Array, rms: number, ms: number, now: number) => void) | null>(null)
  const watcher = useRef<((rms: number, ms: number, now: number) => void) | null>(null)
  const gen = useRef(0)   // bumped by every record()/cancel(): an older, still-starting recording gives up
  const starting = useRef<Promise<void> | null>(null)
  const bins = useRef<number[]>([])                   // loudness of each recent 100 ms
  const bin = useRef({ sum: 0, n: 0, ms: 0 })
  const ambient = useRef(0)                           // 90th percentile of the bins: how loud the background gets
  const recording = useRef(false)

  const onFrame = useCallback((f: Float32Array) => {
    if (!ctx.current) return
    const ms = (f.length / ctx.current.sampleRate) * 1000
    let sum = 0
    for (let i = 0; i < f.length; i++) sum += f[i] * f[i]
    const rms = Math.sqrt(sum / f.length)
    // the room's noise level: follows quiet moments down quickly, creeps up slowly (so steady background sound raises the gate, speech does not)
    floor.current += (rms - floor.current) * (rms < floor.current ? 1 - Math.exp(-ms / 300) : 1 - Math.exp(-ms / 16000))
    const now = performance.now()
    if (!recording.current) {                                  // the background level is learned only while nobody is being recorded
      const b = bin.current
      for (let i = 0; i < f.length; i++) b.sum += f[i] * f[i]
      b.n += f.length; b.ms += ms
      if (b.ms >= BIN_MS) {
        bins.current.push(Math.sqrt(b.sum / b.n))
        if (bins.current.length > AMBIENT_MS / BIN_MS) bins.current.shift()
        const s = [...bins.current].sort((x, y) => x - y)
        ambient.current = s[Math.floor(s.length * 0.9)] ?? 0
        bin.current = { sum: 0, n: 0, ms: 0 }
      }
    }
    ring.current.push({ f, ms })
    let total = 0
    for (const r of ring.current) total += r.ms
    while (total > RING_MS && ring.current.length) total -= ring.current.shift()!.ms
    sink.current?.(f, rms, ms, now)
    watcher.current?.(rms, ms, now)
  }, [])

  const ensure = useCallback(async () => {
    if (!starting.current) {
      starting.current = (async () => {
        const constraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1, voiceIsolation: true } as MediaTrackConstraints
        stream.current = await navigator.mediaDevices.getUserMedia({ audio: constraints })
        const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
        const c = new AC()
        ctx.current = c
        const src = c.createMediaStreamSource(stream.current)
        const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 120; hp.Q.value = 0.7
        const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 5200; lp.Q.value = 0.7
        const url = URL.createObjectURL(new Blob([TAP_MODULE], { type: 'text/javascript' }))
        await c.audioWorklet.addModule(url)
        URL.revokeObjectURL(url)
        const tap = new AudioWorkletNode(c, 'spark-tap')
        tap.port.onmessage = (e: MessageEvent<Float32Array>) => onFrame(e.data)
        const mute = c.createGain(); mute.gain.value = 0
        src.connect(hp); hp.connect(lp); lp.connect(tap); tap.connect(mute); mute.connect(c.destination)
      })().catch((e) => { starting.current = null; throw e })
    }
    await starting.current
    if (ctx.current?.state === 'suspended') await ctx.current.resume()
  }, [onFrame])

  const record = useCallback(async (onLevel: (level: number) => void, opts: RecordOptions = {}) => {
    finish.current?.(false)                  // never two recordings at once
    const my = ++gen.current
    await ensure()
    if (my !== gen.current) return null
    const preRoll = opts.preRollMs ?? 0
    if (!preRoll) {
      await new Promise((r) => window.setTimeout(r, SETTLE_MS))
      if (my !== gen.current) return null
      // Straight after a page load nothing is known about the room yet: listen to it for up to 1.5 s first, so a television is recognised as background
      const known = () => bins.current.length * BIN_MS
      for (let waited = 0; known() < 1500 && waited < 1500; waited += 100) {
        await new Promise((r) => window.setTimeout(r, 100))
        if (my !== gen.current) return null
      }
    }
    const rate = ctx.current!.sampleRate
    const frames: Float32Array[] = []
    if (preRoll) {                            // sound from just before now: the start of what the customer said while Spark was still talking
      let have = 0
      const take: Float32Array[] = []
      for (let i = ring.current.length - 1; i >= 0 && have < preRoll; i--) { take.unshift(ring.current[i].f); have += ring.current[i].ms }
      frames.push(...take)
    }
    const startedAt = performance.now()
    const room = ambient.current                  // the background level as it was just before this answer; frozen while recording
    recording.current = true
    let runMs = preRoll ? RUN_MS : 0              // current stretch of unbroken talking
    let runEnd = 0
    let speechMs = preRoll ? MIN_SPEECH_MS : 0   // an interruption was already judged to be speech
    let lastVoice = preRoll ? startedAt : 0
    let heard = !!preRoll
    let lastLevel = 0
    let elapsedMs = 0          // sound captured so far, counting the pre-roll
    let voiceEndMs = 0         // ... up to the last moment of speech, so the quiet at the end is not sent
    for (const f of frames) elapsedMs += (f.length / rate) * 1000
    voiceEndMs = elapsedMs

    return new Promise<Blob | null>((resolve) => {
      let done = false
      const end = (keep: boolean) => {
        if (done) return
        done = true
        recording.current = false
        sink.current = null
        finish.current = null
        onLevel(0)
        resolve(keep && heard && speechMs >= MIN_SPEECH_MS ? toWav(trimTail(frames, rate, voiceEndMs + TAIL_KEEP_MS), rate) : null)
      }
      finish.current = end
      sink.current = (f, rms, ms, now) => {
        frames.push(f)
        elapsedMs += ms
        const gate = Math.max(MIN_GATE, floor.current * GATE_FACTOR, room * AMBIENT_FACTOR)
        if (now - lastLevel > 50) { lastLevel = now; onLevel(Math.min(1, rms * 9)) }
        if (rms > gate) {
          if (now - runEnd > RUN_GAP_MS) runMs = 0   // a new stretch: earlier blips do not count towards it
          runMs += ms
          runEnd = now
          speechMs += ms
          lastVoice = now
          voiceEndMs = elapsedMs
          if (speechMs >= MIN_SPEECH_MS && runMs >= RUN_MS) heard = true
        }
        const endSilence = opts.endSilenceMs ?? (speechMs < QUICK_ANSWER_MS ? SILENCE_END_QUICK_MS : SILENCE_END_MS)
        if (heard && now - lastVoice > endSilence) end(true)
        else if (!heard && now - startedAt > GIVE_UP_MS) end(false)
        else if (now - startedAt > MAX_MS) end(true)
      }
    })
  }, [ensure])

  const watch = useCallback((onSpeech: () => void) => {
    let on = true
    const begun = performance.now()
    let talkMs = 0
    let lastLoud = 0
    void ensure().then(() => {
      if (!on) return
      watcher.current = (rms, ms, now) => {
        if (now - begun < BARGE_GRACE_MS) return
        const gate = Math.max(BARGE_GATE, floor.current * BARGE_FACTOR, ambient.current * 2.2)
        if (rms > gate) { talkMs += ms; lastLoud = now } else if (now - lastLoud > 160) talkMs = 0
        if (talkMs >= BARGE_MS) { on = false; watcher.current = null; onSpeech() }
      }
    }).catch(() => { /* no microphone: nothing to watch */ })
    return () => { on = false; watcher.current = null }
  }, [ensure])

  const stop = useCallback(() => finish.current?.(true), [])
  const cancel = useCallback(() => { gen.current++; finish.current?.(false) }, [])
  const release = useCallback(() => {
    gen.current++
    finish.current?.(false)
    watcher.current = null
    stream.current?.getTracks().forEach((t) => t.stop())
    stream.current = null
    void ctx.current?.close()
    ctx.current = null
    starting.current = null
    ring.current = []
  }, [])

  useEffect(() => release, [release])
  return { record, watch, stop, cancel, release }
}
