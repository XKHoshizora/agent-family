#!/usr/bin/env node
// Prints the memory counters (README "Memory counters"): days as columns, counter names as rows.
//
//   DATABASE_URL=postgres://... node scripts/memory-stats.mjs [--days N]      (default 7)
//
// Reads only DATABASE_URL from the environment and only the table memory_stats (counts: no owner, conversation or text is in it).
// The table is the service's own `readStats` and `formatStats` (src/memory/stats.ts; Node strips its types).
import pg from 'pg'
import { formatStats, readStats } from '../src/memory/stats.ts'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is not set')
  process.exit(1)
}
const at = process.argv.indexOf('--days')
const days = at === -1 ? 7 : Number(process.argv[at + 1])
if (!Number.isInteger(days) || days < 1 || days > 366) {
  console.error('--days needs a whole number from 1 to 366')
  process.exit(1)
}
const pool = new pg.Pool({ connectionString: url, max: 1 })
try {
  console.log(formatStats(await readStats(pool, days), days))
} finally {
  await pool.end()
}
