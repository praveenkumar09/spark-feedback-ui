import { useCallback, useEffect, useRef } from 'react'

/**
 * Listens for one spoken answer. Recording starts at once; it ends about 1.4 s after the person stops talking (a quiet-room-aware gate that
 * learns the room's noise level), when stop() is called, or gives up after 10 s of silence (null = nobody spoke). The microphone stream stays
 * open between questions so the browser asks for permission only once.
 */
const SILENCE_END_MS = 1400
const GIVE_UP_MS = 10000
const MAX_MS = 30000
const MIN_SPEECH_MS = 250

export interface Recorder {
  /** Resolves with the recording, or null if nobody spoke / it was cancelled. Rejects if the microphone cannot be used. */
  record: (onLevel: (level: number) => void) => Promise<Blob | null>
  /** Ends the current recording now (keeps what was said). */
  stop: () => void
  /** Throws the current recording away. */
  cancel: () => void
  release: () => void
}

function pickMime(): string | undefined {
  for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m
  }
  return undefined
}

export function useRecorder(): Recorder {
  const stream = useRef<MediaStream | null>(null)
  const ctx = useRef<AudioContext | null>(null)
  const analyser = useRef<AnalyserNode | null>(null)
  const floor = useRef(0.01)
  const finish = useRef<((keep: boolean) => void) | null>(null)

  const ensure = useCallback(async () => {
    if (!stream.current) {
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      ctx.current = new AC()
      const src = ctx.current.createMediaStreamSource(stream.current)
      analyser.current = ctx.current.createAnalyser()
      analyser.current.fftSize = 1024
      src.connect(analyser.current)
    }
    if (ctx.current?.state === 'suspended') await ctx.current.resume()
  }, [])

  const record = useCallback(async (onLevel: (level: number) => void) => {
    await ensure()
    const mime = pickMime()
    const rec = new MediaRecorder(stream.current!, mime ? { mimeType: mime } : undefined)
    const chunks: Blob[] = []
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
    const buf = new Float32Array(analyser.current!.fftSize)
    const startedAt = performance.now()
    let speechMs = 0
    let lastVoice = 0
    let heard = false
    let keep = true

    return new Promise<Blob | null>((resolve) => {
      let done = false
      const end = (k: boolean) => {
        if (done) return
        done = true
        keep = k
        window.clearInterval(timer)
        onLevel(0)
        if (rec.state !== 'inactive') rec.stop()
        else resolve(null)
      }
      rec.onstop = () => {
        finish.current = null
        resolve(keep && heard && speechMs >= MIN_SPEECH_MS ? new Blob(chunks, { type: rec.mimeType || mime || 'audio/webm' }) : null)
      }
      finish.current = end
      rec.start()
      let prev = performance.now()
      const timer = window.setInterval(() => {
        const now = performance.now()
        const dt = now - prev
        prev = now
        analyser.current!.getFloatTimeDomainData(buf)
        let sum = 0
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
        const rms = Math.sqrt(sum / buf.length)
        // the room's noise level: drops quickly to the quietest moment, creeps up slowly
        floor.current = rms < floor.current ? rms : floor.current + (rms - floor.current) * 0.003
        const gate = Math.max(0.02, floor.current * 3)
        const voiced = rms > gate
        onLevel(Math.min(1, rms * 9))
        if (voiced) {
          speechMs += dt
          lastVoice = now
          if (speechMs >= MIN_SPEECH_MS) heard = true
        }
        if (heard && now - lastVoice > SILENCE_END_MS) end(true)
        else if (!heard && now - startedAt > GIVE_UP_MS) end(false)
        else if (now - startedAt > MAX_MS) end(true)
      }, 50)
    })
  }, [ensure])

  const stop = useCallback(() => finish.current?.(true), [])
  const cancel = useCallback(() => finish.current?.(false), [])
  const release = useCallback(() => {
    finish.current?.(false)
    stream.current?.getTracks().forEach((t) => t.stop())
    stream.current = null
    void ctx.current?.close()
    ctx.current = null
  }, [])

  useEffect(() => release, [release])
  return { record, stop, cancel, release }
}
