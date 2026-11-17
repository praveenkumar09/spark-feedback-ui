import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import * as api from '../api/client'
import type { AdminAnswer, AdminCustomer, AdminResponse } from '../api/client'
import { SparkWordmark } from '../components/SparkWordmark'
import { ThemeToggle } from '../components/ThemeToggle'
import { Segmented } from '../components/Segmented'
import type { Theme } from '../hooks/useTheme'

const KEY = 'sf-admin'
type StatusFilter = 'ALL' | 'COMPLETED' | 'IN_PROGRESS' | 'RESTARTED'

const STATUS_LABEL: Record<string, string> = { COMPLETED: 'Completed', IN_PROGRESS: 'In progress', RESTARTED: 'Restarted' }
const SOURCE_LABEL: Record<string, string> = { VOICE: 'Voice', TEXT: 'Typed', BUTTON: 'Tapped' }

const fmt = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('')
/** Time actually spent answering: the gaps between consecutive answers, leaving out any pause longer than 5 minutes (the customer stepped away). */
const IDLE_MS = 5 * 60 * 1000
const activeTime = (answers: AdminAnswer[]) => {
  const at = answers.map((a) => new Date(a.answeredAt).getTime()).sort((x, y) => x - y)
  let ms = 0
  for (let i = 1; i < at.length; i++) if (at[i] - at[i - 1] <= IDLE_MS) ms += at[i] - at[i - 1]
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

/** CSV cells that start with = + - @ would run as formulas in Excel; a leading apostrophe keeps them as text. */
function cell(v: unknown) {
  let s = v == null ? '' : String(v)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return `"${s.replace(/"/g, '""')}"`
}

function exportCsv(rows: AdminResponse[]) {
  const head = ['response', 'status', 'policy_no', 'customer', 'product', 'channel', 'language', 'started', 'finished', 'question_key', 'question', 'answer', 'decision', 'source', 'confidence']
  const lines = [head.map(cell).join(',')]
  for (const r of rows) {
    for (const a of r.answers) {
      lines.push([r.id, r.status, r.policyNo, r.holderName, r.productName, r.channel, r.language, r.startedAt, r.finishedAt, a.key, a.question, a.answer, a.decision, a.source, a.confidence].map(cell).join(','))
    }
  }
  const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `spark-feedback-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

function Pill({ status }: { status: string }) {
  return <span className={`ios-pill ios-pill--${status.toLowerCase()}`}>{STATUS_LABEL[status] ?? status}</span>
}

function AnswerRow({ a, n }: { a: AdminAnswer; n: number }) {
  const d = a.decision.toUpperCase()
  return (
    <li className="ios-qa">
      <span className="ios-qa__n">{n}</span>
      <div className="ios-qa__body">
        <p className="ios-qa__q">{a.question}</p>
        <p className="ios-qa__a">{a.answer}</p>
        <div className="ios-qa__meta">
          {(d === 'YES' || d === 'NO') && <span className={`ios-chip ios-chip--${d.toLowerCase()}`}>{d === 'YES' ? 'Yes' : 'No'}</span>}
          <span>{SOURCE_LABEL[a.source] ?? a.source}</span>
          {a.confidence != null && a.source !== 'BUTTON' && <span>{Math.round(a.confidence * 100)}% sure</span>}
          <span>{a.language.toUpperCase()}</span>
        </div>
      </div>
    </li>
  )
}

function Detail({ r, onBack }: { r: AdminResponse; onBack: () => void }) {
  return (
    <article className="ios-detail">
      <button className="ios-back" type="button" onClick={onBack}>
        <svg width="10" height="17" viewBox="0 0 10 17" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8.5 1.5 2 8.5l6.5 7" /></svg>
        Responses
      </button>
      <div className="ios-detail__head">
        <span className="ios-avatar ios-avatar--lg">{initials(r.holderName)}</span>
        <div>
          <h2>{r.holderName}</h2>
          <p>{r.policyNo} · {r.productName}</p>
        </div>
        <Pill status={r.status} />
      </div>

      <dl className="ios-facts">
        <div><dt>Channel</dt><dd>{r.channel}</dd></div>
        <div><dt>Language</dt><dd>{r.language.toUpperCase()}</dd></div>
        <div><dt>First answer</dt><dd>{fmt(r.startedAt)}</dd></div>
        <div><dt>Last answer</dt><dd>{fmt(r.finishedAt)}</dd></div>
        <div><dt>Active time</dt><dd>{activeTime(r.answers)}</dd></div>
        <div><dt>Answers</dt><dd>{r.answers.length}</dd></div>
      </dl>

      <h3 className="ios-section">Answers</h3>
      <ol className="ios-group ios-qa-list">{r.answers.map((a, i) => <AnswerRow key={a.key} a={a} n={i + 1} />)}</ol>
    </article>
  )
}

function Tile({ value, label, tone }: { value: string | number; label: string; tone?: string }) {
  return <div className={`ios-tile${tone ? ` ios-tile--${tone}` : ''}`}><b>{value}</b><span>{label}</span></div>
}

function AdminLogin({ theme, onToggleTheme, onToken }: { theme: Theme; onToggleTheme: () => void; onToken: (t: string) => void }) {
  const [pw, setPw] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try { onToken(await api.adminLogin(pw)) } catch (err) { setError(err instanceof Error && err.message ? err.message : 'Could not sign in.'); setBusy(false) }
  }
  return (
    <div className="ios ios-home">
      <header className="ios-nav"><SparkWordmark height={20} /><ThemeToggle theme={theme} onToggle={onToggleTheme} className="ios-round" /></header>
      <main className="ios-home__main">
        <div className="ios-hero ios-hero--sm"><div className="ios-hero__glow" aria-hidden="true" /><img src="/aia-spark-icon.png" alt="" className="ios-hero__icon" width="96" height="96" /></div>
        <h1 className="ios-title">Admin</h1>
        <p className="ios-lede">See every answer customers have given to Spark.</p>
        <form className="ios-form" onSubmit={submit}>
          <div className="ios-group">
            <label className="ios-row"><span className="ios-row__label">Password</span><input type="password" value={pw} onChange={(e) => setPw(e.target.value)} required autoFocus autoComplete="current-password" /></label>
          </div>
          {error && <p className="ios-error" role="alert">{error}</p>}
          <button className="ios-button" type="submit" disabled={busy}>{busy && <span className="ios-spinner" aria-hidden="true" />}{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
      </main>
    </div>
  )
}

const TAG_ORDER = ['FTF', 'NFTF', 'VC', 'VCTI', 'TI', 'Cash', 'ILP', 'Shield', 'NC', 'Roadshow', 'Rental', 'Shared', 'Offshore', 'NONENG', 'TIER 1', 'TIER 2']
const tagsOf = (script: string) => Array.from(script.matchAll(/\[([^\]]+)]/g), (m) => m[1])

/** The call list: each customer's policy number and call script, with search and filter by script tag. */
function DataTab({ token, onUnauthorized }: { token: string; onUnauthorized: () => void }) {
  const [rows, setRows] = useState<AdminCustomer[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState<string[]>([])

  useEffect(() => {
    let alive = true
    api.adminCustomers(token).then((r) => { if (alive) setRows(r) }).catch((err) => {
      if (err instanceof api.ApiError && err.status === 401) onUnauthorized()
      else if (alive) setError('Could not load the call list.')
    })
    return () => { alive = false }
  }, [token, onUnauthorized])

  const tags = useMemo(() => {
    const seen = new Set((rows ?? []).flatMap((r) => tagsOf(r.callScript)))
    return [...TAG_ORDER.filter((t) => seen.has(t)), ...[...seen].filter((t) => !TAG_ORDER.includes(t)).sort()]
  }, [rows])

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (rows ?? []).filter((r) => {
      const mine = tagsOf(r.callScript)
      return picked.every((t) => mine.includes(t)) && (!needle || r.policyNo.toLowerCase().includes(needle) || r.callScript.toLowerCase().includes(needle))
    })
  }, [rows, q, picked])

  const toggle = (t: string) => setPicked((p) => (p.includes(t) ? p.filter((x) => x !== t) : [...p, t]))

  return (
    <div className="ios-data">
      <h1 className="ios-large">Data</h1>
      <p className="ios-data__sub">Each customer on the call list and the call script that decides which questions Spark asks.</p>
      <label className="ios-search">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
        <input type="search" placeholder="Search by policy number or call script" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search by policy number or call script" />
      </label>
      {tags.length > 0 && (
        <div className="ios-chips" role="group" aria-label="Filter by call script">
          {tags.map((t) => <button key={t} type="button" className={picked.includes(t) ? 'is-on' : ''} aria-pressed={picked.includes(t)} onClick={() => toggle(t)}>{t}</button>)}
          {picked.length > 0 && <button type="button" className="ios-chips__clear" onClick={() => setPicked([])}>Clear</button>}
        </div>
      )}
      {error && <p className="ios-error">{error}</p>}
      {rows === null && !error && <p className="ios-empty">Loading…</p>}
      {rows !== null && <p className="ios-data__count" role="status">{shown.length === rows.length ? `${rows.length} customers` : `${shown.length} of ${rows.length} customers`}</p>}
      {rows !== null && !shown.length && <p className="ios-empty">No customer matches. Clear the search or a filter.</p>}
      {shown.length > 0 && (
        <div className="ios-table-wrap"><table className="ios-table">
          <thead><tr><th scope="col">Policy number</th><th scope="col">Call script</th></tr></thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.policyNo + r.callScript}>
                <td className="ios-table__policy">{r.policyNo}</td>
                <td><span className="ios-tags">{tagsOf(r.callScript).map((t) => <span key={t} className={`ios-tag-chip${picked.includes(t) ? ' is-on' : ''}`}>{t}</span>)}</span></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </div>
  )
}

export function AdminScreen({ theme, onToggleTheme }: { theme: Theme; onToggleTheme: () => void }) {
  const [token, setToken] = useState<string | null>(() => { try { return window.sessionStorage.getItem(KEY) } catch { return null } })
  const [rows, setRows] = useState<AdminResponse[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [status, setStatus] = useState<StatusFilter>('ALL')
  const [channel, setChannel] = useState<string>('ALL')
  const [q, setQ] = useState('')
  const [tab, setTab] = useState<'responses' | 'data'>('responses')

  const signOut = useCallback(() => {
    try { window.sessionStorage.removeItem(KEY) } catch { /* ignore */ }
    setToken(null); setRows(null); setSelected(null)
  }, [])

  const load = useCallback(async () => {
    if (!token) return
    setLoadError(null)
    try { setRows(await api.adminResponses(token)) } catch (err) {
      if (err instanceof api.ApiError && err.status === 401) signOut()
      else setLoadError('Could not load responses.')
    }
  }, [token, signOut])

  useEffect(() => { void load() }, [load])

  const channels = useMemo(() => ['ALL', ...Array.from(new Set((rows ?? []).map((r) => r.channel))).sort()], [rows])

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (rows ?? []).filter((r) =>
      (status === 'ALL' || r.status === status) && (channel === 'ALL' || r.channel === channel) &&
      (!needle || [r.holderName, r.policyNo, r.productName, ...r.answers.map((a) => a.answer)].some((v) => v.toLowerCase().includes(needle))))
  }, [rows, status, channel, q])

  if (!token) {
    return <AdminLogin theme={theme} onToggleTheme={onToggleTheme} onToken={(t) => { try { window.sessionStorage.setItem(KEY, t) } catch { /* ignore */ } setToken(t) }} />
  }

  const all = rows ?? []
  const answers = all.flatMap((r) => r.answers)
  const voice = answers.length ? Math.round((answers.filter((a) => a.source === 'VOICE').length / answers.length) * 100) : 0
  const current = all.find((r) => r.id === selected) ?? null

  return (
    <div className={`ios ios-admin${current ? ' has-selection' : ''}`}>
      <header className="ios-nav ios-nav--wide">
        <div className="ios-nav__brand"><SparkWordmark height={20} /><span className="ios-tag">Admin</span></div>
        <Segmented<'responses' | 'data'> className="ios-seg--compact ios-seg--tabs" value={tab} onChange={setTab} label="Admin sections" options={[{ value: 'responses', label: 'Responses' }, { value: 'data', label: 'Data' }]} />
        <div className="ios-nav__actions">
          {tab === 'responses' && <button type="button" className="ios-textbtn" onClick={() => void load()}>Refresh</button>}
          {tab === 'responses' && <button type="button" className="ios-textbtn" onClick={() => exportCsv(shown)} disabled={!shown.length}>Export CSV</button>}
          <ThemeToggle theme={theme} onToggle={onToggleTheme} className="ios-round" />
          <button type="button" className="ios-textbtn" onClick={signOut}>Sign out</button>
        </div>
      </header>

      {tab === 'data' ? <DataTab token={token} onUnauthorized={signOut} /> : (
      <div className="ios-admin__body">
        <section className="ios-admin__list" aria-label="Responses">
          <h1 className="ios-large">Responses</h1>
          <div className="ios-tiles">
            <Tile value={all.length} label="Responses" />
            <Tile value={all.filter((r) => r.status === 'COMPLETED').length} label="Completed" tone="green" />
            <Tile value={all.filter((r) => r.status === 'IN_PROGRESS').length} label="In progress" tone="orange" />
            <Tile value={`${voice}%`} label="By voice" tone="red" />
          </div>

          <label className="ios-search">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            <input type="search" placeholder="Search name, policy or answer" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          <Segmented<StatusFilter> value={status} onChange={setStatus} label="Status" options={[
            { value: 'ALL', label: 'All' }, { value: 'COMPLETED', label: 'Completed' }, { value: 'IN_PROGRESS', label: 'In progress' }, { value: 'RESTARTED', label: 'Restarted' }]} />
          {channels.length > 2 && (
            <div className="ios-chips" role="group" aria-label="Channel">
              {channels.map((c) => <button key={c} type="button" className={c === channel ? 'is-on' : ''} aria-pressed={c === channel} onClick={() => setChannel(c)}>{c === 'ALL' ? 'All channels' : c}</button>)}
            </div>
          )}

          {loadError && <p className="ios-error">{loadError}</p>}
          {rows === null && !loadError && <p className="ios-empty">Loading…</p>}
          {rows !== null && !shown.length && <p className="ios-empty">{all.length ? 'Nothing matches your filters.' : 'No responses yet. Answers appear here as customers talk to Spark.'}</p>}

          {shown.length > 0 && (
            <ul className="ios-group ios-list">
              {shown.map((r) => (
                <li key={r.id}>
                  <button type="button" className={`ios-item${r.id === selected ? ' is-on' : ''}`} onClick={() => setSelected(r.id)}>
                    <span className="ios-avatar">{initials(r.holderName)}</span>
                    <span className="ios-item__text">
                      <b>{r.holderName}</b>
                      <small>{r.policyNo} · {r.channel}</small>
                    </span>
                    <span className="ios-item__side">
                      <Pill status={r.status} />
                      <small>{fmt(r.finishedAt)}</small>
                    </span>
                    <svg className="ios-chev" width="8" height="14" viewBox="0 0 8 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m1 1 6 6-6 6" /></svg>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="ios-admin__detail" aria-label="Response">
          {current ? <Detail key={current.id} r={current} onBack={() => setSelected(null)} /> : (
            <div className="ios-placeholder"><img src="/aia-spark-icon.png" alt="" width="72" height="72" /><p>Select a response to read the answers.</p></div>
          )}
        </section>
      </div>
      )}
    </div>
  )
}
