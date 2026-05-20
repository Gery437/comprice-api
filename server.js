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

// ── Diagnostic: test shufersal listing page ───────────────────
app.get('/api/debug/shufersal', async (req, res) => {
  try {
    const axios = (await import('axios')).default
    const BASE = 'http://prices.shufersal.co.il'
    const htmlRes = await axios.get(BASE, {
      timeout: 30000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CompriceBot/1.0)' },
    })
    const html = htmlRes.data

    // Count gz links
    const reAll = /href="([^"]*\.gz[^"]*)"/gi
    const urls = []
    let m
    while ((m = reAll.exec(html)) !== null) urls.push(m[1])

    // Sample first 3 URLs (truncated, no full SAS token)
    const samples = urls.slice(0, 3).map(u => {
      const decoded = u.replace(/&amp;/g, '&')
      return decoded.substring(0, 120) + '...'
    })

    // Try downloading first URL
    let downloadTest = null
    if (urls.length > 0) {
      try {
        const url = urls[0].replace(/&amp;/g, '&')
        const full = url.startsWith('http') ? url : `${BASE}/${url}`
        const dlRes = await axios.get(full, {
          responseType: 'arraybuffer',
          timeout: 30000,
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CompriceBot/1.0)' },
        })
        const { gunzipSync } = await import('zlib')
        const xml = gunzipSync(Buffer.from(dlRes.data)).toString('utf8')
        const { XMLParser } = await import('fast-xml-parser')
        const parser = new XMLParser({ parseTagValue: true, trimValues: true })
        const doc = parser.parse(xml)
        const root = doc?.root || doc?.Prices || doc
        const prods = root?.Products?.Product || root?.Items?.Item || []
        const arr = Array.isArray(prods) ? prods : [prods]
        const sample = arr[0] ? JSON.stringify(arr[0]).substring(0, 300) : 'none'
        downloadTest = {
          ok: true,
          compressedKB: Math.round(dlRes.data.byteLength / 1024),
          xmlKB: Math.round(xml.length / 1024),
          productCount: arr.length,
          firstProduct: sample,
        }
      } catch (e) {
        downloadTest = { ok: false, error: e.message }
      }
    }

    res.json({
      htmlSizeKB: Math.round(html.length / 1024),
      gzLinksFound: urls.length,
      sampleUrls: samples,
      downloadTest,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
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
