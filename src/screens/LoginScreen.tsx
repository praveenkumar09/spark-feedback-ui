import { useState, type CSSProperties, type FormEvent } from 'react'
import { SparkWordmark } from '../components/SparkWordmark'
import { ThemeToggle } from '../components/ThemeToggle'
import { Segmented } from '../components/Segmented'
import { LANGS, strings, type Lang } from '../i18n/strings'
import type { Theme } from '../hooks/useTheme'

interface Props {
  lang: Lang
  onLang: (l: Lang) => void
  onLogin: (policyNo: string, dob: string) => Promise<void>
  theme: Theme
  onToggleTheme: () => void
  notice?: string | null
}

const step = (n: number): CSSProperties => ({ animationDelay: `${0.04 + n * 0.07}s` })

/** The home page: an iOS-style sign-in. Large title, a segmented language control, one grouped form, one full-width button. */
export function LoginScreen({ lang, onLang, onLogin, theme, onToggleTheme, notice }: Props) {
  const t = strings(lang)
  const [policyNo, setPolicyNo] = useState('')
  const [dob, setDob] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

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
    <div className="ios ios-home">
      <header className="ios-nav">
        <SparkWordmark height={20} />
        <ThemeToggle theme={theme} onToggle={onToggleTheme} className="ios-round" />
      </header>

      <main className="ios-home__main">
        <div className="ios-hero ios-rise" style={step(0)}>
          <div className="ios-hero__glow" aria-hidden="true" />
          <img src="/aia-spark-bot.png" alt="" className="ios-hero__bot" width="200" height="212" />
        </div>

        <h1 className="ios-title ios-rise" style={step(1)}>{t.welcome}</h1>
        <p className="ios-lede ios-rise" style={step(2)}>{t.loginSub}</p>

        <Segmented className="ios-rise" value={lang} onChange={onLang} label={t.language} options={LANGS.map((l) => ({ value: l.code, label: l.label, title: l.long }))} />

        {notice && <p className="ios-banner" role="status">{notice}</p>}

        <form className="ios-form" onSubmit={submit}>
          <div className="ios-group ios-rise" style={step(4)}>
            <label className="ios-row">
              <span className="ios-row__label">{t.policyNo}</span>
              <input value={policyNo} onChange={(e) => setPolicyNo(e.target.value.toUpperCase())} placeholder="L123456789" required maxLength={10} pattern="[A-Za-z][0-9]{9}" title="L123456789" autoComplete="off" autoCapitalize="characters" spellCheck={false} />
            </label>
            <label className="ios-row">
              <span className="ios-row__label">{t.dob}</span>
              <input type="date" value={dob} onChange={(e) => setDob(e.target.value)} required max={new Date().toISOString().slice(0, 10)} />
            </label>
          </div>
          {error && <p className="ios-error" role="alert">{error}</p>}
          <button className="ios-button ios-rise" style={step(5)} type="submit" disabled={busy}>
            {busy && <span className="ios-spinner" aria-hidden="true" />}
            {busy ? t.signingIn : t.signIn}
          </button>
        </form>
      </main>
    </div>
  )
}
