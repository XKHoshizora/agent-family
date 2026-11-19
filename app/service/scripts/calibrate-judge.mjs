#!/usr/bin/env node
// Calibration of the proactive-reply judgement (batch 2D).
//
//   JUDGE_URL=... JUDGE_KEY=... [JUDGE_MODEL=jev-latest] node scripts/calibrate-judge.mjs
//        [--samples <path>] [--concurrency <n>] [--json <path>] [--filter <category>]
//   node scripts/calibrate-judge.mjs --check      validate the samples file only
//   node scripts/calibrate-judge.mjs --dry-run    print the request bodies of the first 3 samples, call nothing
//
// The URL, key and model come from the environment only. The key is never printed.
// Side effects: stdout, and the file given to --json.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_SAMPLES = resolve(HERE, '../calibration/samples.jsonl')

const MIN_PER_CATEGORY = {
  'fresh-request': 12,
  'follow-up-asker': 8,
  'follow-up-other': 6,
  'named-no-at': 6,
  overlap: 8,
  thanks: 5,
  chitchat: 10,
  'answered-by-person': 6,
  'to-a-person': 6,
  'no-expert': 5,
  'quiet-blunt': 4,
  'quiet-mild': 4,
  'quiet-joke': 3,
  'quiet-covered': 8,
  'quiet-old': 5,
  rhetorical: 4,
  'topic-change': 4,
  'private-or-sensitive': 3,
}

const PICK_INSTRUCTIONS =
  '群里有几个 AI 助手。记录里标着“（Agent）”的是它们说过的话。最新这条消息如果需要某个 AI 助手主动来回答，应该由谁回答？'
const NOBODY_TEXT = '不需要任何 AI 助手回答：真人之间的闲聊、客套、道谢，已经有人回答了，或者不属于上面任何一位擅长的事'
const quietInstructions = (name) =>
  `群里有一个 AI 助手「${name}」。记录里标着“${name}（Agent）”的是它说过的话。开头标着【新】的是刚发的消息。在这些【新】消息里，有人在让${name}别再说话、安静一点，或者表示它打扰到大家了，而且在那之后没有人又让它继续说。没有标【新】的旧消息不算。`
/** What marks a line as new since the group was last judged (a sample's last `fresh` lines, 1 by default). */
const NEW_MARK = '【新】'

// ---------- args

