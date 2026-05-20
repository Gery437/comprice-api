/**
 * Shufersal scraper — prices.shufersal.co.il
 * Covers: שופרסל שלי (001), שופרסל דיל (002), שופרסל אקספרס (003),
 *         שופרסל BE (007), יש חסד (008/018)
 *
 * The site only has "Price" (daily update) files — not PriceFull.
 * Each file contains items whose price changed that day (1–30 items, ~5KB).
 * We collect files from multiple pages to maximize barcode coverage.
 */

import axios from 'axios'
import zlib from 'zlib'
import { promisify } from 'util'
import { XMLParser } from 'fast-xml-parser'

const gunzip = promisify(zlib.gunzip)
const BASE = 'http://prices.shufersal.co.il'

// Sub-chain IDs → our brand key
const SUBCHAIN_MAP = {
  '001': 'shufersal', '002': 'shufersal', '003': 'shufersal',
  '004': 'shufersal', '005': 'shufersal', '007': 'shufersal',
  '008': 'yesh', '018': 'yesh',
}

/** Decode HTML entities (&amp; → &) */
function decodeHtml(str) {
  return str.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
}

/** Fetch one listing page → array of { url, subChain } */
async function fetchListingPage(page = 1) {
  const res = await axios.get(`${BASE}/?page=${page}`, {
    timeout: 20000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CompriceBot/1.0)' },
  })

  const html = res.data
  const re = /href="([^"]*Price[^"]*\.gz[^"]*)"/gi
  const files = []
  let m

  while ((m = re.exec(html)) !== null) {
    const rawHref = decodeHtml(m[1])
    const url = rawHref.startsWith('http') ? rawHref
      : rawHref.startsWith('/') ? `${BASE}${rawHref}`
      : `${BASE}/${rawHref}`

    // Extract sub-chain from: Price{chainId}-{subChain}-{store}-...
    const sc = (url.match(/Price\d+-(\d{3})-\d{3}-/) ||
                url.match(/Price[^-]+-(\d{3})-\d/))?.[1]
    files.push({ url, subChain: sc || 'unknown' })
  }

  return files
}

/** Download + decompress + parse one .gz XML file → { barcode: price } */
async function parseGzFile(url) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 60000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CompriceBot/1.0)' },
    maxContentLength: 30 * 1024 * 1024,
  })

  const xml = (await gunzip(Buffer.from(res.data))).toString('utf8')

  const parser = new XMLParser({ parseTagValue: true, trimValues: true })
  const doc = parser.parse(xml)

  // Shufersal XML: <Root><Items><Item>...</Item></Items></Root>
  // NOTE: Root is capital R, not lowercase
  const root = doc?.Root || doc?.root || doc?.Prices || doc
  const raw = root?.Items?.Item || root?.Products?.Product || []
  const arr = Array.isArray(raw) ? raw : (raw ? [raw] : [])

  const prices = {}
  for (const p of arr) {
    if (!p) continue
    const code = String(p?.ItemCode ?? p?.barcode ?? '').trim()
    const price = parseFloat(p?.ItemPrice ?? p?.Price ?? 0)
    if (code.length >= 6 && /^\d+$/.test(code) && price > 0) {
      prices[code] = price
    }
  }
  return prices
}

export async function scrape() {
  console.log('[Shufersal] Starting scrape (collecting from multiple pages)...')

  // Collect files from first N pages to maximize coverage
  const PAGES_TO_SCAN = 5  // 5 pages × 20 files = 100 files total
  const allFiles = []

  for (let page = 1; page <= PAGES_TO_SCAN; page++) {
    try {
      const files = await fetchListingPage(page)
      allFiles.push(...files)
      console.log(`[Shufersal] Page ${page}: ${files.length} files`)
    } catch (err) {
      console.warn(`[Shufersal] Page ${page} failed: ${err.message}`)
    }
  }

  console.log(`[Shufersal] Total files to download: ${allFiles.length}`)

  const result = { shufersal: {}, yesh: {} }
  let downloaded = 0
  let failed = 0

  for (const { url, subChain } of allFiles) {
    const brand = SUBCHAIN_MAP[subChain]
    if (!brand) continue

    try {
      const prices = await parseGzFile(url)
      for (const [barcode, price] of Object.entries(prices)) {
        // Keep lowest price when same barcode appears in multiple files
        if (!(barcode in result[brand]) || price < result[brand][barcode]) {
          result[brand][barcode] = price
        }
      }
      downloaded++
    } catch (err) {
      failed++
      if (failed <= 5) console.warn(`[Shufersal] File failed: ${err.message.substring(0, 80)}`)
    }
  }

  const shuf = Object.keys(result.shufersal).length
  const yesh = Object.keys(result.yesh).length
  console.log(`[Shufersal] Done — downloaded: ${downloaded}, failed: ${failed}`)
  console.log(`[Shufersal] Barcodes — shufersal: ${shuf}, yesh: ${yesh}`)
  return result
}
