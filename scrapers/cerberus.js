/**
 * Cerberus scraper — url.publishedprices.co.il
 * Covers: רמי לוי, יוחננוף, אושר עד, חצי חינם, טיב טעם
 *
 * Auth flow (3-step with CSRF):
 *   1. GET /login → extract csrftoken from meta tag
 *   2. POST /login/user with username + csrftoken + r redirect param → session cookie
 *   3. GET /file/d/{chain}/ → extract new csrftoken for API calls
 *   4. POST /file/json/dir/d/{chain}/ with DataTables params + csrftoken → file list JSON
 *   5. Download + parse PriceFull gz files
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

const FILES_PER_CHAIN = {
  RamiLevi:  5,
  Yohananof: 4,
  osherad:   4,
  HaziHinam: 3,
}

function extractCsrf(html) {
  const m = html.match(/csrftoken['"]\s+content=['"]([^'"]+)['"]/)
    || html.match(/name=['"]csrftoken['"][^>]+value=['"]([^'"]+)['"]/)
    || html.match(/content=['"]([^'"]+)['"]\s+name=['"]csrftoken['"]/)
  return m ? m[1] : ''
}

/** Merge Set-Cookie headers into a single cookie string (later values override earlier) */
function mergeCookies(...headerArrays) {
  const map = new Map()
  for (const headers of headerArrays) {
    for (const h of (headers || [])) {
      const [pair] = h.split(';')
      const eqIdx = pair.indexOf('=')
      if (eqIdx < 0) continue
      const name = pair.substring(0, eqIdx).trim()
      map.set(name, pair.trim())
    }
  }
  return [...map.values()].join('; ')
}

/** Full 3-step auth flow → returns { cookie, csrf } ready for DataTables API calls
 *  1. GET /login → csrf1 + initial session cookie
 *  2. POST /login/user (maxRedirects:0) → 302 + NEW authenticated session cookie
 *  3. GET /file/d/{chain}/ with authenticated cookie → CSRF token for API calls
 */
async function authenticate(chainName) {
  // Step 1: GET login page → initial CSRF + session cookie
  const loginPage = await axios.get(`${BASE}/login`, {
    httpsAgent, timeout: 12000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CompriceBot/1.0)' },
    validateStatus: (s) => s < 500,
  })
  const csrf1 = extractCsrf(loginPage.data)
  const cookie1 = mergeCookies(loginPage.headers['set-cookie'])

  // Step 2: POST login → 302 + Set-Cookie with NEW authenticated session
  // Do NOT follow redirect — we need the Set-Cookie from the 302 response
  const loginRes = await axios.post(
    `${BASE}/login/user`,
    new URLSearchParams({
      username: chainName,
      password: '',
      r: `/file/d/${chainName}/`,
      csrftoken: csrf1,
    }).toString(),
    {
      httpsAgent,
      timeout: 12000,
      maxRedirects: 0,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (compatible; CompriceBot/1.0)',
        Cookie: cookie1,
      },
      validateStatus: (s) => s < 500,
    }
  )
  if (loginRes.status !== 302) {
    throw new Error(`Login failed for ${chainName} — status ${loginRes.status} (expected 302)`)
  }

  // Merge cookies: loginRes overrides loginPage for the same cookie name
  const cookie2 = mergeCookies(loginPage.headers['set-cookie'], loginRes.headers['set-cookie'])

  // Step 3: GET file listing page with authenticated cookie → extract CSRF for DataTables API
  const filePage = await axios.get(`${BASE}/file/d/${chainName}/`, {
    httpsAgent,
    timeout: 12000,
    headers: {
      Cookie: cookie2,
      'User-Agent': 'Mozilla/5.0 (compatible; CompriceBot/1.0)',
    },
    validateStatus: (s) => s < 500,
  })
  const isLoginPage = filePage.data.includes('id="login-form"')
  if (isLoginPage) throw new Error(`Auth failed for ${chainName} — file page returned login form`)

  const csrf2 = extractCsrf(filePage.data)
  if (!csrf2) throw new Error(`No CSRF token on file page for ${chainName}`)

  // Include any new cookies set on the file page
  const cookieFinal = mergeCookies(
    loginPage.headers['set-cookie'],
    loginRes.headers['set-cookie'],
    filePage.headers['set-cookie']
  )
  console.log(`[Cerberus:${chainName}] Auth OK`)
  return { cookie: cookieFinal, csrf: csrf2 }
}

