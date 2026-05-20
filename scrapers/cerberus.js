/**
 * Cerberus scraper — url.publishedprices.co.il
 * Covers: רמי לוי, יוחננוף, אושר עד, חצי חינם, טיב טעם
 *
 * No login/registration needed — files are publicly accessible at:
 * https://url.publishedprices.co.il/file/d/{ChainName}/
 *
 * SSL cert on this server is self-signed → rejectUnauthorized: false
 */

import axios from 'axios'
import https from 'https'
import zlib from 'zlib'
import { promisify } from 'util'
import { XMLParser } from 'fast-xml-parser'

const gunzip = promisify(zlib.gunzip)

const BASE = 'https://url.publishedprices.co.il'

// SSL agent that ignores self-signed cert
const httpsAgent = new https.Agent({ rejectUnauthorized: false })

// Chain name → our brand key
const CHAINS = {
  RamiLevi:  'ramilevi',
  Yohananof: 'yohananof',
  osherad:   'osher',
  HaziHinam: 'osher',   // similar brand, merge under osher
  TivTaam:   'tivtaam',
}

/** Fetch file listing for a chain → array of filenames */
async function getFileList(chainName) {
  const url = `${BASE}/file/d/${chainName}/`
  const res = await axios.get(url, {
    httpsAgent,
    timeout: 20000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CompriceBot/1.0)' },
  })
  const html = res.data

  // Match Price/PriceFull gz file links
  const re = /href="([^"]*(?:PriceFull|Price)[^"]*\.gz[^"]*)"/gi
  const files = []
  let m
  while ((m = re.exec(html)) !== null) {
    const name = m[1].replace(/&amp;/g, '&')
    files.push(name.startsWith('http') ? name : `${BASE}/file/d/${chainName}/${name}`)
  }
  return files
}

/** Download + decompress + parse one .gz → { barcode: price } */
async function parseGzFile(url) {
  const res = await axios.get(url, {
    httpsAgent,
    responseType: 'arraybuffer',
    timeout: 120000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CompriceBot/1.0)' },
    maxContentLength: 50 * 1024 * 1024,
  })

  const xml = (await gunzip(Buffer.from(res.data))).toString('utf8')
  const parser = new XMLParser({ parseTagValue: true, trimValues: true })
  const doc = parser.parse(xml)

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

/** Scrape one chain → { barcode: price } */
async function scrapeChain(chainName, brandKey) {
  console.log(`[Cerberus:${chainName}] Fetching file list...`)
  const files = await getFileList(chainName)
  console.log(`[Cerberus:${chainName}] Found ${files.length} files`)

  if (files.length === 0) return {}

  // Download first 3 files for representative coverage (PriceFull preferred)
  const toDownload = files.slice(0, 3)
  const merged = {}

  for (const url of toDownload) {
    try {
      const prices = await parseGzFile(url)
      for (const [barcode, price] of Object.entries(prices)) {
        if (!(barcode in merged) || price < merged[barcode]) {
          merged[barcode] = price
        }
      }
      console.log(`[Cerberus:${chainName}] File OK — ${Object.keys(prices).length} barcodes`)
    } catch (err) {
      console.warn(`[Cerberus:${chainName}] File error: ${err.message.substring(0, 80)}`)
    }
  }

  return merged
}

export async function scrape() {
  const result = {}

  for (const [chainName, brandKey] of Object.entries(CHAINS)) {
    try {
      const prices = await scrapeChain(chainName, brandKey)
      const count = Object.keys(prices).length
      if (count > 0) {
        if (!result[brandKey]) result[brandKey] = {}
        for (const [barcode, price] of Object.entries(prices)) {
          if (!(barcode in result[brandKey]) || price < result[brandKey][barcode]) {
            result[brandKey][barcode] = price
          }
        }
        console.log(`[Cerberus] ${chainName} → ${count} barcodes (${brandKey})`)
      }
    } catch (err) {
      console.warn(`[Cerberus:${chainName}] Scrape failed: ${err.message}`)
    }
  }

  return result
}
