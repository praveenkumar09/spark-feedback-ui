/**
 * Voice enrollment without any model download: a compact "voiceprint" computed from the sound itself, entirely in the browser.
 *
 * What is measured (only on voiced frames, 25 ms every 10 ms, 16 kHz):
 *  - the average spectral shape of the voice (19 mel-cepstral coefficients: the size and shape of the vocal tract, which differ between people);
 *  - the pitch (F0) range (the clearest difference between an adult and a child, or a man and a woman).
 *
 * How a voice is judged: during enrollment the customer says a sentence twice. Those frames are cut into 0.6 s pieces; how much the spectral
 * average moves from piece to piece tells us how much THIS voice naturally varies. A later utterance is accepted when its spectral average is
 * as close to the enrolled one as that natural variation allows (a z-score, scaled for how long the utterance is) AND its pitch sits inside the
 * enrolled pitch range. So the test adapts to the customer's own voice, microphone and room, and needs no reference voices.
 *
 * Honest limits: this separates people who sound clearly different (an adult from a child, a man from a woman, most same-sex adults) well, and
 * is weaker for two people who sound very alike, for one-word answers, and when two people talk at the same moment.
 */
export const RATE = 16000
const FRAME = 400
const HOP = 160
const NFFT = 512
const NMEL = 40
export const NCEP = 19            // c1..c19
const PREEMPH = 0.97
/** Tunable at run time (the settings screen of the lab), defaults are the measured ones. */
export const CONF = { noiseOver: 1.2, noiseFloor: 0.06, gateRel: 0.4 }
const CHUNK = 60                  // voiced frames needed per enrollment recording (0.6 s) and for the print as a whole x3
const MIN_VOICED = 12             // fewer voiced frames than this (0.12 s): too little to judge the tone
export const SHRINK = 0.5

export interface Features { cep: Float32Array[]; f0: number[]; voicedFrames: number; totalFrames: number }

export interface Voiceprint {
  mean: Float32Array              // average cepstrum of the enrolled voice
  inv: Float32Array               // inverse of the frame-level covariance (19x19, row-major), shrunk towards its diagonal
  frames: number                  // voiced frames the print is based on
  f0Lo: number                    // semitones (re 100 Hz): low and high end of the enrolled pitch range, and the median
  f0Hi: number
  f0Med: number
  /** How far a different sentence by the SAME person drifted during enrollment (z): the accept limit is set relative to it. */
  selfZ: number
}

export interface Verdict {
  ok: boolean
  /** True when the sound was too short or too unvoiced to judge: the caller decides what to do (we accept, as before enrollment existed). */
  unsure: boolean
  z: number                       // spectral distance, about 1 for the same voice; large for another
  dF0: number                     // semitones outside the enrolled pitch range (0 = inside)
  voicedMs: number
  /** voiced frames the verdict is based on (10 ms each) */
  frames: number
  reason: 'match' | 'tone' | 'pitch' | 'short'
}

// ── tuning (set from the measurements in scripts/voice-lab) ────────────────────────────────────────────────
export const TUNE = { zFloor: 3.4, zCeil: 4.4, selfMul: 4.0, zShortMax: 6.5, pitchMargin: 3.5, pitchMarginShort: 6.0, shortFrames: 40 }

// ── signal helpers ─────────────────────────────────────────────────────────────────────────────────────────

export function resampleTo16k(frames: Float32Array[], inRate: number): Float32Array {
  let n = 0
  for (const f of frames) n += f.length
  const all = new Float32Array(n)
  let o = 0
  for (const f of frames) { all.set(f, o); o += f.length }
  if (inRate === RATE) return all
  const ratio = inRate / RATE
  const out = new Float32Array(Math.floor(all.length / ratio))
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio
    const i0 = Math.floor(pos)
    const fr = pos - i0
    out[i] = all[i0] * (1 - fr) + (all[Math.min(i0 + 1, all.length - 1)] ?? 0) * fr
  }
  return out
}

const hamming = new Float32Array(FRAME).map((_, i) => 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (FRAME - 1)))
const cosT = new Float32Array(NFFT / 2)
const sinT = new Float32Array(NFFT / 2)
for (let i = 0; i < NFFT / 2; i++) { cosT[i] = Math.cos((-2 * Math.PI * i) / NFFT); sinT[i] = Math.sin((-2 * Math.PI * i) / NFFT) }

