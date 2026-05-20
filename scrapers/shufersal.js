/**
 * Shufersal scraper — prices.shufersal.co.il
 * Covers: שופרסל שלי (001), שופרסל דיל (002), שופרסל אקספרס (003),
 *         שופרסל BE (007), יש חסד (008)
 *
 * Site returns a table of .gz file links with Azure SAS tokens.
 * Each file is a gzipped XML with all products for one store.
 * We pick 1 representative store per sub-chain to keep download size manageable.
 */

import axios from 'axios'
import zlib from 'zlib'
import { promisify } from 'util'
import { XMLParser } from 'fast-xml-parser'

const gunzip = promisify(zlib.gunzip)
const BASE = 'http://prices.shufersal.co.il'

// Sub-chain IDs → brand name
const SUBCHAIN_MAP = {
  '001': 'shufersal', // שופרסל שלי
  '002': 'shufersal', // שופרסל דיל
  '003': 'shufersal', // שופרסל אקספרס
  '007': 'shufersal', // שופרסל BE
  '008': 'yesh',      // יש חסד
}

/** Fetch file listing and return { subChain → downloadUrl } for PriceFull or Price files */
async function getRepresentativeUrls() {
  const res = await axios.get(BASE, {
    timeout: 20000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CompriceBot/1.0)' },
  })

  const html = res.data

  // Match href="<azure-blob-url>" — prefer PriceFull, fallback to Price
  const fullRe = /href="(https?:\/\/[^"]*PriceFull[^"]*\.gz[^"]*)"/gi
  const priceRe = /href="(https?:\/\/[^"]*Price[^"]*\.gz[^"]*)"/gi

  const bySubchain = {}

  for (const re of [fullRe, priceRe]) {
    let m
    while ((m = re.exec(html)) !== null) {
      const url = m[1]
      // Extract sub-chain from filename, e.g. Price7290027600007-001-003-...
      const fnMatch = url.match(/Price[^-]+-(\d{3})-\d/)
      const subChain = fnMatch ? fnMatch[1] : 'unknown'
      if (!bySubchain[subChain]) {
        bySubchain[subChain] = url
      }
    }
    if (Object.keys(bySubchain).length >= 5) break
  }

  return bySubchain
}

/** Download + decompress + parse one .gz XML file → { barcode: price } */
async function parseGzFile(url, label) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 90000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CompriceBot/1.0)' },
  })

  const xml = (await gunzip(Buffer.from(res.data))).toString('utf8')

  const parser = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: true,
    trimValues: true,
    parseAttributeValue: true,
  })
  const doc = parser.parse(xml)

  // Navigate XML structure — Shufersal uses <root><Products><Product>
  const root = doc?.root || doc?.Prices || doc
  const products =
    root?.Products?.Product ||
    root?.Items?.Item ||
    root?.product ||
    []

  const arr = Array.isArray(products) ? products : [products]
  const prices = {}

  for (const p of arr) {
    if (!p) continue
    const code = String(p?.ItemCode ?? p?.barcode ?? p?.Barcode ?? '').trim()
    const price = parseFloat(p?.ItemPrice ?? p?.Price ?? p?.price ?? 0)

    // Only accept valid EAN-like codes (8–14 digits) and positive prices
    if (code.length >= 8 && /^\d+$/.test(code) && price > 0) {
      prices[code] = price
    }
  }

  console.log(`[Shufersal:${label}] Parsed ${arr.length} items → ${Object.keys(prices).length} valid barcodes`)
  return prices
}

/** Main export: scrape all sub-chains, return { chainKey: { barcode: price } } */
export async function scrape() {
  console.log('[Shufersal] Fetching file listing...')
  const urlMap = await getRepresentativeUrls()
  console.log('[Shufersal] Sub-chains found:', Object.keys(urlMap).join(', '))

  // Result buckets per brand key
  const result = { shufersal: {}, yesh: {} }

  for (const [subChain, url] of Object.entries(urlMap)) {
    const brand = SUBCHAIN_MAP[subChain]
    if (!brand) {
      console.log(`[Shufersal] Skipping unknown sub-chain ${subChain}`)
      continue
    }
    try {
      console.log(`[Shufersal] Downloading sub-chain ${subChain} (${brand})...`)
      const prices = await parseGzFile(url, subChain)

      for (const [barcode, price] of Object.entries(prices)) {
        // Keep lowest price if barcode appears in multiple sub-chain stores
        if (!(barcode in result[brand]) || price < result[brand][barcode]) {
          result[brand][barcode] = price
        }
      }
    } catch (err) {
      console.warn(`[Shufersal] Sub-chain ${subChain} failed: ${err.message}`)
    }
  }

  const shuf = Object.keys(result.shufersal).length
  const yesh = Object.keys(result.yesh).length
  console.log(`[Shufersal] Done — shufersal: ${shuf}, yesh: ${yesh} barcodes`)
  return result
}
