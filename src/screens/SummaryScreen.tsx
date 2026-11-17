import { SparkBot } from '../components/SparkBot'
import { SparkWordmark } from '../components/SparkWordmark'
import { ThemeToggle } from '../components/ThemeToggle'
import { Segmented } from '../components/Segmented'
import { LANGS, strings, type Lang } from '../i18n/strings'
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
    <div className="ios ios-chat">
      <header className="ios-nav ios-nav--wide">
        <SparkWordmark height={20} />
        <div className="ios-nav__actions">
          <Segmented className="ios-seg--compact" value={lang} onChange={onLang} label={t.language} options={LANGS.map((l) => ({ value: l.code, label: l.label, title: l.long }))} />
          <ThemeToggle theme={theme} onToggle={onToggleTheme} className="ios-round" />
          <button className="ios-textbtn" type="button" onClick={onSignOut}>{t.signOut}</button>
        </div>
      </header>
      <main className="ios-summary">
        <div className="ios-summary__head">
          <div className="ios-summary__bot"><SparkBot mode="done" label="Spark" /></div>
          <h1 className="ios-title">{t.summaryTitle}</h1>
          <p className="ios-lede">{t.summarySub}</p>
        </div>
        <ol className="ios-group ios-qa-list">
          {turn.answers.map((a, i) => (
            <li key={a.questionKey} className="ios-qa">
              <span className="ios-qa__n">{i + 1}</span>
              <div className="ios-qa__body">
                <p className="ios-qa__q">{a.question}</p>
                <p className="ios-qa__a">{a.answer}</p>
                {a.decision !== 'TEXT' && label(a.decision) && (
                  <div className="ios-qa__meta"><span className={`ios-chip ios-chip--${a.decision.toLowerCase()}`}>{label(a.decision)}</span></div>
                )}
              </div>
            </li>
          ))}
        </ol>
        <div className="ios-summary__foot">
          <button type="button" className="ios-button ios-button--tinted" onClick={onRestart}>{t.startAgain}</button>
          <p>{t.startAgainNote}</p>
        </div>
      </main>
    </div>
  )
}