function fft(re: Float32Array, im: Float32Array) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1
    const step = n / len
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const wr = cosT[k * step], wi = sinT[k * step]
        const a = i + k, b = a + half
        const xr = re[b] * wr - im[b] * wi
        const xi = re[b] * wi + im[b] * wr
        re[b] = re[a] - xr; im[b] = im[a] - xi
        re[a] += xr; im[a] += xi
      }
    }
  }
}

const mel = (hz: number) => 2595 * Math.log10(1 + hz / 700)
const unmel = (m: number) => 700 * (10 ** (m / 2595) - 1)
const MEL_LO = 100
const MEL_HI = 5000
const filters: { start: number; w: Float32Array }[] = (() => {
  const pts: number[] = []
  const lo = mel(MEL_LO), hi = mel(MEL_HI)
  for (let i = 0; i < NMEL + 2; i++) pts.push(unmel(lo + ((hi - lo) * i) / (NMEL + 1)))
  const bins = pts.map((f) => Math.floor(((NFFT + 1) * f) / RATE))
  const out: { start: number; w: Float32Array }[] = []
  for (let m = 1; m <= NMEL; m++) {
    const [a, b, c] = [bins[m - 1], bins[m], bins[m + 1]]
    const w = new Float32Array(c - a + 1)
    for (let k = a; k <= c; k++) w[k - a] = k <= b ? (b === a ? 1 : (k - a) / (b - a)) : (c === b ? 1 : (c - k) / (c - b))
    out.push({ start: a, w })
  }
  return out
})()
const dct: Float32Array[] = Array.from({ length: NCEP }, (_, c) => new Float32Array(NMEL).map((_, m) => Math.cos((Math.PI * (c + 1) * (m + 0.5)) / NMEL)))

/** Pitch of the frame centred at `centre` by normalised autocorrelation over 40 ms; 0 when the frame is not clearly voiced. */
function pitch(x: Float32Array, centre: number): number {
  const half = 320
  const s = centre - half
  if (s < 0 || s + 2 * half + 270 > x.length) return 0
  const minLag = 36, maxLag = 267
  let e0 = 0
  for (let i = 0; i < 2 * half; i++) e0 += x[s + i] * x[s + i]
  if (e0 < 1e-6) return 0
  const r = new Float32Array(maxLag + 2)
  let best = 0
  for (let lag = minLag; lag <= maxLag; lag++) {
    let num = 0, e1 = 0
    for (let i = 0; i < 2 * half; i += 2) { num += x[s + i] * x[s + i + lag]; e1 += x[s + i + lag] * x[s + i + lag] }
    r[lag] = num / Math.sqrt((e0 / 2) * e1 + 1e-9)
    if (r[lag] > best) best = r[lag]
  }
  if (best < 0.55) return 0
  // the shortest lag that is nearly as good as the best one (avoids picking an octave too low)
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (r[lag] >= best * 0.88 && r[lag] >= r[lag - 1] && r[lag] >= r[lag + 1]) return RATE / lag
  }
  return 0
}

/** Power spectrum of frame t (windowed, pre-emphasised) into `pw` (NFFT/2+1 bins). */
function powerSpectrum(pre: Float32Array, t: number, re: Float32Array, im: Float32Array, pw: Float32Array) {
  re.fill(0); im.fill(0)
  for (let i = 0; i < FRAME; i++) re[i] = pre[t * HOP + i] * hamming[i]
  fft(re, im)
  for (let k = 0; k <= NFFT / 2; k++) pw[k] = re[k] * re[k] + im[k] * im[k]
}