function parseArgs(argv) {
  const o = { samples: DEFAULT_SAMPLES, concurrency: 4, json: null, filter: null, dryRun: false, check: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} 需要一个值`)
      return argv[++i]
    }
    if (a === '--samples') o.samples = resolve(next())
    else if (a === '--concurrency') o.concurrency = Math.max(1, Number.parseInt(next(), 10) || 4)
    else if (a === '--json') o.json = resolve(next())
    else if (a === '--filter') o.filter = next()
    else if (a === '--dry-run') o.dryRun = true
    else if (a === '--check') o.check = true
    else throw new Error(`不认识的参数：${a}`)
  }
  return o
}

// ---------- samples

function loadSamples(path) {
  const text = readFileSync(path, 'utf8')
  const samples = []
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '') return
    try {
      samples.push(JSON.parse(line))
    } catch (e) {
      throw new Error(`${path} 第 ${i + 1} 行不是合法的 JSON：${e.message}`)
    }
  })
  return samples
}

/** The problems found in a samples list (empty = fine). */
function checkSamples(samples) {
  const errors = []
  const ids = new Set()
  const lasts = new Set()
  const counts = {}
  for (const [n, s] of samples.entries()) {
    const at = `#${n + 1} ${s?.id ?? '?'}`
    if (typeof s.id !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(s.id)) errors.push(`${at}: id 不是 kebab-case`)
    if (ids.has(s.id)) errors.push(`${at}: id 重复`)
    ids.add(s.id)
    if (!(s.category in MIN_PER_CATEGORY)) errors.push(`${at}: 未知的 category ${s.category}`)
    counts[s.category] = (counts[s.category] ?? 0) + 1
    if (!Array.isArray(s.agents) || s.agents.length < 1 || s.agents.length > 8) {
      errors.push(`${at}: agents 要 1 到 8 个`)
      continue
    }
    const keys = s.agents.map((a) => a.key)
    s.agents.forEach((a, i) => {
      if (a.key !== `a${i + 1}`) errors.push(`${at}: agents[${i}].key 应为 a${i + 1}`)
      for (const f of ['name', 'intro', 'field']) if (typeof a[f] !== 'string' || a[f] === '') errors.push(`${at}: agents[${i}].${f} 缺失`)
    })
    if (new Set(s.agents.map((a) => a.name)).size !== s.agents.length) errors.push(`${at}: Agent 名字重复`)
    const t = s.transcript
    if (!Array.isArray(t) || t.length < 2 || t.length > 15) {
      errors.push(`${at}: transcript 要 2 到 15 条`)
      continue
    }
    const names = new Map(s.agents.map((a) => [a.name, a.key]))
    const spoke = new Set()
    for (const [i, m] of t.entries()) {
      if (typeof m.from !== 'string' || typeof m.text !== 'string' || typeof m.agent !== 'boolean') errors.push(`${at}: transcript[${i}] 字段不对`)
      if (m.agent) {
        if (!names.has(m.from)) errors.push(`${at}: transcript[${i}] 的 Agent「${m.from}」不在 agents 里`)
        else spoke.add(names.get(m.from))
      } else if (names.has(m.from)) errors.push(`${at}: transcript[${i}] 是 Agent 的名字但 agent 不是 true`)
    }
    if (s.fresh !== undefined && (!Number.isInteger(s.fresh) || s.fresh < 1 || s.fresh > t.length)) errors.push(`${at}: fresh 要是 1 到 transcript 条数之间的整数`)
    if ((s.category === 'quiet-covered' || s.category === 'quiet-old') && !(s.fresh >= 2)) errors.push(`${at}: ${s.category} 需要 fresh >= 2`)
    const last = t[t.length - 1]
    if (last.agent) errors.push(`${at}: 最后一条必须是真人发的`)
    if (lasts.has(last.text)) errors.push(`${at}: 最后一条消息和别的样本重复`)
    lasts.add(last.text)
    const pick = s.expect?.pick
    if (pick !== 'nobody' && !keys.includes(pick)) errors.push(`${at}: expect.pick 必须是 nobody 或 ${keys.join('/')}`)
    for (const [k, v] of Object.entries(s.expect?.quiet ?? {})) {
      if (!keys.includes(k)) errors.push(`${at}: expect.quiet 里的 ${k} 不是 Agent`)
      else if (!spoke.has(k)) errors.push(`${at}: expect.quiet 里的 ${k} 在记录里没说过话`)
      if (v !== true) errors.push(`${at}: expect.quiet.${k} 只能是 true`)
    }
    if (s.category === 'overlap' && !s.note) errors.push(`${at}: overlap 需要 note`)
    if (s.category === 'quiet-joke' && !s.note) errors.push(`${at}: quiet-joke 需要 note`)
    if (s.category === 'quiet-old' && Object.keys(s.expect?.quiet ?? {}).length !== 0) errors.push(`${at}: quiet-old 不应有 expect.quiet`)
    if (s.category.startsWith('quiet-') && s.category !== 'quiet-joke' && s.category !== 'quiet-old') {
      if (pick !== 'nobody' && s.category !== 'quiet-covered') errors.push(`${at}: 让它安静的样本 pick 应为 nobody`)
      if (Object.keys(s.expect?.quiet ?? {}).length === 0) errors.push(`${at}: 缺 expect.quiet`)
    }
    if (s.category === 'quiet-mild' && s.note !== 'mild') errors.push(`${at}: quiet-mild 的 note 应为 "mild"`)
  }
  for (const [c, min] of Object.entries(MIN_PER_CATEGORY)) {
    if ((counts[c] ?? 0) < min) errors.push(`category ${c}: ${counts[c] ?? 0} 条，至少要 ${min}`)
  }
  if (samples.length < 80) errors.push(`一共 ${samples.length} 条，至少要 80`)
  return { errors, counts }
}

// ---------- the request, exactly as the service builds it

function speakers(sample) {
  const byName = new Map(sample.agents.map((a) => [a.name, a]))
  const spoke = []
  for (const m of sample.transcript) {
    const a = m.agent ? byName.get(m.from) : undefined
    if (a && !spoke.includes(a.key)) spoke.push(a.key)
  }
  return spoke
}

function buildBody(sample, model) {
  const firstNew = sample.transcript.length - (sample.fresh ?? 1)
  const state =
    '群聊记录：\n' +
    sample.transcript.map((m, i) => `${i >= firstNew ? NEW_MARK : ''}${m.from}${m.agent ? '（Agent）' : ''}：${m.text}`).join('\n')
  const criteria = {}
  for (const a of sample.agents) criteria[a.key] = `${a.name}：${a.intro}；擅长：${a.field}`
  criteria.nobody = NOBODY_TEXT
  const questions = { pick: { type: 'choice', instructions: PICK_INSTRUCTIONS, criteria } }
  for (const key of speakers(sample)) {
    const a = sample.agents.find((x) => x.key === key)
    questions[`q_${key}`] = { type: 'noul', instructions: quietInstructions(a.name) }
  }
  return { model, state, questions }
}

// ---------- calling

async function once(url, key, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
  return await res.json()
}

