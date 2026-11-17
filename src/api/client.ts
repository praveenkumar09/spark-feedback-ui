const BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://localhost:8090'

export interface QuestionView { key: string; type: string; text: string; number: number }
export interface AnswerView { questionKey: string; question: string; answer: string; decision: string; source: string }
export interface Turn {
  sessionId: string
  status: 'IN_PROGRESS' | 'COMPLETED'
  language: string
  customerName: string
  channel: string
  question: QuestionView | null
  repeat: boolean
  noSpeech: boolean
  heard: string | null
  decision: string | null
  phrases: Record<string, string>
  answers: AnswerView[]
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

async function json<T>(res: Response): Promise<T> {
  if (res.ok) return (await res.json()) as T
  let msg = ''
  try { msg = ((await res.json()) as { error?: string }).error ?? '' } catch { /* not JSON */ }
  throw new ApiError(res.status, msg)
}

function headers(token: string, extra: Record<string, string> = {}) {
  return { Authorization: `Bearer ${token}`, ...extra }
}

export async function login(policyNo: string, dob: string, language: string): Promise<{ token: string; turn: Turn }> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ policyNo, dob, language }),
  })
  return json(res)
}

export async function getSession(token: string, id: string): Promise<Turn> {
  return json(await fetch(`${BASE}/api/sessions/${id}`, { headers: headers(token) }))
}

export async function sendAnswer(token: string, id: string, questionKey: string, text: string, source: 'TEXT' | 'BUTTON', choice?: 'YES' | 'NO'): Promise<Turn> {
  return json(await fetch(`${BASE}/api/sessions/${id}/answer`, {
    method: 'POST', headers: headers(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ questionKey, text, source, choice }),
  }))
}

export async function sendAudio(token: string, id: string, questionKey: string, audio: Blob): Promise<Turn> {
  const form = new FormData()
  form.append('questionKey', questionKey)
  form.append('audio', audio, 'answer')
  return json(await fetch(`${BASE}/api/sessions/${id}/answer/audio`, { method: 'POST', headers: headers(token), body: form }))
}

export async function setLanguage(token: string, id: string, language: string): Promise<Turn> {
  return json(await fetch(`${BASE}/api/sessions/${id}/language`, {
    method: 'PUT', headers: headers(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ language }),
  }))
}

export async function restart(token: string, id: string): Promise<Turn> {
  return json(await fetch(`${BASE}/api/sessions/${id}/restart`, { method: 'POST', headers: headers(token) }))
}

/** Spark's voice as an audio blob, or null when the server has no speech (the browser's own voice is used instead). */
export async function speak(token: string, id: string, what: string): Promise<Blob | null> {
  const res = await fetch(`${BASE}/api/sessions/${id}/speak`, {
    method: 'POST', headers: headers(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ what }),
  })
  if (res.status === 204 || !res.ok) return null
  return res.blob()
}