export function extract(pcm: Float32Array): Features {
  const n = Math.max(0, Math.floor((pcm.length - FRAME) / HOP) + 1)
  const pre = new Float32Array(pcm.length)
  pre[0] = pcm[0] ?? 0
  for (let i = 1; i < pcm.length; i++) pre[i] = pcm[i] - PREEMPH * pcm[i - 1]
  const energy = new Float32Array(n)
  for (let t = 0; t < n; t++) {
    let s = 0
    for (let i = 0; i < FRAME; i++) { const v = pcm[t * HOP + i]; s += v * v }
    energy[t] = Math.sqrt(s / FRAME)
  }
  const order = Array.from(energy.keys()).sort((a, b) => energy[a] - energy[b])
  const hi = energy[order[Math.floor(n * 0.9)]] ?? 0
  const gate = Math.max(0.004, hi * CONF.gateRel)           // only the clearly spoken frames, relative to how loud this utterance is

  // background spectrum: the average of the quietest 15% of frames. Subtracting it keeps steady noise (a fan, a television hum, a different
  // room) from shifting the voice's tone, which is what would otherwise make the same person fail a match in a noisier room.
  const re = new Float32Array(NFFT), im = new Float32Array(NFFT)
  const pw = new Float32Array(NFFT / 2 + 1)
  const noise = new Float32Array(NFFT / 2 + 1)
  const quiet = order.slice(0, Math.max(3, Math.floor(n * 0.15)))
  for (const t of quiet) { powerSpectrum(pre, t, re, im, pw); for (let k = 0; k < pw.length; k++) noise[k] += pw[k] / quiet.length }

  const cep: Float32Array[] = []
  const f0: number[] = []
  const logm = new Float32Array(NMEL)
  for (let t = 0; t < n; t++) {
    if (energy[t] < gate) continue
    const p = pitch(pcm, t * HOP + FRAME / 2)
    if (!p) continue
    powerSpectrum(pre, t, re, im, pw)
    for (let k = 0; k < pw.length; k++) pw[k] = Math.max(pw[k] - CONF.noiseOver * noise[k], CONF.noiseFloor * pw[k])
    for (let m = 0; m < NMEL; m++) {
      const { start, w } = filters[m]
      let e = 0
      for (let k = 0; k < w.length; k++) e += w[k] * pw[start + k]
      logm[m] = Math.log(e + 1e-9)
    }
    const c = new Float32Array(NCEP)
    for (let j = 0; j < NCEP; j++) { let s = 0; const d = dct[j]; for (let m = 0; m < NMEL; m++) s += d[m] * logm[m]; c[j] = s / NMEL }
    cep.push(c)
    f0.push(12 * Math.log2(p / 100))
  }
  return { cep, f0, voicedFrames: cep.length, totalFrames: n }
}

/** Inverse of the frame-level covariance, 50% shrunk towards its diagonal so it stays stable with only a few seconds of speech. */
function invCov(frames: Float32Array[], mean: Float32Array): Float32Array {
  const n = NCEP
  const c = new Float64Array(n * n)
  for (const f of frames) for (let i = 0; i < n; i++) { const di = f[i] - mean[i]; for (let j = i; j < n; j++) c[i * n + j] += di * (f[j] - mean[j]) }
  for (let i = 0; i < n; i++) for (let j = i; j < n; j++) { c[i * n + j] /= Math.max(1, frames.length); c[j * n + i] = c[i * n + j] }
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j) c[i * n + j] *= (1 - SHRINK)
  // Gauss-Jordan inverse
  const a = new Float64Array(n * 2 * n)
  for (let i = 0; i < n; i++) { for (let j = 0; j < n; j++) a[i * 2 * n + j] = c[i * n + j]; a[i * 2 * n + n + i] = 1 }
  for (let col = 0; col < n; col++) {
    let piv = col
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r * 2 * n + col]) > Math.abs(a[piv * 2 * n + col])) piv = r
    if (Math.abs(a[piv * 2 * n + col]) < 1e-12) return new Float32Array(n * n).map((_, k) => (k % (n + 1) === 0 ? 1 : 0))
    if (piv !== col) for (let j = 0; j < 2 * n; j++) { const t = a[col * 2 * n + j]; a[col * 2 * n + j] = a[piv * 2 * n + j]; a[piv * 2 * n + j] = t }
    const d = a[col * 2 * n + col]
    for (let j = 0; j < 2 * n; j++) a[col * 2 * n + j] /= d
    for (let r = 0; r < n; r++) if (r !== col) { const f = a[r * 2 * n + col]; if (f) for (let j = 0; j < 2 * n; j++) a[r * 2 * n + j] -= f * a[col * 2 * n + j] }
  }
  const out = new Float32Array(n * n)
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) out[i * n + j] = a[i * 2 * n + n + j]
  return out
}

const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? 0 }
const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0 }

function meanOf(frames: Float32Array[]): Float32Array {
  const m = new Float32Array(NCEP)
  for (const f of frames) for (let i = 0; i < NCEP; i++) m[i] += f[i]
  for (let i = 0; i < NCEP; i++) m[i] /= Math.max(1, frames.length)
  return m
}