async function judgeOne(url, key, sample, model) {
  const body = buildBody(sample, model)
  const t0 = performance.now()
  let answers
  let lastError = ''
  for (let attempt = 0; attempt < 2 && !answers; attempt++) {
    try {
      const json = await once(url, key, body)
      answers = json?.answers
      if (!answers || typeof answers !== 'object') {
        answers = undefined
        lastError = '返回里没有 answers'
        break
      }
    } catch (e) {
      lastError = String(e?.message ?? e).replaceAll(key, '***')
    }
  }
  const ms = Math.round(performance.now() - t0)
  const base = { id: sample.id, category: sample.category, expect: sample.expect, ms }
  if (!answers) return { ...base, ok: false, error: lastError }
  const probs = answers.pick?.probabilities
  if (!probs || typeof probs !== 'object') return { ...base, ok: false, error: '没有 pick.probabilities', answers }
  const quiet = {}
  for (const k of speakers(sample)) {
    const v = answers[`q_${k}`]?.noul
    if (typeof v === 'number') quiet[k] = v
  }
  return { ...base, ok: true, probs, quiet, answers }
}

async function pool(items, n, fn) {
  const out = new Array(items.length)
  let next = 0
  const worker = async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker))
  return out
}

// ---------- report

const f2 = (x) => (typeof x === 'number' ? x.toFixed(2) : '--')
const pad = (s, n) => String(s).padEnd(n)

function ranked(r) {
  return Object.entries(r.probs).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
}

/** The top Agent option (never `nobody`); ties go to the lowest key, as in the service. */
function topAgent(r) {
  let best = null
  for (const [k, p] of Object.entries(r.probs)) {
    if (k === 'nobody' || typeof p !== 'number') continue
    if (best === null || p > best[1] || (p === best[1] && k < best[0])) best = [k, p]
  }
  return best
}

const correct = (r) => ranked(r)[0]?.[0] === r.expect.pick
const quietKeys = (r) => Object.keys(r.expect.quiet ?? {})