/** Get list of PriceFull filenames via DataTables JSON API */
async function getPriceFullFiles(chainName, cookie, csrf, maxFiles = 5) {
  const res = await axios.post(
    `${BASE}/file/json/dir/d/${chainName}/`,
    new URLSearchParams({
      sEcho: '1',
      iDisplayStart: '0',
      iDisplayLength: '100',
      sSearch: 'PriceFull',
      iSortCol_0: '3',
      sSortDir_0: 'desc',
      csrftoken: csrf,
    }).toString(),
    {
      httpsAgent,
      timeout: 15000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: cookie,
        'User-Agent': 'Mozilla/5.0 (compatible; CompriceBot/1.0)',
      },
      validateStatus: (s) => s < 500,
    }
  )

  const data = res.data
  if (!data?.aaData?.length) {
    throw new Error(`No PriceFull files listed for ${chainName} (aaData empty)`)
  }

  return data.aaData
    .filter(f => f.fname && /PriceFull/i.test(f.fname))
    .slice(0, maxFiles)
    .map(f => `${BASE}/file/d/${f.fname}`)  // no chainName in download path!
}

/** Download + decompress + parse one PriceFull .gz file → { barcode: price } */
async function parseGzFile(url, cookie) {
  const res = await axios.get(url, {
    httpsAgent,
    responseType: 'arraybuffer',
    timeout: 60000,
    headers: {
      Cookie: cookie,
      'User-Agent': 'Mozilla/5.0 (compatible; CompriceBot/1.0)',
    },
    maxContentLength: 100 * 1024 * 1024,
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
      if (!(code in prices) || price < prices[code]) {
        prices[code] = price
      }
    }
  }
  return prices
}

/** Scrape one chain end-to-end */
async function scrapeChain(chainName, maxFiles) {
  const { cookie, csrf } = await authenticate(chainName)
  const urls = await getPriceFullFiles(chainName, cookie, csrf, maxFiles)
  console.log(`[Cerberus:${chainName}] ${urls.length} PriceFull files`)

  const merged = {}
  const downloads = urls.map(url =>
    parseGzFile(url, cookie)
      .then(prices => {
        const n = Object.keys(prices).length
        console.log(`[Cerberus:${chainName}] file OK — ${n} barcodes`)
        return prices
      })
      .catch(err => {
        console.warn(`[Cerberus:${chainName}] file error: ${err.message.substring(0, 80)}`)
        return null
      })
  )

  const results = await Promise.all(downloads)
  for (const prices of results) {
    if (!prices) continue
    for (const [b, p] of Object.entries(prices)) {
      if (!(b in merged) || p < merged[b]) merged[b] = p
    }
  }
  return merged
}

export async function scrape() {
  const result = {}

  await Promise.all(
    Object.entries(CHAINS).map(async ([chainName, brandKey]) => {
      const maxFiles = FILES_PER_CHAIN[chainName] ?? 3
      try {
        const prices = await scrapeChain(chainName, maxFiles)
        const count = Object.keys(prices).length
        if (count > 0) {
          if (!result[brandKey]) result[brandKey] = {}
          for (const [b, p] of Object.entries(prices)) {
            if (!(b in result[brandKey]) || p < result[brandKey][b]) {
              result[brandKey][b] = p
            }
          }
          console.log(`[Cerberus] ✓ ${chainName} → ${count} barcodes merged into '${brandKey}'`)
        }
      } catch (err) {
        console.warn(`[Cerberus] ✗ ${chainName}: ${err.message}`)
      }
    })
  )

  return result
}
