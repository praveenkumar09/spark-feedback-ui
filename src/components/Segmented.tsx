interface Option<T extends string> { value: T; label: string; title?: string }

/** iOS segmented control: a grey track with a white thumb that slides to the chosen segment. */
export function Segmented<T extends string>({ value, options, onChange, label, className = '' }: {
  value: T
  options: Option<T>[]
  onChange: (v: T) => void
  label: string
  className?: string
}) {
  const i = Math.max(0, options.findIndex((o) => o.value === value))
  return (
    <div className={`ios-seg ${className}`.trim()} role="group" aria-label={label} style={{ gridTemplateColumns: `repeat(${options.length}, 1fr)` }}>
      <span className="ios-seg__thumb" style={{ width: `calc((100% - 4px) / ${options.length})`, transform: `translateX(${i * 100}%)` }} aria-hidden="true" />
      {options.map((o) => (
        <button key={o.value} type="button" className={o.value === value ? 'is-on' : ''} title={o.title} aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}