function report(results, samples, model) {
  const ok = results.filter((r) => r.ok)
  const failed = results.filter((r) => !r.ok)
  const lines = []
  const out = (s = '') => lines.push(s)

  out(`主动判断校准报告  模型 ${model}  样本 ${results.length}（成功 ${ok.length}，失败 ${failed.length}）`)
  out()
  out('一、逐条（期望 | 前两名 | 对错 | 让它安静的概率 | 毫秒）')
  for (const r of results) {
    if (!r.ok) {
      out(`${pad(r.id, 26)} ${pad(r.category, 20)} 期望 ${pad(r.expect.pick, 6)} 失败：${r.error}`)
      continue
    }
    const top = ranked(r)
      .slice(0, 2)
      .map(([k, p]) => `${k} ${f2(p)}`)
      .join(' / ')
    const q = Object.entries(r.quiet)
      .map(([k, p]) => `${k}${r.expect.quiet?.[k] ? '*' : ''}:${f2(p)}`)
      .join(' ')
    out(`${pad(r.id, 26)} ${pad(r.category, 20)} 期望 ${pad(r.expect.pick, 6)} ${pad(top, 22)} ${correct(r) ? '✓' : '✗'}  安静[${q}]  ${r.ms}ms`)
  }
  out('  （安静里带 * 的是期望要安静的）')

  out()
  out('二、按类别（对 / 总，失败的不计）')
  const cats = [...new Set(results.map((r) => r.category))]
  for (const c of cats) {
    const rs = ok.filter((r) => r.category === c)
    out(`${pad(c, 22)} ${rs.filter(correct).length} / ${rs.length}`)
  }
  out(`${pad('合计', 22)} ${ok.filter(correct).length} / ${ok.length}`)

  out()
  out('三、回复门槛扫描（服务拿“最高的 Agent 选项”的概率去比门槛；nobody 不会赢，但它的概率会压低 Agent 们）')
  const wantAgent = ok.filter((r) => r.expect.pick !== 'nobody')
  const wantNobody = ok.filter((r) => r.expect.pick === 'nobody')
  out(`  期望有 Agent 回的 ${wantAgent.length} 条，期望没人回的 ${wantNobody.length} 条`)
  out('  T     会回回对  该回没回  回错人  不该回却回  合计错(b+c+d)')
  let best = null
  for (let i = 0; i <= 13; i++) {
    const T = Math.round((0.3 + i * 0.05) * 100) / 100
    let a = 0
    let b = 0
    let c = 0
    let d = 0
    for (const r of wantAgent) {
      const t = topAgent(r)
      if (!t || t[1] < T) b++
      else if (t[0] === r.expect.pick) a++
      else c++
    }
    for (const r of wantNobody) {
      const t = topAgent(r)
      if (t && t[1] >= T) d++
    }
    const bad = b + c + d
    out(`  ${T.toFixed(2)}  ${pad(a, 8)}  ${pad(b, 8)}  ${pad(c, 6)}  ${pad(d, 10)}  ${bad}`)
    if (best === null || bad <= best.bad) best = { T, bad }
  }
  out(`  错得最少的门槛：T = ${best.T.toFixed(2)}（合计错 ${best.bad}；并列取最高的 T）`)

  out()
  out('四、让它安静')
  for (const T of [0.3, 0.8]) {
    out(`  门槛 ${T.toFixed(1)}：`)
    for (const c of ['quiet-blunt', 'quiet-mild', 'quiet-covered']) {
      let hit = 0
      let total = 0
      for (const r of ok.filter((x) => x.category === c)) {
        for (const k of quietKeys(r)) {
          total++
          if ((r.quiet[k] ?? 0) >= T) hit++
        }
      }
      out(`    ${c}：${hit} / ${total} 达到`)
    }
    const alarms = []
    for (const r of ok) {
      for (const [k, p] of Object.entries(r.quiet)) {
        if (!r.expect.quiet?.[k] && p >= T) alarms.push(`${r.id}(${k}:${f2(p)})`)
      }
    }
    out(`    误报（不该安静却达到）：${alarms.length} 个${alarms.length ? '：' + alarms.join('、') : ''}`)
  }

  out()
  out('五、延迟')
  const ms = ok.map((r) => r.ms).sort((a, b) => a - b)
  if (ms.length) {
    const q = (p) => ms[Math.min(ms.length - 1, Math.ceil(p * ms.length) - 1)]
    out(`  中位数 ${q(0.5)}ms，p95 ${q(0.95)}ms，最大 ${ms[ms.length - 1]}ms`)
  } else out('  没有成功的请求')

  out()
  out('六、判错的样本（完整概率，供细看）')
  const wrong = ok.filter((r) => !correct(r))
  if (wrong.length === 0) out('  没有')
  const byId = new Map(samples.map((s) => [s.id, s]))
  for (const r of wrong) {
    const s = byId.get(r.id)
    const last = s?.transcript[s.transcript.length - 1]
    out(`  ${r.id}（${r.category}）期望 ${r.expect.pick}${s?.note ? `  备注：${s.note}` : ''}`)
    if (last) out(`    最后一条 ${last.from}：${last.text}`)
    out(`    概率 ${ranked(r).map(([k, p]) => `${k} ${f2(p)}`).join('  ')}`)
    const q = Object.entries(r.quiet)
    if (q.length) out(`    安静 ${q.map(([k, p]) => `${k} ${f2(p)}`).join('  ')}`)
  }
  if (failed.length) {
    out()
    out(`请求失败的样本（不计入上面任何一项）：${failed.map((r) => `${r.id}（${r.error}）`).join('、')}`)
  }
  return lines.join('\n')
}

// ---------- main

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const all = loadSamples(args.samples)

  if (args.check) {
    const { errors, counts } = checkSamples(all)
    console.log(`样本文件 ${args.samples}：${all.length} 条`)
    console.log('各类别：' + Object.entries(counts).map(([c, n]) => `${c} ${n}`).join('，'))
    if (errors.length) {
      console.log(`发现 ${errors.length} 个问题：`)
      for (const e of errors) console.log('  - ' + e)
      process.exitCode = 1
    } else console.log('检查通过。')
    return
  }

  const samples = args.filter ? all.filter((s) => s.category === args.filter) : all
  if (samples.length === 0) throw new Error(`没有样本${args.filter ? `属于类别 ${args.filter}` : ''}`)
  const model = process.env.JUDGE_MODEL || 'jev-latest'

  if (args.dryRun) {
    for (const s of samples.slice(0, 3)) {
      console.log(`--- ${s.id}  期望 ${s.expect.pick}`)
      console.log(JSON.stringify(buildBody(s, model), null, 2))
    }
    return
  }

  const url = process.env.JUDGE_URL
  const key = process.env.JUDGE_KEY
  if (!url || !key) {
    console.error('需要环境变量 JUDGE_URL 和 JUDGE_KEY（可选 JUDGE_MODEL，默认 jev-latest）。只用 --check 或 --dry-run 的话不需要。')
    process.exitCode = 2
    return
  }

  const results = await pool(samples, args.concurrency, (s) => judgeOne(url, key, s, model))
  console.log(report(results, samples, model))
  if (args.json) writeFileSync(args.json, JSON.stringify({ model, at: new Date().toISOString(), results }, null, 2) + '\n')
}

main().catch((e) => {
  console.error(String(e?.message ?? e))
  process.exitCode = 1
})
