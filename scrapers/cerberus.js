/**
 * Cerberus scraper — url.retail.publishedprices.co.il
 * Covers: רמי לוי, יוחננוף, אושר עד, and others
 *
 * The Cerberus system requires login. To use this scraper:
 *   1. Register at https://url.retail.publishedprices.co.il/login
 *   2. Set env vars: CERBERUS_USER and CERBERUS_PASS
 *
 * Without credentials → returns empty (gracefully skipped)
 */

import axios from 'axios'
import https from 'https'
import zlib from 'zlib'
import { promisify } from 'util'
import { XMLParser } from 'fast-xml-parser'

const gunzip = promisify(zlib.gunzip)

const BASE = 'https://url.retail.publishedprices.co.il'

// SSL agent that ignores self-signed cert (the site has cert issues)
const httpsAgent = new https.Agent({ rejectUnauthorized: false })

// Chain IDs on Cerberus → our brand key
const CHAIN_MAP = {
  '7290058140886': 'ramilevi',  // רמי לוי
  '7290055700007': 'yohananof', // יוחננוף
  '7290696200003': 'osher',     // אושר עד
  '7290876100000': 'osher',     // אושר עד (alt)
}

async function login(user, pass) {
  const res = await axios.post(
    `${BASE}/login`,
    new URLSearchParams({ username: user, password: pass }).toString(),
    {
      httpsAgent,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      maxRedirects: 0,
      validateStatus: (s) => s < 400,
      timeout: 15000,
    }
  )
  // Grab session cookie
  const setCookie = res.headers['set-cookie'] || []
  const cookie = setCookie.map((c) => c.split(';')[0]).join('; ')
  if (!cookie) throw new Error('Login failed — no cookie returned')
  return cookie
}

async function getFileList(cookie) {
  const res = await axios.get(`${BASE}/file/d/`, {
    httpsAgent,
    headers: { Cookie: cookie },
    timeout: 20000,
  })
  const html = res.data

  // Parse links: href="/file/d/Price...gz" or similar
  const re = /href="([^"]*(?:PriceFull|Price)[^"]*\.gz[^"]*)"/gi
  const files = []
  let m
  while ((m = re.exec(html)) !== null) {
    const url = m[1].startsWith('http') ? m[1] : `${BASE}${m[1]}`
    files.push(url)
  }
  return files
}

async function parseGzFile(url, cookie, label) {
  const res = await axios.get(url, {
    httpsAgent,
    headers: { Cookie: cookie },
    responseType: 'arraybuffer',
    timeout: 90000,
  })

  const xml = (await gunzip(Buffer.from(res.data))).toString('utf8')
  const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: true, trimValues: true })
  const doc = parser.parse(xml)

  const root = doc?.root || doc?.Prices || doc
  const chainId = String(root?.ChainId || '')
  const brand = CHAIN_MAP[chainId] || 'unknown'

  const products = root?.Products?.Product || root?.Items?.Item || []
  const arr = Array.isArray(products) ? products : [products]

  const prices = {}
  for (const p of arr) {
    if (!p) continue
    const code = String(p?.ItemCode ?? '').trim()
    const price = parseFloat(p?.ItemPrice ?? p?.Price ?? 0)
    if (code.length >= 8 && /^\d+$/.test(code) && price > 0) {
      prices[code] = price
    }
  }

  console.log(`[Cerberus:${label}] Chain ${chainId} (${brand}) → ${Object.keys(prices).length} barcodes`)
  return { brand, prices }
}

export async function scrape() {
  const user = process.env.CERBERUS_USER
  const pass = process.env.CERBERUS_PASS

  if (!user || !pass) {
    console.log('[Cerberus] No credentials set (CERBERUS_USER / CERBERUS_PASS) — skipping')
    return {}
  }

  try {
    console.log('[Cerberus] Logging in...')
    const cookie = await login(user, pass)

    const files = await getFileList(cookie)
    console.log(`[Cerberus] Found ${files.length} files`)

    // One representative file per chain
    const seen = new Set()
    const result = {}

    for (const url of files) {
      const fnMatch = url.match(/Price(\d{13})-/)
      const chainId = fnMatch?.[1]
      if (!chainId || seen.has(chainId)) continue
      seen.add(chainId)

      const brand = CHAIN_MAP[chainId]
      if (!brand) continue

      try {
        const { prices } = await parseGzFile(url, cookie, chainId)
        if (!result[brand]) result[brand] = {}
        for (const [barcode, price] of Object.entries(prices)) {
          if (!(barcode in result[brand]) || price < result[brand][barcode]) {
            result[brand][barcode] = price
          }
        }
      } catch (err) {
        console.warn(`[Cerberus] File error for chain ${chainId}: ${err.message}`)
      }
    }

    return result
  } catch (err) {
    console.warn(`[Cerberus] Scrape failed: ${err.message}`)
    return {}
  }
}
