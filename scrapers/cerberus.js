/**
 * Cerberus scraper — url.publishedprices.co.il
 * Covers: רמי לוי, יוחננוף, אושר עד, חצי חינם, טיב טעם
 *
 * Login: POST /login/user with username + empty password → session cookie
 * Files: GET /file/d/{ChainName}/ with cookie
 */

import axios from 'axios'
import https from 'https'
import zlib from 'zlib'
import { promisify } from 'util'
import { XMLParser } from 'fast-xml-parser'

const gunzip = promisify(zlib.gunzip)
const BASE = 'https://url.publishedprices.co.il'

const httpsAgent = new https.Agent({ rejectUnauthorized: false })

const CHAINS = {
  RamiLevi:  'ramilevi',
  Yohananof: 'yohananof',
  osherad:   'osher',
  HaziHinam: 'osher',
}

/** Login and return session cookie string */
async function login(username) {
  const res = await axios.post(
    `${BASE}/login/user`,
    new URLSearchParams({ username, password: '' }).toString(),
    {
      httpsAgent,
      timeout: 12000,
      maxRedirects: 5,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (compatible; CompriceBot/1.0)',
      },
      validateStatus: (s) => s < 500,
    }
  )
  const setCookie = res.headers['set-cookie'] || []
  const cookie = setCookie.map((c) => c.split(';')[0]).join('; ')
  if (!cookie) throw new Error(`No cookie returned for ${username}`)
  return cookie
}

/** Get list of .gz file URLs for a chain (requires valid cookie) */
async function getFileList(chainName, cookie) {
  const res = await axios.get(`${BASE}/file/d/${chainName}/`, {
    httpsAgent,
    timeout: 12000,
    headers: {
      Cookie: cookie,
      'User-Agent': 'Mozilla/5.0 (compatible; CompriceBot/1.0)',
    },
  })
  const html = res.data
  const re = /href="([^"]*(?:PriceFull|Price)[^"]*\.gz[^"]*)"/gi
  const files = []
  let m
  while ((m = re.exec(html)) !== null) {
    const name = m[1].replace(/&amp;/g, '&')
    files.push(name.startsWith('http') ? name : `${BASE}/file/d/${chainName}/${name}`)
  }
  return files
}

/** Download + decompress + parse one .gz file → { barcode: price } */
async function parseGzFile(url, cookie) {
  const res = await axios.get(url, {
    httpsAgent,
    responseType: 'arraybuffer',
    timeout: 30000,
    headers: {
      Cookie: cookie,
      'User-Agent': 'Mozilla/5.0 (compatible; CompriceBot/1.0)',
    },
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
    const code = String(p?.ItemCode ?? '').trim()
    const price = parseFloat(p?.ItemPrice ?? p?.Price ?? 0)
    if (code.length >= 6 && /^\d+$/.test(code) && price > 0) {
      prices[code] = price
    }
  }
  return prices
}

/** Scrape one chain after login */
async function scrapeChain(chainName) {
  const cookie = await login(chainName)
  const files = await getFileList(chainName, cookie)
  console.log(`[Cerberus:${chainName}] ${files.length} files found`)
  if (!files.length) return {}

  const merged = {}
  for (const url of files.slice(0, 3)) {
    try {
      const prices = await parseGzFile(url, cookie)
      for (const [b, p] of Object.entries(prices)) {
        if (!(b in merged) || p < merged[b]) merged[b] = p
      }
      console.log(`[Cerberus:${chainName}] file OK — ${Object.keys(prices).length} barcodes`)
    } catch (err) {
      console.warn(`[Cerberus:${chainName}] file error: ${err.message.substring(0, 80)}`)
    }
  }
  return merged
}

export async function scrape() {
  const result = {}
  // Run all chains in parallel
  await Promise.all(
    Object.entries(CHAINS).map(async ([chainName, brandKey]) => {
      try {
        const prices = await scrapeChain(chainName)
        const count = Object.keys(prices).length
        if (count > 0) {
          if (!result[brandKey]) result[brandKey] = {}
          for (const [b, p] of Object.entries(prices)) {
            if (!(b in result[brandKey]) || p < result[brandKey][b]) {
              result[brandKey][b] = p
            }
          }
          console.log(`[Cerberus] ✓ ${chainName} → ${count} barcodes`)
        }
      } catch (err) {
        console.warn(`[Cerberus] ✗ ${chainName}: ${err.message}`)
      }
    })
  )
  return result
}
