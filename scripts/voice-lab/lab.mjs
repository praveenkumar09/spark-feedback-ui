// Offline measurement of the voiceprint with macOS voices: how many of the customer's own utterances are accepted, and how many of other
// people's are rejected. Run:  node scripts/voice-lab/lab.mjs <customerVoice> [workdir]
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { build } from 'esbuild'

const customer = process.argv[2] ?? 'Daniel'
const dir = process.argv[3] ?? '/tmp/voice-lab'
mkdirSync(dir, { recursive: true })
await build({ entryPoints: ['src/lib/voiceprint.ts'], bundle: true, format: 'esm', outfile: join(dir, 'vp.mjs'), logLevel: 'error' })
const vp = await import(join(dir, "vp.mjs"));

const ENROLL = ['Hello Spark, I am ready to answer your questions, and I can hear you clearly.', 'The weather is quite nice today, and I am happy to talk about my policy.', 'My agent explained everything to me and I had no problem with it.'].slice(0, Number(process.env.NSENT ?? 3))
const TESTS = ['Yes', 'No', 'Yes, I know my agent.', 'No, nobody offered me any gift.', 'It was from Prudential.',
  'I was very satisfied with my agent and the whole experience was good.', 'Sorry, can you repeat that please?', 'Everything was good, thank you.']
const OTHERS = (process.env.OTHERS ?? 'Fred Ralph Albert Rishi Samantha Karen Moira Tessa Tara Kathy Junior Shelley Sandy').split(' ')

function wav(voice, text, rate = 180) {
  const f = join(dir, `${voice}-${rate}-${Buffer.from(text).toString('hex').slice(0, 24)}.wav`)
  if (!existsSync(f)) execFileSync('say', ['-v', voice, '-r', String(rate), '-o', f, '--data-format=LEI16@16000', text])
  const b = readFileSync(f)
  let p = 12
  while (p < b.length) {
    const id = b.toString('ascii', p, p + 4), size = b.readUInt32LE(p + 4)
    if (id === 'data') { const n = Math.floor(Math.min(size, b.length - p - 8) / 2); const out = new Float32Array(n); for (let i = 0; i < n; i++) out[i] = b.readInt16LE(p + 8 + i * 2) / 32768; return out }
    p += 8 + size
  }
  throw new Error('no data chunk')
}

const enroll = ENROLL.map((t, i) => vp.extract(wav(customer, t, [175, 190, 205][i])))
const print = vp.buildVoiceprint(enroll)
if (!print) { console.log('enrollment failed: too little voiced speech', enroll.map((e) => e.voicedFrames)); process.exit(1) }
console.log(`customer=${customer}  selfZ=${print.selfZ.toFixed(2)}  enrolled frames=${print.frames}  f0 median=${print.f0Med.toFixed(1)}st range=[${print.f0Lo.toFixed(1)}, ${print.f0Hi.toFixed(1)}]`)

function run(voice, rates) {
  const rows = []
  for (const t of TESTS) for (const r of rates) {
    const f = vp.extract(wav(voice, t, r)); const v = vp.verify(print, f)
    rows.push({ t, r, ok: v.ok, z: v.z, d: v.dF0, ms: v.voicedMs, why: v.reason, unsure: v.unsure })
  }
  return rows
}
const own = run(customer, [160, 200, 230])
const acc = (rows, pred = () => true) => { const s = rows.filter(pred); return s.length ? s.filter((x) => x.ok).length / s.length : NaN }
const short = (x) => x.ms < 450
console.log(`\nCUSTOMER own voice (3 speaking rates x ${TESTS.length} sentences): accepted ${(acc(own) * 100).toFixed(0)}%   long ${(acc(own, (x) => !short(x)) * 100).toFixed(0)}%   short(<0.45s voiced) ${(acc(own, short) * 100).toFixed(0)}%`)
for (const x of own.filter((y) => !y.ok)) console.log(`   rejected own: "${x.t}" @${x.r}wpm z=${x.z.toFixed(2)} dF0=${x.d.toFixed(1)} ${x.why}`)
console.log('\nOTHER voices rejected (long = answers longer than 0.45 s of voice):')
let tot = 0, rej = 0, totL = 0, rejL = 0
for (const v of OTHERS) {
  const rows = run(v, [190]); const r = rows.filter((x) => !x.ok).length
  const L = rows.filter((x) => !short(x)); const rL = L.filter((x) => !x.ok).length
  tot += rows.length; rej += r; totL += L.length; rejL += rL
  console.log(`   ${v.padEnd(9)} rejected ${r}/${rows.length}   long ${rL}/${L.length}   median z=${[...rows].sort((a, b) => a.z - b.z)[Math.floor(rows.length / 2)].z.toFixed(1)}`)
}
console.log(`\nOTHERS overall rejected ${(rej / tot * 100).toFixed(0)}%   long ${(rejL / totL * 100).toFixed(0)}%`)

// distance distributions (long answers only): where would a threshold go?
{
  const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))] }
  const ownZ = own.filter((x) => !short(x) && !x.unsure).map((x) => x.z)
  const othZ = OTHERS.flatMap((v) => run(v, [190]).filter((x) => !short(x) && !x.unsure).map((x) => x.z))
  console.log(`z own: p50=${q(ownZ, .5).toFixed(2)} p90=${q(ownZ, .9).toFixed(2)} max=${Math.max(...ownZ).toFixed(2)} | others: min=${Math.min(...othZ).toFixed(2)} p10=${q(othZ, .1).toFixed(2)} p25=${q(othZ, .25).toFixed(2)} p50=${q(othZ, .5).toFixed(2)} | selfZ=${print.selfZ.toFixed(2)}`)
}

// robustness: the customer's own long answers with background sound mixed in at several signal-to-noise ratios
{
  const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length)
  const mixAt = (sig, noise, snr) => { const g = rms(sig) / (10 ** (snr / 20) * rms(noise)); return sig.map((v, i) => v + g * noise[i % noise.length]) }
  const news = wav('Fred', 'Good evening and welcome to the late news. Heavy rain is expected across the island tonight with thunderstorms moving in from the west. The market closed higher after a busy day of trading.', 175)
  const white = Float32Array.from({ length: 16000 * 6 }, () => Math.random() * 2 - 1)
  console.log('\nCUSTOMER with background mixed in (accepted of long answers):')
  for (const [name, noise] of [['TV/news babble (male)', news], ['white noise', white]]) {
    const line = []
    for (const snr of [25, 15, 10, 5, 0]) {
      const rows = TESTS.slice(2).map((t) => { const f = vp.extract(mixAt(wav(customer, t, 190), noise, snr)); return vp.verify(print, f) })
      line.push(`${snr}dB: ${rows.filter((r) => r.ok).length}/${rows.length}`)
    }
    console.log(`   ${name.padEnd(24)} ${line.join('   ')}`)
  }
  // two people talking at the same moment: the customer with another voice at the same level
  const other = wav(customer === 'Samantha' ? 'Fred' : 'Samantha', 'Mum, I finished my homework and can I have some water please. I will go and play outside now.', 185)
  const rows = TESTS.slice(2).map((t) => vp.verify(print, vp.extract(mixAt(wav(customer, t, 190), other, 3))))
  console.log(`   customer + another voice talking at the same time (customer 3 dB louder): ${rows.filter((r) => r.ok).length}/${rows.length} accepted`)
}
