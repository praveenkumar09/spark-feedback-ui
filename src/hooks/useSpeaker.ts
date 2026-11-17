import { useCallback, useEffect, useRef } from 'react'
import * as api from '../api/client'

const VOICE_LANG: Record<string, string> = { en: 'en-GB', ms: 'ms-MY', zh: 'zh-CN', ta: 'ta-IN' }

/** Plays Spark's voice (Azure speech from the server). If the server has none, the browser's own voice reads the text. */
export function useSpeaker(token: string, sessionId: string) {
  const audio = useRef<HTMLAudioElement | null>(null)
  const finishNow = useRef<(() => void) | null>(null)

  const stop = useCallback(() => {
    finishNow.current?.()
    audio.current?.pause()
    window.speechSynthesis?.cancel()
  }, [])

  const say = useCallback(async (what: string, fallbackText: string, lang: string) => {
    stop()
    let blob: Blob | null = null
    try { blob = await api.speak(token, sessionId, what) } catch { blob = null }
    await new Promise<void>((resolve) => {
      finishNow.current = resolve
      if (blob) {
        const url = URL.createObjectURL(blob)
        const a = new Audio(url)
        audio.current = a
        const done = () => { URL.revokeObjectURL(url); resolve() }
        a.onended = done
        a.onerror = done
        a.play().catch(done)
      } else if (window.speechSynthesis && fallbackText) {
        const u = new SpeechSynthesisUtterance(fallbackText)
        u.lang = VOICE_LANG[lang] ?? 'en-GB'
        u.onend = () => resolve()
        u.onerror = () => resolve()
        window.speechSynthesis.speak(u)
      } else resolve()
    })
    finishNow.current = null
  }, [token, sessionId, stop])

  useEffect(() => stop, [stop])
  return { say, stop }
}
