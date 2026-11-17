import { useRef, useState, type CSSProperties, type FormEvent, type PointerEvent } from 'react'
import { SparkScene } from '../components/SparkScene'
import { SparkWordmark } from '../components/SparkWordmark'
import { ThemeToggle } from '../components/ThemeToggle'
import { LangSwitch } from '../components/LangSwitch'
import { strings, type Lang } from '../i18n/strings'
import type { Theme } from '../hooks/useTheme'

interface Props {
  lang: Lang
  onLang: (l: Lang) => void
  onLogin: (policyNo: string, dob: string) => Promise<void>
  theme: Theme
  onToggleTheme: () => void
  notice?: string | null
}

const delay = (step: number): CSSProperties => ({ animationDelay: `${0.05 + step * 0.06}s` })

export function LoginScreen({ lang, onLang, onLogin, theme, onToggleTheme, notice }: Props) {
  const t = strings(lang)
  const [policyNo, setPolicyNo] = useState('')
  const [dob, setDob] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [typing, setTyping] = useState(false)
  const screen = useRef<HTMLDivElement>(null)

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const el = screen.current
    if (!el) return
    el.style.setProperty('--px', ((e.clientX / window.innerWidth) * 2 - 1).toFixed(3))
    el.style.setProperty('--py', ((e.clientY / window.innerHeight) * 2 - 1).toFixed(3))
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await onLogin(policyNo.trim(), dob)
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t.errorGeneric)
      setBusy(false)
    }
  }

  return (
    <div ref={screen} className={`auth-screen${typing ? ' is-typing' : ''}${busy ? ' is-busy' : ''}`} onPointerMove={onPointerMove}>
      <SparkScene />
      <div className="auth-screen__overlay" />
      <ThemeToggle theme={theme} onToggle={onToggleTheme} className="auth-screen__theme" />
      <div className="auth-card" onFocus={() => setTyping(true)} onBlur={() => setTyping(false)}>
        <div className="auth-card__inner">
          <SparkWordmark className="auth-card__brand auth-stagger" height={22} />
          <h2 className="auth-stagger" style={delay(0)}>{t.welcome}</h2>
          <p className="auth-card__sub auth-stagger" style={delay(1)}>{t.loginSub}</p>
          <div className="auth-stagger" style={delay(1)}><LangSwitch value={lang} onChange={onLang} label={t.language} /></div>
          {notice && <p className="auth-card__notice">{notice}</p>}
          <form className="auth-form" onSubmit={submit}>
            <label className="auth-field auth-stagger" style={delay(2)}>
              <span>{t.policyNo}</span>
              <input value={policyNo} onChange={(e) => setPolicyNo(e.target.value)} placeholder="SG-NF-100234" required autoComplete="off" autoCapitalize="characters" spellCheck={false} />
            </label>
            <label className="auth-field auth-stagger" style={delay(3)}>
              <span>{t.dob}</span>
              <input type="date" value={dob} onChange={(e) => setDob(e.target.value)} required max={new Date().toISOString().slice(0, 10)} />
            </label>
            {error && <p className="auth-form__error" role="alert">{error}</p>}
            <button className="auth-submit auth-stagger" style={delay(4)} type="submit" disabled={busy}>{busy ? t.signingIn : t.signIn}</button>
          </form>
        </div>
      </div>
    </div>
  )
}
