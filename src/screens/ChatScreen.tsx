import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import * as api from '../api/client'
import type { Turn } from '../api/client'
import { SparkBot, type SparkMode } from '../components/SparkBot'
import { SparkWordmark } from '../components/SparkWordmark'
import { ThemeToggle } from '../components/ThemeToggle'
import { LangSwitch } from '../components/LangSwitch'
import { strings, type Lang } from '../i18n/strings'
import { useRecorder } from '../hooks/useRecorder'
import { useSpeaker } from '../hooks/useSpeaker'
import type { Theme } from '../hooks/useTheme'

interface Msg { id: number; who: 'spark' | 'you'; text: string; qkey?: string; decision?: string | null }
type Phase = 'speaking' | 'listening' | 'thinking' | 'idle'

interface Props {
  token: string
  initial: Turn
  lang: Lang
  onLang: (l: Lang) => void
  theme: Theme
  onToggleTheme: () => void
  onComplete: (t: Turn) => void
  onSignOut: () => void
  onUnauthorized: () => void
}

export function ChatScreen({ token, initial, lang, onLang, theme, onToggleTheme, onComplete, onSignOut, onUnauthorized }: Props) {
  const t = strings(lang)
  const sid = initial.sessionId
  const recorder = useRecorder()
  const speaker = useSpeaker(token, sid)
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [turn, setTurn] = useState<Turn>(initial)
  const [phase, setPhase] = useState<Phase>('speaking')
  const [level, setLevel] = useState(0)
  const [voiceOn, setVoiceOn] = useState(true)
  const [micBlocked, setMicBlocked] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const run = useRef(0)                 // bumped to cancel whatever Spark is doing (speaking, listening) when something new happens
  const nextId = useRef(1)
  const noSpeechCount = useRef(0)
  const voiceRef = useRef(true)
  const langRef = useRef(lang)
  const listRef = useRef<HTMLDivElement>(null)
  const started = useRef(false)
  voiceRef.current = voiceOn
  langRef.current = lang

  const push = useCallback((m: Omit<Msg, 'id'>) => setMsgs((prev) => [...prev, { ...m, id: nextId.current++ }]), [])

  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' }) }, [msgs, phase])

  const fail = useCallback((e: unknown) => {
    if (e instanceof api.ApiError && e.status === 401) { onUnauthorized(); return }
    setError(e instanceof Error && e.message ? e.message : strings(langRef.current).errorGeneric)
    setPhase('idle')
  }, [onUnauthorized])

  // ── Spark asks, then listens ──────────────────────────────────────────────────
  const listen = useCallback(async (tn: Turn, my: number) => {
    const q = tn.question
    if (!q || my !== run.current) return
    if (!voiceRef.current) { setPhase('idle'); return }
    setPhase('listening')
    let blob: Blob | null
    try {
      blob = await recorder.record(setLevel)
    } catch {
      setMicBlocked(true)
      setVoiceOn(false)
      setPhase('idle')
      return
    }
    if (my !== run.current) return
    if (!blob) {
      noSpeechCount.current += 1
      if (noSpeechCount.current >= 2) { setPhase('idle'); return }
      await ask(tn, { lead: 'noSpeech', skipQuestion: true })
      return
    }
    setPhase('thinking')
    try {
      const next = await api.sendAudio(token, sid, q.key, blob)
      if (my !== run.current) return
      await handleResult(next)
    } catch (e) { fail(e) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, sid, recorder, fail])

  const ask = useCallback(async (tn: Turn, opts: { lead?: 'greeting' | 'clarify' | 'noSpeech'; skipQuestion?: boolean } = {}) => {
    const my = ++run.current
    recorder.cancel()
    setError(null)
    setPhase('speaking')
    const L = langRef.current
    if (opts.lead) {
      const text = tn.phrases[opts.lead]
      push({ who: 'spark', text })
      await speaker.say(opts.lead, text, L)
      if (my !== run.current) return
    }
    if (!opts.skipQuestion && tn.question) {
      push({ who: 'spark', text: tn.question.text, qkey: tn.question.key })
      await speaker.say('question', tn.question.text, L)
      if (my !== run.current) return
    }
    await listen(tn, my)
  }, [recorder, speaker, push, listen])

  const handleResult = useCallback(async (next: Turn) => {
    setTurn(next)
    if (next.noSpeech) {
      noSpeechCount.current += 1
      if (noSpeechCount.current >= 2) { setPhase('idle'); return }
      await ask(next, { lead: 'noSpeech', skipQuestion: true })
      return
    }
    noSpeechCount.current = 0
    if (next.heard) push({ who: 'you', text: next.heard, decision: next.decision })
    if (next.status === 'COMPLETED') {
      const my = ++run.current
      setPhase('speaking')
      push({ who: 'spark', text: next.phrases.thanks })
      await speaker.say('thanks', next.phrases.thanks, langRef.current)
      if (my === run.current) onComplete(next)
      return
    }
    await ask(next, next.repeat ? { lead: 'clarify' } : {})
  }, [ask, push, speaker, onComplete])

  // First turn: greet (unless the customer is coming back part-way through), then ask.
  useEffect(() => {
    if (started.current) return
    started.current = true
    const midway = (initial.question?.number ?? 1) > 1
    void ask(initial, midway ? {} : { lead: 'greeting' })
    return () => { run.current++; recorder.cancel(); speaker.stop() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── what the person does ──────────────────────────────────────────────────────
  async function submitText(text: string, source: 'TEXT' | 'BUTTON', choice?: 'YES' | 'NO') {
    const q = turn.question
    if (!q || !text.trim()) return
    run.current++                               // stop speaking / listening
    recorder.cancel()
    speaker.stop()
    setDraft('')
    setError(null)
    setPhase('thinking')
    try {
      const next = await api.sendAnswer(token, sid, q.key, text.trim(), source, choice)
      await handleResult(next)
    } catch (e) { fail(e) }
  }

  function onSubmit(e: FormEvent) { e.preventDefault(); void submitText(draft, 'TEXT') }

  function orbTap() {
    if (phase === 'listening') recorder.stop()
    else if (phase === 'idle' && turn.question) { setVoiceOn(true); voiceRef.current = true; noSpeechCount.current = 0; void listen(turn, ++run.current) }
    else if (phase === 'speaking') { run.current++; speaker.stop(); void listen(turn, run.current) }
  }

  async function changeLanguage(l: Lang) {
    if (l === lang) return
    onLang(l)
    langRef.current = l
    try {
      const next = await api.setLanguage(token, sid, l)
      setTurn(next)
      // the question on screen changes language at once, and is read again
      setMsgs((prev) => prev.map((m) => (m.qkey && next.question && m.qkey === next.question.key ? { ...m, text: next.question.text } : m)))
      if (next.question) {
        const my = ++run.current
        recorder.cancel()
        setPhase('speaking')
        await speaker.say('question', next.question.text, l)
        if (my === run.current) await listen(next, my)
      }
    } catch (e) { fail(e) }
  }

  function toggleVoice() {
    const on = !voiceOn
    setVoiceOn(on)
    voiceRef.current = on
    if (!on) { run.current++; recorder.cancel(); speaker.stop(); setPhase('idle') }
    else if (turn.question) { setMicBlocked(false); noSpeechCount.current = 0; void listen(turn, ++run.current) }
  }

  const mode: SparkMode = phase === 'speaking' ? 'speaking' : phase === 'listening' ? 'listening' : phase === 'thinking' ? 'thinking' : 'idle'
  const status = phase === 'speaking' ? t.speaking : phase === 'listening' ? t.listening : phase === 'thinking' ? t.thinking : turn.question ? t.tapToSpeak : ''
  const q = turn.question
  const decisionLabel = (d?: string | null) => (d === 'YES' ? t.understoodYes : d === 'NO' ? t.understoodNo : d === 'UNCLEAR' ? t.understoodUnclear : '')

  return (
    <div className="chat">
      <header className="chat__bar">
        <SparkWordmark height={20} />
        <div className="chat__bar-right">
          <LangSwitch value={lang} onChange={(l) => void changeLanguage(l)} label={t.language} />
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
          <button className="chat__link" type="button" onClick={onSignOut}>{t.signOut}</button>
        </div>
      </header>

      <main className="chat__main">
        <section className="chat__stage" aria-live="polite">
          <button type="button" className="chat__orb" onClick={orbTap} aria-label={status || t.tapToSpeak}>
            <SparkBot mode={mode} level={level} label="Spark" />
          </button>
          <p className="chat__status">{status}</p>
          <button type="button" className={`chat__voice${voiceOn ? ' is-on' : ''}`} onClick={toggleVoice}>{voiceOn ? t.micOn : t.micOff}</button>
          {q && <p className="chat__count">{t.question} {q.number}</p>}
        </section>

        <section className="chat__thread">
          <div className="chat__list" ref={listRef}>
            {msgs.map((m) => (
              <div key={m.id} className={`bubble bubble--${m.who}`}>
                <span className="bubble__who">{m.who === 'spark' ? 'Spark' : t.you}</span>
                <p>{m.text}</p>
                {m.who === 'you' && m.decision && m.decision !== 'TEXT' && <span className={`chip chip--${m.decision.toLowerCase()}`}>{decisionLabel(m.decision)}</span>}
              </div>
            ))}
            {phase === 'thinking' && <div className="bubble bubble--spark bubble--dots" aria-hidden="true"><i /><i /><i /></div>}
          </div>

          {micBlocked && <p className="chat__note">{t.micBlocked}</p>}
          {error && <p className="chat__note chat__note--error" role="alert">{error}</p>}

          <div className="composer">
            {q && q.type !== 'OPEN_TEXT' && (
              <div className="composer__quick">
                <button type="button" onClick={() => void submitText(t.yes, 'BUTTON', 'YES')} disabled={phase === 'thinking'}>{t.yes}</button>
                <button type="button" onClick={() => void submitText(t.no, 'BUTTON', 'NO')} disabled={phase === 'thinking'}>{t.no}</button>
              </div>
            )}
            <form className="composer__form" onSubmit={onSubmit}>
              <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={t.typeAnswer} disabled={!q || phase === 'thinking'} maxLength={1000} aria-label={t.typeAnswer} />
              <button type="submit" disabled={!q || !draft.trim() || phase === 'thinking'}>{t.send}</button>
            </form>
          </div>
        </section>
      </main>
    </div>
  )
}
