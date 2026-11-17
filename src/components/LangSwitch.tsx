import { LANGS, type Lang } from '../i18n/strings'

export function LangSwitch({ value, onChange, label }: { value: string; onChange: (l: Lang) => void; label: string }) {
  return (
    <div className="lang-switch" role="group" aria-label={label}>
      {LANGS.map((l) => (
        <button key={l.code} type="button" className={value === l.code ? 'is-on' : ''} onClick={() => onChange(l.code)} title={l.long} aria-pressed={value === l.code}>
          {l.label}
        </button>
      ))}
    </div>
  )
}
