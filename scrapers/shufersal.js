/**
 * Shufersal scraper — prices.shufersal.co.il
 *
 * Sub-chains: 001=שלי, 002=דיל, 003=אקספרס, 007=BE, 008/018=יש חסד
 *
 * Shufersal ItemCode is their internal code, NOT always EAN-13.
 * We try all reasonable barcode interpretations:
 *   - As-is (works for foreign EAN-13 like 4820...)
 *   - With leading zero (UPC-A → EAN-13: 11210000032 → 011210000032)
 *   - With leading 00 (for 11-digit codes)
 *
 * We download many PriceFull files per sub-chain to maximize product coverage.
 */

import axios from 'axios'
import zlib from 'zlib'
import { promisify } from 'util'
import { XMLParser } from 'fast-xml-parser'

const gunzip = promisify(zlib.gunzip)
const BASE = 'http://prices.shufersal.co.il'

const SUBCHAIN_MAP = {
  '001': 'shufersal', '002': 'shufersal', '003': 'shufersal',
  '004': 'shufersal', '005': 'shufersal', '007': 'shufersal',
  '008': 'yesh', '018': 'yesh',
}

// How many PriceFull files to download per sub-chain
// More = better coverage, but slower startup
const FILES_PER_SUBCHAIN = {
  '001': 8,   // שופרסל שלי — main format, most products
  '002': 6,   // שופרסל דיל
  '008': 5,   // יש חסד
  '018': 3,   // יש חסד (alt numbering)
  default: 2,
}

function decodeHtml(str) {
  return str.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
}

/**
 * Normalize a Shufersal ItemCode to EAN-13 candidates.
 * Shufersal uses internal codes, but we try common transformations.
 */
function toBarcodeCandidates(code) {
  const s = String(code).trim().replace(/^0+/, '') // strip leading zeros
  const candidates = new Set()
  candidates.add(s)                          // as-is
  if (s.length === 12) candidates.add('0' + s)  // UPC-A → EAN-13
  if (s.length === 11) candidates.add('00' + s) // 11-digit → 13-digit
  if (s.length === 12) candidates.add(s)
  if (s.length === 13) candidates.add(s)     // already EAN-13
  return [...candidates]
}

async function fetchPage(page) {
  const res = await axios.get(`${BASE}/?page=${page}`, {
    timeout: 20000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CompriceBot/1.0)' },
  })
  const re = /href="([^"]*\.gz[^"]*)"/gi
  const files = []
  let m
  while ((m = re.exec(res.data)) !== null) {
    const rawHref = decodeHtml(m[1])
    const url = rawHref.startsWith('http') ? rawHref
      : rawHref.startsWith('/') ? `${BASE}${rawHref}` : `${BASE}/${rawHref}`
    const isPriceFull = /PriceFull/i.test(url)
    const sc = (url.match(/PriceFull\d+-(\d{3})-/) || url.match(/Price\d+-(\d{3})-/))?.[1]
    files.push({ url, subChain: sc || 'unknown', isPriceFull })
  }
  return files
}

async function parsePriceFullFile(url, label) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 120000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CompriceBot/1.0)' },
    maxContentLength: 100 * 1024 * 1024,
  })
  const xml = (await gunzip(Buffer.from(res.data))).toString('utf8')
  const parser = new XMLParser({ parseTagValue: true, trimValues: true })
  const doc = parser.parse(xml)
  const root = doc?.Root || doc?.root || doc?.Prices || doc
  const raw = root?.Items?.Item || root?.Products?.Product || []
  const arr = Array.isArray(raw) ? raw : (raw ? [raw] : [])

  const prices = {}
  const names = {}
  for (const p of arr) {
    if (!p) continue
    const rawCode = String(p?.ItemCode ?? '').trim()
    const price = parseFloat(p?.ItemPrice ?? p?.Price ?? 0)
    if (!rawCode || price <= 0) continue

    const itemName = String(p?.ItemName ?? p?.ProductDescription ?? '').trim()

    // Store under all barcode candidates (as-is + with leading zeros)
    for (const candidate of toBarcodeCandidates(rawCode)) {
      if (candidate.length >= 6 && /^\d+$/.test(candidate)) {
        if (!(candidate in prices) || price < prices[candidate]) {
          prices[candidate] = price
        }
        if (itemName && !names[candidate]) {
          names[candidate] = itemName
        }
      }
    }
  }

  console.log(`[Shufersal:${label}] ${arr.length} items → ${Object.keys(prices).length} barcodes`)
  return { prices, names }
}

export async function scrape() {
  console.log('[Shufersal] Scanning for PriceFull files...')

  const found = {}  // subChain → [url, ...]

  for (let page = 1; page <= 70; page++) {
    const allDone = Object.keys(SUBCHAIN_MAP).every(sc => {
      const limit = FILES_PER_SUBCHAIN[sc] ?? FILES_PER_SUBCHAIN.default
      return (found[sc] || []).length >= limit
    })
    if (allDone) break

    try {
      const files = await fetchPage(page)
      let added = 0
      for (const { url, subChain, isPriceFull } of files) {
        if (!isPriceFull || !SUBCHAIN_MAP[subChain]) continue
        const limit = FILES_PER_SUBCHAIN[subChain] ?? FILES_PER_SUBCHAIN.default
        if (!found[subChain]) found[subChain] = []
        if (found[subChain].length < limit) {
          found[subChain].push(url)
          added++
        }
      }
      if (added > 0) {
        const total = Object.values(found).reduce((s, a) => s + a.length, 0)
        console.log(`[Shufersal] Page ${page}: +${added} files (${total} total)`)
      }
      if (Object.values(found).some(a => a.length > 0) && added === 0 && page > 50) break
    } catch (err) {
      console.warn(`[Shufersal] Page ${page} error: ${err.message}`)
    }
  }

  const result = { shufersal: {}, yesh: {}, names: {} }

  // Download all files in parallel (per sub-chain)
  const downloads = []
  for (const [subChain, urls] of Object.entries(found)) {
    const brand = SUBCHAIN_MAP[subChain]
    if (!brand) continue
    for (const url of urls) {
      downloads.push(
        parsePriceFullFile(url, subChain)
          .then(({ prices, names }) => ({ brand, prices, names }))
          .catch(err => {
            console.warn(`[Shufersal] Download failed: ${err.message.substring(0, 80)}`)
            return null
          })
      )
    }
  }

  const results = await Promise.all(downloads)
  for (const item of results) {
    if (!item) continue
    const { brand, prices, names } = item
    for (const [barcode, price] of Object.entries(prices)) {
      if (!(barcode in result[brand]) || price < result[brand][barcode]) {
        result[brand][barcode] = price
      }
    }
    for (const [barcode, name] of Object.entries(names)) {
      if (!result.names[barcode]) result.names[barcode] = name
    }
  }

  console.log(`[Shufersal] Done — shufersal: ${Object.keys(result.shufersal).length}, yesh: ${Object.keys(result.yesh).length}, names: ${Object.keys(result.names).length}`)
  return result
}
