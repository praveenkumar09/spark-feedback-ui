import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import * as api from '../api/client'
import type { Turn } from '../api/client'
import { SparkBot, type SparkMode } from '../components/SparkBot'
import { SparkWordmark } from '../components/SparkWordmark'
import { ThemeToggle } from '../components/ThemeToggle'
import { Segmented } from '../components/Segmented'
import { LANGS, strings, type Lang } from '../i18n/strings'
import { useRecorder, type Recording } from '../hooks/useRecorder'
import * as VP from '../lib/voiceprint'
import { adapt, buildVoiceprint, consistent, extract, verify, type Features, type Voiceprint } from '../lib/voiceprint'
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

/** Debug hooks (recent verdicts and audio, kept in the page) exist only when the address has ?lab=1. */
const LAB = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('lab')

export function ChatScreen({ token, initial, lang, onLang, theme, onToggleTheme, onComplete, onSignOut, onUnauthorized }: Props) {
  const t = strings(lang)
  const sid = initial.sessionId
  const recorder = useRecorder()
  const speaker = useSpeaker(token, sid)
  // Coming back to a call that is already under way: the earlier questions and answers are shown again (they are saved on the server)
  const seed = useRef<Msg[] | null>(null)
  if (seed.current === null) {
    const out: Msg[] = []
    let id = 1
    for (const a of initial.answers ?? []) {
      out.push({ id: id++, who: 'spark', text: a.question })
      out.push({ id: id++, who: 'you', text: a.answer, decision: a.decision, stored: false })
    }
    seed.current = out
  }
  const [msgs, setMsgs] = useState<Msg[]>(seed.current)
  const [turn, setTurn] = useState<Turn>(initial)
  const [begun, setBegun] = useState(false)   // Spark only starts once the person taps Start (also lets the browser play sound)
  const [phase, setPhase] = useState<Phase>('idle')
  const [level, setLevel] = useState(0)
  const [voiceOn, setVoiceOn] = useState(true)
  const [lock, setLock] = useState<'learning' | 'on' | 'off'>('learning')   // voice lock: only the customer's own voice is accepted
  const [setup, setSetup] = useState<{ step: 1 | 2; sentence: string } | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [trouble, setTrouble] = useState(false)
  const print = useRef<Voiceprint | null>(null)
  const lockOn = useRef(true)
  const rejects = useRef(0)
  const greeted = useRef(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const resumes = useRef(0)
  const [micBlocked, setMicBlocked] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const run = useRef(0)                 // bumped to cancel whatever Spark is doing (speaking, listening) when something new happens
  const nextId = useRef((seed.current?.length ?? 0) + 1)
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

  /** Is this sound the enrolled customer? Without a voiceprint (or with the lock off) everything counts, as before. */
  const judge = useCallback((pcm: Float32Array, strictness = 1) => {
    const vp = print.current
    if (!vp || !lockOn.current) return { ok: true, f: null as Features | null, z: 0, unsure: true, frames: 0, loud: true }
    const f = extract(pcm)
    const v = verify(vp, f, strictness)
    if (LAB) {
    const lab = ((window as unknown as { __sparkLab?: { utter: Float32Array[]; vp: Voiceprint | null; VP: typeof VP } }).__sparkLab ??= { utter: [], vp: null, VP })
    lab.vp = vp; lab.utter.push(pcm); if (lab.utter.length > 40) lab.utter.shift()
    ;((lab as unknown as { log?: unknown[] }).log ??= []).push({ label: (window as unknown as { __label?: string }).__label ?? '', z: +v.z.toFixed(2), ok: v.ok, reason: v.reason, voicedMs: v.voicedMs, ms: Math.round(pcm.length / 16), path: strictness !== 1 ? 'barge' : 'listen' })
    }
    ;if (LAB) (window as unknown as { __sparkVoice?: unknown }).__sparkVoice = { ok: v.ok, unsure: v.unsure, z: +v.z.toFixed(2), dF0: +v.dF0.toFixed(2), voicedMs: v.voicedMs, reason: v.reason, selfZ: +vp.selfZ.toFixed(2), at: Date.now() }
    let sum = 0
    for (let i = 0; i < pcm.length; i += 4) sum += pcm[i] * pcm[i]
    return { ok: v.ok || v.unsure, f, z: v.z, unsure: v.unsure, frames: v.frames, loud: Math.sqrt(sum / Math.max(1, pcm.length / 4)) >= 0.04 }
  }, [])

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
    let rec: Recording | null = null
    let pre = preRollMs
    for (;;) {
      try {
        rec = await recorder.record(setLevel, { preRollMs: pre, endSilenceMs: q.type === 'OPEN_TEXT' ? 1600 : undefined })
      } catch {
        setMicBlocked(true)
        setVoiceOn(false)
        setPhase('idle')
        return
      }
      if (my !== run.current) return
      if (!rec) break
      const j = judge(rec.pcm, 1 + Math.min(0.25, Math.max(0, (rec.room - 0.02) * 10)))   // a noisy room (television) blurs the voice a little: allow more
      if (j.ok) {
        rejects.current = 0
        resumes.current = 0
        setHint(null)
        setTrouble(false)
        if (j.f && !j.unsure && print.current && j.z < print.current.selfZ * 1.3 + 0.3) print.current = adapt(print.current, j.f)   // follow the customer's voice slowly
        break
      }
      // somebody else: do not answer for them, do not even say "I couldn't hear you": keep listening for the customer.
      // Very quiet sound (Spark's own echo, a far-away voice) is dropped without any fuss.
      if (pre !== undefined) {                     // Spark was cut off by somebody who is not the customer: say it again, from the start (at most twice)
        pre = undefined
        if (resumes.current < 2) { resumes.current += 1; await ask(tn, { reuseBubble: true }); return }
      }
      if (j.loud) {
        rejects.current += 1
        setHint(strings(langRef.current).otherVoice)
        if (rejects.current >= 3) setTrouble(true)
        if (rejects.current >= 8) { rec = null; break }
      }
      pre = undefined
    }
    if (!rec) {
      noSpeechCount.current += 1
      if (noSpeechCount.current >= 2) { setPhase('idle'); return }
      await ask(tn, { lead: 'noSpeech', skipQuestion: true })
      return
    }
    const blob = rec.blob
    setPhase('thinking')
    try {
      // two steps so the customer's words appear as soon as they are transcribed, not after the answer has also been worked out
      const text = (await api.transcribe(token, sid, blob)).trim()
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
  }, [token, sid, recorder, fail, judge])

  /** Speaks a line. If the customer starts talking over it, Spark stops at once and the customer's words are taken (returns true). */
  const sayWatched = useCallback(async (what: string, text: string, L: string, my: number) => {
    if (!voiceRef.current) { await speaker.say(what, text, L); return false }
    let hit = false
    const off = recorder.watch(() => { hit = true; speaker.stop() }, (recent) => {                      // only the customer may interrupt: with so little sound to judge, be strict
      if (!print.current || !lockOn.current) return true
      const j = judge(recent, 0.45)
      return j.ok && (!j.unsure || j.frames >= 5)      // a one-word "yes" is short: judged on pitch alone (5 voiced frames or more)
    })
    try { await speaker.say(what, text, L) } finally { off() }
    return hit && my === run.current
  }, [speaker, recorder, judge])

  const ask = useCallback(async (tn: Turn, opts: { lead?: 'greeting' | 'resume' | 'clarify' | 'noSpeech' | 'reply'; skipQuestion?: boolean; reuseBubble?: boolean; noListen?: boolean } = {}) => {
    const my = ++run.current
    recorder.cancel()
    setError(null)
    setPhase('speaking')
    const L = langRef.current
    if (opts.lead) {
      const text = tn.phrases[opts.lead]
      push({ who: 'spark', text })
      if (opts.noListen) await speaker.say(opts.lead, text, L)
      else if (await sayWatched(opts.lead, text, L, my)) { await listen(tn, my, 1600); return }
      if (my !== run.current) return
    }
    if (!opts.skipQuestion && tn.question) {
      if (!opts.reuseBubble) push({ who: 'spark', text: tn.question.text, qkey: tn.question.key })
      if (await sayWatched('question', tn.question.text, L, my)) { await listen(tn, my, 1600); return }
      if (my !== run.current) return
    }
    if (opts.noListen) return
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

  // ── voice enrollment: Spark learns the customer's voice so that it can ignore everybody else ─────────────
  /** Two spoken sentences, a quality check on each, and a check that both are the same person. Returns false if cancelled or if no clear voiceprint could be made. */
  const enrollUnsafe = useCallback(async (tn: Turn, my: number, welcome = false, resuming = false): Promise<boolean> => {
    const L = langRef.current
    const ph = tn.phrases
    const leave = (ok: boolean) => { setSetup(null); setLock(print.current && lockOn.current ? 'on' : 'off'); return ok }
    if (!ph.sentence1 || !ph.enroll1) return leave(false)
    setLock('learning')
    print.current = null
    const got: Features[] = []
    const enrolled: Float32Array[] = []
    const steps: { key: 'enroll1' | 'enroll2'; sentence: string }[] = [{ key: 'enroll1', sentence: ph.sentence1 }, { key: 'enroll2', sentence: ph.sentence2 }]
    for (let i = 0; i < steps.length; i++) {
      let f: Features | null = null
      for (let attempt = 0; attempt < 3 && !f; attempt++) {
        if (my !== run.current) return leave(false)
        setSetup({ step: (i + 1) as 1 | 2, sentence: steps[i].sentence })
        setPhase('speaking')
        // the very first line is the whole welcome in one go (greeting and voice check, one bubble, one voice); the sentence is read by the customer, never by Spark
        const first = welcome && i === 0 ? (resuming ? 'welcomeBack' : 'welcome') : steps[i].key
        const key = attempt === 0 ? (ph[first] ? first : steps[i].key) : 'enrollRetry'
        push({ who: 'spark', text: ph[key] })
        if (key === 'welcome' || key === 'welcomeBack') greeted.current = true
        await speaker.say(key, ph[key], L)
        if (my !== run.current) return leave(false)
        setPhase('listening')
        let rec: Recording | null
        try { rec = await recorder.record(setLevel, { endSilenceMs: 1300, maxMs: 12000 }) } catch { setMicBlocked(true); setVoiceOn(false); return leave(false) }
        if (my !== run.current) return leave(false)
        if (!rec) continue
        if (rec.pcm.length > 11500 * 16) continue                        // never stopped talking: background sound mixed in. Ask again
        const cand = extract(rec.pcm)
        if (LAB) (window as unknown as { __sparkVoice?: unknown }).__sparkVoice = { enrollTry: { step: i + 1, attempt, voicedFrames: cand.voicedFrames, totalFrames: cand.totalFrames, pcmMs: Math.round(rec.pcm.length / 16) }, at: Date.now() }
        if (cand.voicedFrames < 60) continue                              // under about 0.6 s of clear voice: ask again
        if (i === 1 && !consistent(got[0], cand).ok) continue             // does not sound like the first sentence: somebody else joined in
        f = cand
        enrolled.push(rec.pcm)
      }
      if (!f) {
        push({ who: 'spark', text: ph.enrollFail })
        await speaker.say('enrollFail', ph.enrollFail, L)
        return leave(false)
      }
      got.push(f)
    }
    const vp = buildVoiceprint(got)
    if (!vp) {
      push({ who: 'spark', text: ph.enrollFail })
      await speaker.say('enrollFail', ph.enrollFail, L)
      return leave(false)
    }
    print.current = vp
    if (LAB) ((window as unknown as { __sparkLab?: { utter: Float32Array[]; vp: Voiceprint | null; VP: typeof VP; enroll?: Float32Array[] } }).__sparkLab ??= { utter: [], vp: null, VP }).enroll = enrolled
    if (LAB) (window as unknown as { __sparkVoice?: unknown }).__sparkVoice = { enrolled: true, selfZ: +vp.selfZ.toFixed(2), frames: vp.frames, at: Date.now() }
    push({ who: 'spark', text: ph.enrollOk })
    setSetup(null)
    setLock('on')
    await speaker.say('enrollOk', ph.enrollOk, L)
    return my === run.current
  }, [push, recorder, speaker])

  /** Whatever goes wrong while learning the voice, the conversation must carry on (without the voice lock). */
  const enroll = useCallback(async (tn: Turn, my: number, welcome = false, resuming = false): Promise<boolean> => {
    try { return await enrollUnsafe(tn, my, welcome, resuming) } catch (e) {
      console.error('Voice enrollment failed', e)
      print.current = null
      setSetup(null)
      setLock('off')
      return false
    }
  }, [enrollUnsafe])

  /** "Skip": carry on without the voice lock. */
  function skipSetup() {
    run.current++
    recorder.cancel()
    speaker.stop()
    print.current = null
    lockOn.current = false
    setSetup(null)
    setLock('off')
    void ask(turn, {})
  }

  /** Learn the voice again (e.g. a different person is now at the phone, or the room changed), then carry on with the question. */
  async function relearn() {
    if (phase === 'thinking') return
    lockOn.current = true
    setHint(null)
    setTrouble(false)
    rejects.current = 0
    const my = ++run.current
    recorder.cancel()
    speaker.stop()
    const ok = await enroll(turn, my)
    if (my !== run.current) return
    if (!ok) lockOn.current = false
    await ask(turn, {})
  }

  /** Throws this call away and begins again from the greeting. Two taps, so it cannot happen by accident. */
  async function startOver() {
    if (!confirmReset) {
      setConfirmReset(true)
      window.setTimeout(() => setConfirmReset(false), 6000)
      return
    }
    setConfirmReset(false)
    const my = ++run.current
    recorder.cancel()
    speaker.stop()
    setPhase('thinking')
    setError(null)
    try {
      const fresh = await api.restart(token, sid)
      if (my !== run.current) return
      setTurn(fresh)
      setMsgs([])
      nextId.current = 1
      print.current = null
      lockOn.current = true
      setLock('learning')
      setHint(null)
      setTrouble(false)
      rejects.current = 0
      resumes.current = 0
      noSpeechCount.current = 0
      await journey(fresh, false)
    } catch (e) { fail(e) }
  }

  function toggleLock() {
    if (lock === 'learning') return
    if (lock === 'on') { lockOn.current = false; setLock('off'); setHint(null); setTrouble(false); return }
    if (print.current) { lockOn.current = true; setLock('on'); return }
    void relearn()
  }

  /**
   * The opening journey, in one voice: a welcome (or "welcome back"), the voice check, then the questions.
   * A new call gets the full greeting; one that is already under way gets "welcome back" and carries on where it stopped.
   */
  const journey = useCallback(async (tn: Turn, resuming: boolean) => {
    greeted.current = false
    if (voiceRef.current) { try { await recorder.prepare(1200) } catch { setMicBlocked(true); setVoiceOn(false) } }   // hear the room once, before Spark speaks
    const my = ++run.current
    if (voiceRef.current) {
      await enroll(tn, my, true, resuming)                       // the welcome line itself is spoken with the voice check
      if (my !== run.current) return                             // cancelled: whoever cancelled carries on
    }
    if (!greeted.current) {                                      // no welcome was spoken (voice off, or the voice check could not start)
      await ask(tn, { lead: resuming ? 'resume' : 'greeting', skipQuestion: true, noListen: true })
    }
    await ask(tn, {})
  }, [enroll, ask, recorder])

  // First turn.
  useEffect(() => {
    if (!begun || started.current) return
    started.current = true
    void journey(initial, (initial.answers?.length ?? 0) > 0)
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
          <button className={`ios-textbtn${confirmReset ? ' is-warn' : ''}`} type="button" onClick={() => void startOver()}>{confirmReset ? t.startOverSure : t.startOver}</button>
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
            <span className="cb-call__btns">
              <button type="button" className={`cb-lock cb-lock--${lock}`} onClick={toggleLock} aria-pressed={lock === 'on'}>
                {lock === 'on' ? t.voiceLockOn : lock === 'learning' ? t.voiceLearning : t.voiceLockOff}
              </button>
              <button type="button" className={`ios-voice${voiceOn ? ' is-on' : ''}`} onClick={toggleVoice}>{voiceOn ? t.micOn : t.micOff}</button>
            </span>
          </div>
          <button type="button" className="ios-orb" onClick={orbTap} aria-label={status || t.tapToSpeak}>
            <SparkBot mode={mode} level={level} label="Spark" />
          </button>
          <p className="ios-status">{status}</p>
        </section>

        <section className="cb-card" aria-label={t.question}>
          {setup && (
            <div className="cb-setup">
              <p className="cb-setup__title">{t.voiceSetup}</p>
              <p className="cb-setup__step">{t.voiceStep.replace('{n}', String(setup.step))}</p>
              <p className="cb-q cb-q--say" key={setup.step}>{setup.sentence}</p>
              <button type="button" className="ios-textbtn" onClick={skipSetup}>{t.skip}</button>
            </div>
          )}
          {!setup && <p className="cb-q" key={q?.key ?? 'none'}>{q ? q.text : ''}</p>}
          {!setup && hint && <p className="ios-note cb-hint" role="status">{hint}</p>}
          {!setup && trouble && (
            <p className="ios-note cb-hint">{t.voiceTrouble} <button type="button" className="ios-change" onClick={() => void relearn()}>{t.relearn}</button></p>
          )}
          {!setup && lastHeard && (
            <p className="cb-heard">
              <span>{t.you}</span> {lastHeard.text}
              {lastHeard.decision && lastHeard.decision !== 'TEXT' && decisionLabel(lastHeard.decision) && <b>{decisionLabel(lastHeard.decision)}</b>}
            </p>
          )}
          {micBlocked && <p className="ios-note">{t.micBlocked}</p>}
          {error && <p className="ios-note ios-note--error" role="alert">{error}</p>}
          {!setup && <div className="ios-composer">
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
          </div>}
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
