import { SparkBot } from '../components/SparkBot'
import { SparkWordmark } from '../components/SparkWordmark'
import { ThemeToggle } from '../components/ThemeToggle'
import { LangSwitch } from '../components/LangSwitch'
import { strings, type Lang } from '../i18n/strings'
import type { Turn } from '../api/client'
import type { Theme } from '../hooks/useTheme'

interface Props {
  turn: Turn
  lang: Lang
  onLang: (l: Lang) => void
  theme: Theme
  onToggleTheme: () => void
  onSignOut: () => void
  onRestart: () => void
}

export function SummaryScreen({ turn, lang, onLang, theme, onToggleTheme, onSignOut, onRestart }: Props) {
  const t = strings(lang)
  const label = (d: string) => (d === 'YES' ? t.yes : d === 'NO' ? t.no : d === 'UNCLEAR' ? t.understoodUnclear : '')
  return (
    <div className="chat">
      <header className="chat__bar">
        <SparkWordmark height={20} />
        <div className="chat__bar-right">
          <LangSwitch value={lang} onChange={onLang} label={t.language} />
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
          <button className="chat__link" type="button" onClick={onSignOut}>{t.signOut}</button>
        </div>
      </header>
      <main className="summary">
        <div className="summary__head">
          <div className="summary__bot"><SparkBot mode="done" label="Spark" /></div>
          <div>
            <h1>{t.summaryTitle}</h1>
            <p>{t.summarySub}</p>
          </div>
        </div>
        <ol className="summary__list">
          {turn.answers.map((a) => (
            <li key={a.questionKey} className="summary__item">
              <p className="summary__q">{a.question}</p>
              <p className="summary__a">
                <span>{a.answer}</span>
                {a.decision !== 'TEXT' && label(a.decision) && <em className={`chip chip--${a.decision.toLowerCase()}`}>{label(a.decision)}</em>}
              </p>
            </li>
          ))}
        </ol>
        <div className="summary__foot">
          <button type="button" className="summary__again" onClick={onRestart}>{t.startAgain}</button>
          <span>{t.startAgainNote}</span>
        </div>
      </main>
    </div>
  )
}