/** Builds the voiceprint from the enrollment recordings, or null when there was not enough clear voice. */
export function buildVoiceprint(recordings: Features[], calibrate = true): Voiceprint | null {
  const all: Float32Array[] = []
  const f0: number[] = []
  for (const r of recordings) {
    if (r.voicedFrames < CHUNK) continue
    all.push(...r.cep)
    f0.push(...r.f0)
  }
  if (all.length < CHUNK * 3) return null
  const mean = meanOf(all)
  const inv = invCov(all, mean)
  const vp: Voiceprint = { mean, inv, frames: all.length, f0Lo: pct(f0, 0.05), f0Hi: pct(f0, 0.95), f0Med: median(f0), selfZ: 0 }
  // leave one recording out: how far does a different sentence by the same person land from a print made of the others?
  const usable = recordings.filter((r) => r.voicedFrames >= CHUNK)
  if (calibrate && usable.length >= 2) {
    let worst = 0
    for (let i = 0; i < usable.length; i++) {
      const rest = usable.filter((_, j) => j !== i)
      const part = buildVoiceprint(rest.length >= 1 ? rest : usable, false)
      if (part) worst = Math.max(worst, verify(part, usable[i], 1, true).z)
    }
    vp.selfZ = worst
  }
  return vp
}

/** How well an utterance matches the enrolled voice. */
export function verify(vp: Voiceprint, feat: Features, strictness = 1, raw = false): Verdict {
  const nt = feat.voicedFrames
  const voicedMs = nt * 10
  if (nt < MIN_VOICED) {
    // under about a tenth of a second of voice (a one-word "yes"): too little for the tone, but the pitch can still say "clearly somebody else"
    if (nt >= 5) {
      const m0 = median(feat.f0)
      const d0 = Math.max(0, vp.f0Lo - TUNE.pitchMarginShort - m0, m0 - (vp.f0Hi + TUNE.pitchMarginShort))
      if (d0 > 0 && !raw) return { ok: false, unsure: false, z: 0, dF0: d0, voicedMs, frames: nt, reason: 'pitch' }
    }
    return { ok: true, unsure: true, z: 0, dF0: 0, voicedMs, frames: nt, reason: 'short' }
  }
  const m = meanOf(feat.cep)
  const short = nt < TUNE.shortFrames
  let z = 0
  {
    const d = new Float32Array(NCEP)
    for (let i = 0; i < NCEP; i++) d[i] = m[i] - vp.mean[i]
    for (let i = 0; i < NCEP; i++) { let r = 0; for (let j = 0; j < NCEP; j++) r += vp.inv[i * NCEP + j] * d[j]; z += d[i] * r }
    z = z / (1 / nt + 1 / vp.frames) / NCEP / 12      // /12: frames are strongly correlated in time, so far fewer than nt independent samples
  }
  const med = median(feat.f0)
  const margin = short ? TUNE.pitchMarginShort : TUNE.pitchMargin
  const dF0 = Math.max(0, vp.f0Lo - margin - med, med - (vp.f0Hi + margin))
  // a word or two carries little tone: only a clear mismatch rejects it (a one-word answer from the customer must not be thrown away)
  const zMax = raw ? Infinity : (short ? TUNE.zShortMax : Math.min(TUNE.zCeil, Math.max(TUNE.zFloor, vp.selfZ * TUNE.selfMul))) * strictness
  if (dF0 > 0) return { ok: false, unsure: false, z, dF0, voicedMs, frames: nt, reason: 'pitch' }
  if (z > zMax) return { ok: false, unsure: false, z, dF0, voicedMs, frames: nt, reason: 'tone' }
  return { ok: true, unsure: false, z, dF0, voicedMs, frames: nt, reason: 'match' }
}

/** Slowly follows the enrolled voice (a different room, a tired or louder customer) using an utterance that was clearly them. */
export function adapt(vp: Voiceprint, feat: Features): Voiceprint {
  if (feat.voicedFrames < 40) return vp
  const m = meanOf(feat.cep)
  const a = Math.min(0.2, feat.voicedFrames / (vp.frames + feat.voicedFrames))
  const mean = new Float32Array(NCEP)
  for (let i = 0; i < NCEP; i++) mean[i] = vp.mean[i] * (1 - a) + m[i] * a
  return { ...vp, mean }
}

/** Two enrollment recordings must sound like the same person: otherwise somebody else (or the television) joined in. */
export function consistent(a: Features, b: Features): { ok: boolean; z: number } {
  const vp = buildVoiceprint([a])
  if (!vp) return { ok: false, z: Infinity }
  const v = verify(vp, b, 1.6)
  return { ok: v.ok || v.unsure, z: v.z }
}
