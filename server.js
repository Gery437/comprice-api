import express from 'express'
import cors from 'cors'
import schedule from 'node-schedule'
import { refreshAllPrices } from './scrapers/index.js'
import { getByBarcode, getCacheInfo, isCacheReady } from './cache.js'

const app = express()

app.use(cors())
app.use(express.json())

// ── Health check ──────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ ok: true, ...getCacheInfo() })
})

// ── Get prices by barcode ─────────────────────────────────────
// GET /api/prices/:barcode
// Response: { barcode, prices: { shufersal: 8.90, ramilevi: 7.50 }, found: true }
app.get('/api/prices/:barcode', (req, res) => {
  const barcode = req.params.barcode.replace(/\D/g, '')

  if (!barcode || barcode.length < 6) {
    return res.status(400).json({ error: 'Invalid barcode' })
  }

  if (!isCacheReady()) {
    return res.status(503).json({ error: 'Cache not ready yet, try again in a minute' })
  }

  const prices = getByBarcode(barcode)

  if (!prices) {
    return res.json({ barcode, prices: {}, found: false })
  }

  res.json({ barcode, prices, found: true })
})

// ── Batch price lookup ────────────────────────────────────────
// POST /api/prices/batch
// Body: { barcodes: ["7290000066266", ...] }
app.post('/api/prices/batch', (req, res) => {
  const { barcodes } = req.body

  if (!Array.isArray(barcodes) || barcodes.length === 0) {
    return res.status(400).json({ error: 'barcodes must be a non-empty array' })
  }
  if (barcodes.length > 50) {
    return res.status(400).json({ error: 'Max 50 barcodes per request' })
  }

  if (!isCacheReady()) {
    return res.status(503).json({ error: 'Cache not ready yet' })
  }

  const result = {}
  for (const raw of barcodes) {
    const barcode = String(raw).replace(/\D/g, '')
    result[barcode] = getByBarcode(barcode) || {}
  }

  res.json({ result })
})

// ── Manual refresh (optional, for admin use) ──────────────────
let refreshing = false
app.post('/api/refresh', async (req, res) => {
  const secret = process.env.REFRESH_SECRET
  if (secret && req.headers['x-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  if (refreshing) {
    return res.json({ status: 'already_running' })
  }
  refreshing = true
  res.json({ status: 'started' })
  try {
    await refreshAllPrices()
  } finally {
    refreshing = false
  }
})

// ── Cache info ────────────────────────────────────────────────
app.get('/api/info', (req, res) => {
  res.json(getCacheInfo())
})

// ── Start server ──────────────────────────────────────────────
const PORT = process.env.PORT || 3001
app.listen(PORT, async () => {
  console.log(`\n🚀 ComPrice API running on port ${PORT}`)

  // Initial load on startup
  try {
    await refreshAllPrices()
  } catch (err) {
    console.error('Initial refresh failed:', err.message)
  }

  // Refresh every day at 06:00 Israel time
  schedule.scheduleJob('0 6 * * *', async () => {
    if (refreshing) return
    refreshing = true
    console.log('[scheduler] Daily refresh triggered')
    try {
      await refreshAllPrices()
    } finally {
      refreshing = false
    }
  })

  console.log('📅 Daily refresh scheduled at 06:00')
})
