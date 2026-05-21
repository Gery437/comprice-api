/**
 * Shufersal scraper — prices.shufersal.co.il
 * Covers: שופרסל שלי (001), שופרסל דיל (002), שופרסל אקספרס (003),
 *         שופרסל BE (007), יש חסד (008/018)
 *
 * File types on the listing (sorted by time desc):
 *   Pages 1–20 : Price (daily delta, few items each)
 *   Pages 20–50: PriceFull (FULL catalog per store, ~10k items each) ← we want these
 *   Pages 50–85: PromoFull, Stores
 *
 * Strategy: scan pages until we find one PriceFull file per sub-chain (max 60 pages).
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

function decodeHtml(str) {
  return str.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
}

/** Fetch one page, return array of { url, subChain, isPriceFull } */
async function fetchPage(page) {
  const res = await axios.get(`${BASE}/?page=${page}`, {
    timeout: 20000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CompriceBot/1.0)' },
  })
  const html = res.data
  const re = /href="([^"]*\.gz[^"]*)"/gi
  const files = []
  let m
  while ((m = re.exec(html)) !== null) {
    const rawHref = decodeHtml(m[1])
    const url = rawHref.startsWith('http') ? rawHref
      : rawHref.startsWith('/') ? `${BASE}${rawHref}`
      : `${BASE}/${rawHref}`
    const isPriceFull = /PriceFull/i.test(url)
    const sc = (url.match(/PriceFull\d+-(\d{3})-/) ||
                url.match(/Price\d+-(\d{3})-/))?.[1]
    files.push({ url, subChain: sc || 'unknown', isPriceFull })
  }
  return files
}

/** Download + decompress + parse one PriceFull .gz → { barcode: price } */
async function parsePriceFullFile(url, label) {
  console.log(`[Shufersal:${label}] Downloading PriceFull...`)
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 120000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CompriceBot/1.0)' },
    maxContentLength: 100 * 1024 * 1024,
  })

  const compressed = Buffer.from(res.data)
  const xml = (await gunzip(compressed)).toString('utf8')
  console.log(`[Shufersal:${label}] ${Math.round(compressed.length/1024)}KB → ${Math.round(xml.length/1024)}KB XML`)

  const parser = new XMLParser({ parseTagValue: true, trimValues: true })
  const doc = parser.parse(xml)

  const root = doc?.Root || doc?.root || doc?.Prices || doc
  const raw = root?.Items?.Item || root?.Products?.Product || []
  const arr = Array.isArray(raw) ? raw : (raw ? [raw] : [])

  const prices = {}
  for (const p of arr) {
    if (!p) continue
    const code = String(p?.ItemCode ?? '').trim()
    const price = parseFloat(p?.ItemPrice ?? p?.Price ?? 0)
    if (code.length >= 6 && /^\d+$/.test(code) && price > 0) {
      prices[code] = price
    }
  }
  console.log(`[Shufersal:${label}] ${arr.length} items → ${Object.keys(prices).length} barcodes`)
  return prices
}

export async function scrape() {
  console.log('[Shufersal] Scanning pages for PriceFull files...')

  // Scan pages to find up to FILES_PER_SUBCHAIN PriceFull per sub-chain
  const FILES_PER_SUBCHAIN = 3
  const found = {}  // subChain → [url, ...]

  for (let page = 1; page <= 65; page++) {
    // Stop early if we have enough files for all sub-chains
    const allDone = Object.keys(SUBCHAIN_MAP).every(
      sc => (found[sc] || []).length >= FILES_PER_SUBCHAIN
    )
    if (allDone) break

    try {
      const files = await fetchPage(page)
      let foundOnPage = 0
      for (const { url, subChain, isPriceFull } of files) {
        if (isPriceFull && SUBCHAIN_MAP[subChain]) {
          if (!found[subChain]) found[subChain] = []
          if (found[subChain].length < FILES_PER_SUBCHAIN) {
            found[subChain].push(url)
            foundOnPage++
          }
        }
      }
      if (foundOnPage > 0) {
        const total = Object.values(found).reduce((s, a) => s + a.length, 0)
        console.log(`[Shufersal] Page ${page}: +${foundOnPage} PriceFull (${total} total)`)
      }
      if (Object.values(found).some(a => a.length > 0) && foundOnPage === 0 && page > 45) break
    } catch (err) {
      console.warn(`[Shufersal] Page ${page} error: ${err.message}`)
    }
  }

  const result = { shufersal: {}, yesh: {} }

  for (const [subChain, urls] of Object.entries(found)) {
    const brand = SUBCHAIN_MAP[subChain]
    if (!brand) continue
    for (const url of urls) {
      try {
        const prices = await parsePriceFullFile(url, subChain)
        for (const [barcode, price] of Object.entries(prices)) {
          if (!(barcode in result[brand]) || price < result[brand][barcode]) {
            result[brand][barcode] = price
          }
        }
      } catch (err) {
        console.warn(`[Shufersal:${subChain}] Parse error: ${err.message}`)
      }
    }
  }

  const shuf = Object.keys(result.shufersal).length
  const yesh = Object.keys(result.yesh).length
  console.log(`[Shufersal] Done — shufersal: ${shuf}, yesh: ${yesh} barcodes`)
  return result
}
