import { useCallback, useEffect, useState } from 'react'
import * as api from './api/client'
import type { Turn } from './api/client'
import { LoginScreen } from './screens/LoginScreen'
import { ChatScreen } from './screens/ChatScreen'
import { SummaryScreen } from './screens/SummaryScreen'
import { useTheme } from './hooks/useTheme'
import { strings, type Lang } from './i18n/strings'

const KEY = 'sf-session'
const LANG_KEY = 'sf-lang'

function readLang(): Lang {
  try {
    const l = window.localStorage.getItem(LANG_KEY)
    if (l === 'en' || l === 'ms' || l === 'zh' || l === 'ta') return l
  } catch { /* storage blocked */ }
  return 'en'
}

export default function App() {
  const { theme, toggleTheme } = useTheme()
  const [lang, setLangState] = useState<Lang>(readLang)
  const [auth, setAuth] = useState<{ token: string; turn: Turn } | null>(null)
  const [booting, setBooting] = useState(true)
  const [notice, setNotice] = useState<string | null>(null)

  const setLang = useCallback((l: Lang) => {
    setLangState(l)
    try { window.localStorage.setItem(LANG_KEY, l) } catch { /* ignore */ }
  }, [])

  // Pick up a session left open in this tab (a refresh keeps the customer where they were).
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const raw = window.sessionStorage.getItem(KEY)
        if (raw) {
          const saved = JSON.parse(raw) as { token: string; id: string }
          const turn = await api.getSession(saved.token, saved.id)
          if (alive) { setAuth({ token: saved.token, turn }); setLang(turn.language as Lang) }
        }
      } catch { try { window.sessionStorage.removeItem(KEY) } catch { /* ignore */ } }
      if (alive) setBooting(false)
    })()
    return () => { alive = false }
  }, [setLang])

  const signOut = useCallback((message?: string) => {
    try { window.sessionStorage.removeItem(KEY) } catch { /* ignore */ }
    setAuth(null)
    setNotice(message ?? null)
  }, [])

  async function login(policyNo: string, dob: string) {
    const res = await api.login(policyNo, dob, lang)
    try { window.sessionStorage.setItem(KEY, JSON.stringify({ token: res.token, id: res.turn.sessionId })) } catch { /* ignore */ }
    setNotice(null)
    setLang(res.turn.language as Lang)
    setAuth(res)
  }

  async function restart() {
    if (!auth) return
    const turn = await api.restart(auth.token, auth.turn.sessionId)
    setAuth({ token: auth.token, turn })
  }

  if (booting) return null

  if (!auth) return <LoginScreen lang={lang} onLang={setLang} onLogin={login} theme={theme} onToggleTheme={toggleTheme} notice={notice} />

  if (auth.turn.status === 'COMPLETED') {
    return (
      <SummaryScreen
        turn={auth.turn} lang={lang} onLang={async (l) => { setLang(l); setAuth({ ...auth, turn: await api.setLanguage(auth.token, auth.turn.sessionId, l) }) }}
        theme={theme} onToggleTheme={toggleTheme} onSignOut={() => signOut()} onRestart={() => void restart()}
      />
    )
  }

  return (
    <ChatScreen
      key={auth.turn.sessionId + ':' + auth.turn.answers.length + ':' + (auth.turn.question?.key ?? '')}
      token={auth.token} initial={auth.turn} lang={lang} onLang={setLang} theme={theme} onToggleTheme={toggleTheme}
      onComplete={(turn) => setAuth((a) => (a ? { ...a, turn } : a))}
      onSignOut={() => signOut()} onUnauthorized={() => signOut(strings(lang).sessionExpired)}
    />
  )
}
