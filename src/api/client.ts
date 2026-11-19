const BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://localhost:8090'

export interface OptionView { key: string; text: string }
export interface QuestionView { key: string; type: string; text: string; number: number; options: OptionView[] }
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

export async function sendAnswer(token: string, id: string, questionKey: string, text: string, source: 'TEXT' | 'BUTTON' | 'VOICE', choice?: string): Promise<Turn> {
  return json(await fetch(`${BASE}/api/sessions/${id}/answer`, {
    method: 'POST', headers: headers(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ questionKey, text, source, choice }),
  }))
}

/** Speech to text only: lets the screen show what the customer said before the answer has been worked out. */
export async function transcribe(token: string, id: string, audio: Blob): Promise<string> {
  const form = new FormData()
  form.append('audio', audio, 'answer')
  return (await json<{ text: string }>(await fetch(`${BASE}/api/sessions/${id}/transcribe`, { method: 'POST', headers: headers(token), body: form }))).text
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

/** Takes back the latest answer; the server opens that question again. */
export async function undo(token: string, id: string): Promise<Turn> {
  return json(await fetch(`${BASE}/api/sessions/${id}/undo`, { method: 'POST', headers: headers(token) }))
}

// ── Admin panel ──────────────────────────────────────────────────────────────

export interface AdminAnswer { key: string; question: string; answer: string; decision: string; confidence: number | null; source: string; language: string; answeredAt: string }
export interface AdminResponse {
  id: string
  kind: 'saved' | 'live'
  status: 'COMPLETED' | 'RESTARTED' | 'IN_PROGRESS'
  sessionId: string
  policyNo: string
  holderName: string
  productName: string
  channel: string
  questionnaireKey: string | null
  language: string
  startedAt: string
  finishedAt: string
  answers: AdminAnswer[]
}

export async function adminLogin(password: string): Promise<string> {
  const res = await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) })
  return (await json<{ token: string }>(res)).token
}

export async function adminResponses(token: string): Promise<AdminResponse[]> {
  return json(await fetch(`${BASE}/api/admin/responses`, { headers: headers(token) }))
}

export interface AdminCustomer { policyNo: string; callScript: string }

export async function adminCustomers(token: string): Promise<AdminCustomer[]> {
  return json(await fetch(`${BASE}/api/admin/customers`, { headers: headers(token) }))
}
