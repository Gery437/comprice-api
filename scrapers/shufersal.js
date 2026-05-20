/**
 * Shufersal scraper — prices.shufersal.co.il
 * Covers: שופרסל שלי (001), שופרסל דיל (002), שופרסל אקספרס (003),
 *         שופרסל BE (007), יש חסד (008)
 */

import axios from 'axios'
import zlib from 'zlib'
import { promisify } from 'util'
import { XMLParser } from 'fast-xml-parser'

const gunzip = promisify(zlib.gunzip)
const BASE = 'http://prices.shufersal.co.il'

const SUBCHAIN_MAP = {
  '001': 'shufersal',
  '002': 'shufersal',
  '003': 'shufersal',
  '007': 'shufersal',
  '008': 'yesh',
}

/** Decode HTML entities in URLs (&amp; → &) */
function decodeHtml(str) {
  return str.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
}

/** Fetch listing → { subChain: url } picking one file per sub-chain */
async function getRepresentativeUrls() {
  const res = await axios.get(BASE, {
    timeout: 30000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CompriceBot/1.0)' },
  })

  const html = res.data
  console.log(`[Shufersal] Listing page size: ${html.length} bytes`)

  // Match ANY .gz href — both absolute (https://...) and relative paths
  const re = /href="([^"]*\.gz[^"]*)"/gi
  const bySubchain = {}
  let totalFound = 0
  let m

  while ((m = re.exec(html)) !== null) {
    totalFound++
    // Decode HTML entities (SAS tokens have & encoded as &amp; in HTML)
    const rawHref = decodeHtml(m[1])
    // Make absolute URL
    const url = rawHref.startsWith('http') ? rawHref
      : rawHref.startsWith('/') ? `http://prices.shufersal.co.il${rawHref}`
      : `http://prices.shufersal.co.il/${rawHref}`

    // Extract sub-chain from filename: Price{chainId}-{subchain}-{store}-...
    const fnMatch = url.match(/\/Price[^/]*?-(\d{3})-\d{3}-/)
      || url.match(/Price[^-]+-(\d{3})-\d/)
    const subChain = fnMatch ? fnMatch[1] : null
    if (subChain && !bySubchain[subChain]) {
      bySubchain[subChain] = url
    }
  }

  console.log(`[Shufersal] Found ${totalFound} gz links, sub-chains: ${Object.keys(bySubchain).join(', ')}`)
  return bySubchain
}

/** Download + decompress + parse one .gz XML file → { barcode: price } */
async function parseGzFile(url, label) {
  console.log(`[Shufersal:${label}] Downloading...`)
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 120000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CompriceBot/1.0)' },
    maxContentLength: 50 * 1024 * 1024, // 50MB max
  })

  const compressed = Buffer.from(res.data)
  console.log(`[Shufersal:${label}] Downloaded ${(compressed.length / 1024).toFixed(0)} KB compressed`)

  const xml = (await gunzip(compressed)).toString('utf8')
  console.log(`[Shufersal:${label}] Decompressed to ${(xml.length / 1024).toFixed(0)} KB XML`)

  const parser = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: true,
    trimValues: true,
  })
  const doc = parser.parse(xml)

  // Shufersal XML: <root><Products><Product>...</Product></Products></root>
  const root = doc?.root || doc?.Prices || doc
  const raw = root?.Products?.Product || root?.Items?.Item || []
  const arr = Array.isArray(raw) ? raw : [raw]

  const prices = {}
  for (const p of arr) {
    if (!p) continue
    const code = String(p?.ItemCode ?? p?.barcode ?? p?.Barcode ?? '').trim()
    const price = parseFloat(p?.ItemPrice ?? p?.Price ?? p?.price ?? 0)
    if (code.length >= 6 && /^\d+$/.test(code) && price > 0) {
      prices[code] = price
    }
  }

  console.log(`[Shufersal:${label}] ${arr.length} items → ${Object.keys(prices).length} barcodes`)
  return prices
}

export async function scrape() {
  console.log('[Shufersal] Starting scrape...')

  let urlMap
  try {
    urlMap = await getRepresentativeUrls()
  } catch (err) {
    console.error('[Shufersal] Failed to fetch listing:', err.message)
    return { shufersal: {}, yesh: {} }
  }

  if (Object.keys(urlMap).length === 0) {
    console.warn('[Shufersal] No files found in listing!')
    return { shufersal: {}, yesh: {} }
  }

  const result = { shufersal: {}, yesh: {} }

  for (const [subChain, url] of Object.entries(urlMap)) {
    const brand = SUBCHAIN_MAP[subChain]
    if (!brand) {
      console.log(`[Shufersal] Skipping unknown sub-chain ${subChain}`)
      continue
    }
    try {
      const prices = await parseGzFile(url, subChain)
      let added = 0
      for (const [barcode, price] of Object.entries(prices)) {
        if (!(barcode in result[brand]) || price < result[brand][barcode]) {
          result[brand][barcode] = price
          added++
        }
      }
      console.log(`[Shufersal:${subChain}] Merged ${added} barcodes into "${brand}"`)
    } catch (err) {
      console.warn(`[Shufersal:${subChain}] Failed: ${err.message}`)
    }
  }

  const shuf = Object.keys(result.shufersal).length
  const yesh = Object.keys(result.yesh).length
  console.log(`[Shufersal] Done — shufersal: ${shuf}, yesh: ${yesh} total barcodes`)
  return result
}
