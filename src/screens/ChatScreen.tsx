import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import * as api from '../api/client'
import type { Turn } from '../api/client'
import { SparkBot, type SparkMode } from '../components/SparkBot'
import { SparkWordmark } from '../components/SparkWordmark'
import { ThemeToggle } from '../components/ThemeToggle'
import { Segmented } from '../components/Segmented'
import { LANGS, strings, type Lang } from '../i18n/strings'
import { useRecorder } from '../hooks/useRecorder'
import { useSpeaker } from '../hooks/useSpeaker'
import type { Theme } from '../hooks/useTheme'

interface Msg { id: number; who: 'spark' | 'you'; text: string; qkey?: string; decision?: string | null; stored?: boolean }
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
  const [begun, setBegun] = useState(false)   // Spark only starts once the person taps Start (also lets the browser play sound)
  const [phase, setPhase] = useState<Phase>('idle')
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

  const pendingYou = useRef<number | null>(null)   // the customer's bubble that is on screen already, waiting for Spark's reading of it
  const dropPending = useCallback(() => {
    const id = pendingYou.current
    pendingYou.current = null
    if (id != null) setMsgs((prev) => prev.filter((m) => m.id !== id))
  }, [])

  const push = useCallback((m: Omit<Msg, 'id'>) => setMsgs((prev) => [...prev, { ...m, id: nextId.current++ }]), [])

  useEffect(() => { recorder.setSparkSpeaking(phase === 'speaking') }, [phase, recorder])

  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' }) }, [msgs, phase])

  const fail = useCallback((e: unknown) => {
    if (e instanceof api.ApiError && e.status === 401) { onUnauthorized(); return }
    setError(e instanceof Error && e.message ? e.message : strings(langRef.current).errorGeneric)
    setPhase('idle')
  }, [onUnauthorized])

  // ── Spark asks, then listens ──────────────────────────────────────────────────
  const listen = useCallback(async (tn: Turn, my: number, preRollMs?: number) => {
    const q = tn.question
    if (!q || my !== run.current) return
    if (!voiceRef.current) { setPhase('idle'); return }
    setPhase('listening')
    let blob: Blob | null
    try {
      blob = await recorder.record(setLevel, { preRollMs, endSilenceMs: q.type === 'OPEN_TEXT' ? 1600 : undefined })
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
      // two steps so the customer's words appear as soon as they are transcribed, not after the answer has also been worked out
      const text = (await api.transcribe(token, sid, blob)).trim()
      if (new URLSearchParams(window.location.search).has('lab')) ((window as unknown as { __rec?: unknown[] }).__rec ??= []).push({ t: Date.now(), ev: 'transcript', text, bytes: blob.size })
      if (my !== run.current) return
      if (!text) {
        noSpeechCount.current += 1
        if (noSpeechCount.current >= 2) { setPhase('idle'); return }
        await ask(tn, { lead: 'noSpeech', skipQuestion: true })
        return
      }
      const bid = nextId.current++
      pendingYou.current = bid
      setMsgs((prev) => [...prev, { id: bid, who: 'you', text, stored: false }])
      const next = await api.sendAnswer(token, sid, q.key, text, 'VOICE')
      if (my !== run.current) return
      await handleResult(next)
    } catch (e) { dropPending(); fail(e) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, sid, recorder, fail])

  /** Speaks a line. If the customer starts talking over it, Spark stops at once and the customer's words are taken (returns true). */
  const sayWatched = useCallback(async (what: string, text: string, L: string, my: number) => {
    if (!voiceRef.current) { await speaker.say(what, text, L); return false }
    let hit = false
    const off = recorder.watch(() => { hit = true; speaker.stop() })
    try { await speaker.say(what, text, L) } finally { off() }
    return hit && my === run.current
  }, [speaker, recorder])

  const ask = useCallback(async (tn: Turn, opts: { lead?: 'greeting' | 'clarify' | 'noSpeech' | 'reply'; skipQuestion?: boolean; reuseBubble?: boolean } = {}) => {
    const my = ++run.current
    recorder.cancel()
    setError(null)
    setPhase('speaking')
    const L = langRef.current
    if (opts.lead) {
      const text = tn.phrases[opts.lead]
      push({ who: 'spark', text })
      const cut = await sayWatched(opts.lead, text, L, my)
      // Cutting in on the greeting just moves on to the first question; for any other line the customer's words are taken as the answer
      if (cut && opts.lead !== 'greeting') { await listen(tn, my, 1600); return }
      if (my !== run.current) return
    }
    if (!opts.skipQuestion && tn.question) {
      if (!opts.reuseBubble) push({ who: 'spark', text: tn.question.text, qkey: tn.question.key })
      if (await sayWatched('question', tn.question.text, L, my)) { await listen(tn, my, 1600); return }
      if (my !== run.current) return
    }
    await listen(tn, my)
  }, [recorder, speaker, push, listen, sayWatched])

  const handleResult = useCallback(async (next: Turn) => {
    setTurn(next)
    if (next.language && next.language !== langRef.current) { langRef.current = next.language as Lang; onLang(next.language as Lang) }   // the customer picked another language: carry on in it
    if (next.noSpeech) {
      dropPending()
      noSpeechCount.current += 1
      if (noSpeechCount.current >= 2) { setPhase('idle'); return }
      await ask(next, { lead: 'noSpeech', skipQuestion: true })
      return
    }
    noSpeechCount.current = 0
    if (next.heard) {
      const id = pendingYou.current
      pendingYou.current = null
      if (id != null) setMsgs((prev) => prev.map((m) => (m.id === id ? { ...m, text: next.heard!, decision: next.decision, stored: !next.repeat } : m)))
      else push({ who: 'you', text: next.heard, decision: next.decision, stored: !next.repeat })
    }
    if (next.status === 'COMPLETED') {
      const my = ++run.current
      setPhase('speaking')
      push({ who: 'spark', text: next.phrases.thanks })
      await speaker.say('thanks', next.phrases.thanks, langRef.current)
      if (my === run.current) onComplete(next)
      return
    }
    await ask(next, next.repeat ? { lead: next.phrases.reply ? 'reply' : 'clarify' } : {})
  }, [ask, push, speaker, onComplete, onLang, dropPending])

  // First turn: greet (unless the customer is coming back part-way through), then ask.
  useEffect(() => {
    if (!begun || started.current) return
    started.current = true
    setPhase('speaking')
    const midway = (initial.question?.number ?? 1) > 1
    void ask(initial, midway ? {} : { lead: 'greeting' })
    return () => { run.current++; recorder.cancel(); speaker.stop() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [begun])

  // ── what the person does ──────────────────────────────────────────────────────
  async function submitText(text: string, source: 'TEXT' | 'BUTTON', choice?: string) {
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

  /** The customer says their last answer was wrong: take it back and ask the same question again. */
  async function changeLast() {
    if (phase === 'thinking') return
    run.current++                               // stop speaking / listening, and ignore anything still on its way
    recorder.cancel()
    speaker.stop()
    setDraft('')
    setError(null)
    setPhase('thinking')
    try {
      const next = await api.undo(token, sid)
      setTurn(next)
      noSpeechCount.current = 0
      const key = next.question?.key
      const at = key ? msgs.findIndex((m) => m.who === 'spark' && m.qkey === key) : -1
      setMsgs((prev) => (at >= 0 ? prev.slice(0, at + 1) : prev.slice(0, prev.findIndex((m) => m.who === 'you' && m.stored) >= 0 ? prev.findIndex((m) => m.who === 'you' && m.stored) : prev.length)))
      await ask(next, { reuseBubble: at >= 0 })
    } catch (e) { fail(e) }
  }

  function onSubmit(e: FormEvent) { e.preventDefault(); void submitText(draft, 'TEXT') }

  function orbTap() {
    if (phase === 'listening') recorder.stop()
    else if (phase === 'idle' && turn.question) { setVoiceOn(true); voiceRef.current = true; noSpeechCount.current = 0; void listen(turn, ++run.current) }
    else if (phase === 'speaking') { run.current++; speaker.stop(); void listen(turn, run.current) }
  }

  async function changeLanguage(l: Lang) {
    if (l === lang || phase === 'thinking') return
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
    if (phase === 'thinking') return
    const on = !voiceOn
    setVoiceOn(on)
    voiceRef.current = on
    if (!on) { run.current++; recorder.cancel(); speaker.stop(); setPhase('idle') }
    else if (turn.question) { setMicBlocked(false); noSpeechCount.current = 0; void listen(turn, ++run.current) }
  }

  const mode: SparkMode = phase === 'speaking' ? 'speaking' : phase === 'listening' ? 'listening' : phase === 'thinking' ? 'thinking' : 'idle'
  const status = phase === 'speaking' ? t.speaking : phase === 'listening' ? t.listening : phase === 'thinking' ? t.thinking : turn.question ? t.tapToSpeak : ''
  const q = turn.question
  const lastHeard = (() => { const m = [...msgs].reverse().find((x) => x.who === 'you'); return m && m.decision === 'UNCLEAR' ? m : undefined })()
  const lastStored = [...msgs].reverse().find((m) => m.who === 'you' && m.stored)?.id
  const decisionLabel = (d?: string | null) => (d === 'YES' ? t.understoodYes : d === 'NO' ? t.understoodNo : d === 'UNCLEAR' ? t.understoodUnclear : '')

  return (
    <div className="ios ios-chat">
      <header className="ios-nav ios-nav--wide">
        <SparkWordmark height={20} />
        <div className="ios-nav__actions">
          <Segmented className="ios-seg--compact" value={lang} onChange={(l) => void changeLanguage(l)} label={t.language} options={LANGS.map((l) => ({ value: l.code, label: l.label, title: l.long }))} />
          <ThemeToggle theme={theme} onToggle={onToggleTheme} className="ios-round" />
          <button className="ios-textbtn" type="button" onClick={onSignOut}>{t.signOut}</button>
        </div>
      </header>

      {!begun ? (
        <main className="ios-start">
          <img src="/aia-spark-bot.png" alt="" className="ios-hero__bot" width="200" height="212" />
          <h1 className="ios-title">{t.startChat}</h1>
          <p className="ios-lede">{t.startChatSub}</p>
          <button type="button" className="ios-button" onClick={() => setBegun(true)} autoFocus>{t.startChat}</button>
        </main>
      ) : (
      <main className="cb">
        <section className="cb-call" aria-live="polite">
          <div className="cb-call__top">
            <span className={`cb-live cb-live--${mode}`}>{q ? `${t.question} ${q.number}` : t.transcript}</span>
            <button type="button" className={`ios-voice${voiceOn ? ' is-on' : ''}`} onClick={toggleVoice}>{voiceOn ? t.micOn : t.micOff}</button>
          </div>
          <button type="button" className="ios-orb" onClick={orbTap} aria-label={status || t.tapToSpeak}>
            <SparkBot mode={mode} level={level} label="Spark" />
          </button>
          <p className="ios-status">{status}</p>
        </section>

        <section className="cb-card" aria-label={t.question}>
          <p className="cb-q" key={q?.key ?? 'none'}>{q ? q.text : ''}</p>
          {lastHeard && (
            <p className="cb-heard">
              <span>{t.you}</span> {lastHeard.text}
              {lastHeard.decision && lastHeard.decision !== 'TEXT' && decisionLabel(lastHeard.decision) && <b>{decisionLabel(lastHeard.decision)}</b>}
            </p>
          )}
          {micBlocked && <p className="ios-note">{t.micBlocked}</p>}
          {error && <p className="ios-note ios-note--error" role="alert">{error}</p>}
          <div className="ios-composer">
            {q && q.options?.length > 0 && (
              <div className="ios-quick ios-quick--choice">
                {q.options.map((o) => (
                  <button type="button" key={o.key} onClick={() => void submitText(o.text, 'BUTTON', o.key)} disabled={phase === 'thinking'}>{o.key}) {o.text}</button>
                ))}
              </div>
            )}
            {q && q.type !== 'OPEN_TEXT' && !(q.options?.length > 0) && (
              <div className="ios-quick">
                <button type="button" className="is-yes" onClick={() => void submitText(t.yes, 'BUTTON', 'YES')} disabled={phase === 'thinking'}>{t.yes}</button>
                <button type="button" className="is-no" onClick={() => void submitText(t.no, 'BUTTON', 'NO')} disabled={phase === 'thinking'}>{t.no}</button>
              </div>
            )}
            <form className="ios-compose" onSubmit={onSubmit}>
              <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={t.typeAnswer} disabled={!q || phase === 'thinking'} maxLength={1000} aria-label={t.typeAnswer} />
              <button type="submit" aria-label={t.send} disabled={!q || !draft.trim() || phase === 'thinking'}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 20V5M5 11.5 12 4.5l7 7" /></svg>
              </button>
            </form>
          </div>
        </section>

        <section className="cb-transcript" aria-label={t.transcript}>
          <h2>{t.transcript}</h2>
          <div className="ios-msgs" ref={listRef}>
            {msgs.map((m) => (
              <div key={m.id} className={`ios-msg ios-msg--${m.who}`}>
                <p className="ios-bubble">{m.text}</p>
                {m.who === 'you' && ((m.decision && m.decision !== 'TEXT' && decisionLabel(m.decision)) || (m.id === lastStored && phase !== 'thinking')) && (
                  <span className="ios-receipt">
                    {m.decision && m.decision !== 'TEXT' ? decisionLabel(m.decision) : ''}
                    {m.id === lastStored && phase !== 'thinking' && <button type="button" className="ios-change" onClick={() => void changeLast()}>{t.change}</button>}
                  </span>
                )}
              </div>
            ))}
            {phase === 'thinking' && <div className="ios-msg ios-msg--spark" aria-hidden="true"><p className="ios-bubble ios-dots"><i /><i /><i /></p></div>}
          </div>
        </section>
      </main>
      )}
    </div>
  )
}
