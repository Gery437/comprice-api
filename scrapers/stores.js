/**
 * Real store locations — fetched from Overpass API (OpenStreetMap)
 *
 * Single query returns all tagged supermarkets in Israel with lat/lng.
 * Matched to our chain keys by name/brand/operator tags.
 */

import axios from 'axios'
import https from 'https'
import zlib from 'zlib'
import { promisify } from 'util'
import { XMLParser } from 'fast-xml-parser'

const gunzip = promisify(zlib.gunzip)
const httpsAgent = new https.Agent({ rejectUnauthorized: false })
const BASE_CERBERUS = 'https://url.publishedprices.co.il'
const BASE_SHUFERSAL = 'http://prices.shufersal.co.il'

// Chain pattern matchers (name, brand, or operator tags)
// NOTE: "יש בשכונה" and "יש חסד" are both Shufersal sub-brands
const CHAIN_MATCHERS = [
  { key: 'shufersal', pattern: /שופרסל|shufersal|יש בשכונה|yesh.?bash?k?una/i },
  { key: 'yesh',      pattern: /יש חסד|yesh.?h[ae]sed/i },
  { key: 'ramilevi',  pattern: /רמי לוי|rami.?levy/i },
  { key: 'yohananof', pattern: /יוחננוף|yohananof/i },
  { key: 'osher',     pattern: /אושר עד|osher.?ad|חצי חינם|hazi.?hinam/i },
  { key: 'mega',      pattern: /מגה בול|mega.?bool|mega/i },
  { key: 'victory',   pattern: /ויקטורי|victory/i },
  { key: 'yeinot',    pattern: /יינות ביתן|yeinot.?bitan/i },
]

function matchChain(tags) {
  const text = `${tags.name || ''} ${tags.brand || ''} ${tags.operator || ''}`.toLowerCase()
  for (const { key, pattern } of CHAIN_MATCHERS) {
    if (pattern.test(text)) return key
  }
  return null
}

/**
 * Primary source: Overpass API (OpenStreetMap)
 * Uses Israel bounding box (29.45,34.27,33.34,35.90) — faster & more reliable than area lookup.
 * Returns stores with real lat/lng already included.
 */
async function fetchOverpassStores() {
  // Israel bounding box: south, west, north, east
  const BBOX = '29.45,34.27,33.34,35.90'
  const query = `[out:json][timeout:60];(nwr[shop=supermarket](${BBOX});nwr[shop=grocery](${BBOX}););out center;`

  console.log('[Stores:Overpass] Querying all supermarkets in Israel (bbox)...')

  // Try multiple Overpass mirrors
  const mirrors = [
    'https://overpass-api.de/api/interpreter',
    'https://lz4.overpass-api.de/api/interpreter',
    'https://z.overpass-api.de/api/interpreter',
  ]

  let res = null
  for (const mirror of mirrors) {
    try {
      res = await axios.post(mirror, query, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'ComPrice/1.0 (doublegil@gmail.com)',
          'Accept': 'application/json',
        },
        timeout: 90000,
      })
      if (res.status === 200) break
    } catch (err) {
      console.warn(`[Stores:Overpass] mirror ${mirror} failed: ${err.message}`)
      res = null
    }
  }

  if (!res) throw new Error('All Overpass mirrors failed')
  const elements = res.data?.elements || []
  const stores = []

  for (const el of elements) {
    const tags = el.tags || {}
    const chainKey = matchChain(tags)
    if (!chainKey) continue

    const lat = el.type === 'node' ? el.lat : el.center?.lat
    const lng = el.type === 'node' ? el.lon : el.center?.lon
    if (!lat || !lng) continue

    const street = tags['addr:street'] || ''
    const num = tags['addr:housenumber'] || ''
    const address = [street, num].filter(Boolean).join(' ') || tags['addr:full'] || ''
    const city = tags['addr:city'] || tags['addr:town'] || tags['addr:suburb'] || ''

    stores.push({
      id: `osm_${el.id}`,
      chainKey,
      name: tags.name || tags.brand || tags.operator || chainKey,
      address,
      city,
      lat: parseFloat(lat),
      lng: parseFloat(lng),
    })
  }

  console.log(`[Stores:Overpass] ${stores.length} matched stores`)
  return stores
}

// ── Cerberus auth helpers (duplicated here to keep stores.js self-contained) ──

function extractCsrf(html) {
  const m = html.match(/csrftoken['"]\s+content=['"]([^'"]+)['"]/)
    || html.match(/name=['"]csrftoken['"][^>]+value=['"]([^'"]+)['"]/)
    || html.match(/content=['"]([^'"]+)['"]\s+name=['"]csrftoken['"]/)
  return m ? m[1] : ''
}

function mergeCookies(...headerArrays) {
  const map = new Map()
  for (const headers of headerArrays) {
    for (const h of (headers || [])) {
      const [pair] = h.split(';')
      const eqIdx = pair.indexOf('=')
      if (eqIdx < 0) continue
      map.set(pair.substring(0, eqIdx).trim(), pair.trim())
    }
  }
  return [...map.values()].join('; ')
}

async function cerberusAuth(chainName) {
  const loginPage = await axios.get(`${BASE_CERBERUS}/login`, {
    httpsAgent, timeout: 12000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CompriceBot/1.0)' },
    validateStatus: s => s < 500,
  })
  const csrf1 = extractCsrf(loginPage.data)
  const loginRes = await axios.post(
    `${BASE_CERBERUS}/login/user`,
    new URLSearchParams({ username: chainName, password: '', r: `/file/d/${chainName}/`, csrftoken: csrf1 }).toString(),
    {
      httpsAgent, timeout: 12000, maxRedirects: 0,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0', Cookie: mergeCookies(loginPage.headers['set-cookie']) },
      validateStatus: s => s < 500,
    }
  )
  const cookie2 = mergeCookies(loginPage.headers['set-cookie'], loginRes.headers['set-cookie'])
  const filePage = await axios.get(`${BASE_CERBERUS}/file/d/${chainName}/`, {
    httpsAgent, timeout: 12000,
    headers: { Cookie: cookie2, 'User-Agent': 'Mozilla/5.0' },
    validateStatus: s => s < 500,
  })
  const csrf2 = extractCsrf(filePage.data)
  const cookieFinal = mergeCookies(loginPage.headers['set-cookie'], loginRes.headers['set-cookie'], filePage.headers['set-cookie'])
  return { cookie: cookieFinal, csrf: csrf2 }
}

/** Parse stores from government XML (no coordinates — used as fallback name/address source) */
function parseStoresXml(xml, chainKey) {
  try {
    const parser = new XMLParser({ parseTagValue: true, trimValues: true })
    const doc = parser.parse(xml)
    const root = doc?.StorePackage || doc?.Root || doc?.root || doc
    const raw = root?.Stores?.Store || root?.Stores?.Branch || []
    const arr = Array.isArray(raw) ? raw : (raw ? [raw] : [])
    return arr.map(s => ({
      id: String(s?.StoreId ?? s?.BranchId ?? '').trim(),
      chainKey,
      name: String(s?.StoreName ?? s?.BranchName ?? '').trim(),
      address: String(s?.Address ?? s?.StoreAddress ?? '').trim(),
      city: String(s?.City ?? '').trim(),
      lat: parseFloat(s?.Latitude ?? s?.Lat ?? '') || null,
      lng: parseFloat(s?.Longitude ?? s?.Long ?? '') || null,
    })).filter(s => s.name || s.address)
  } catch {
    return []
  }
}

/**
 * Fallback: fetch store list from Cerberus government XML.
 * These include address+city but usually no lat/lng.
 */
async function fetchCerberusChainStores(chainName, brandKey) {
  const { cookie, csrf } = await cerberusAuth(chainName)
  const listRes = await axios.post(
    `${BASE_CERBERUS}/file/json/dir/d/${chainName}/`,
    new URLSearchParams({
      sEcho: '1', iDisplayStart: '0', iDisplayLength: '50',
      sSearch: 'Stores', iSortCol_0: '3', sSortDir_0: 'desc', csrftoken: csrf,
    }).toString(),
    {
      httpsAgent, timeout: 15000,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie, 'User-Agent': 'Mozilla/5.0' },
      validateStatus: s => s < 500,
    }
  )
  const files = (listRes.data?.aaData || [])
    .filter(f => f.fname && /Stores/i.test(f.fname))
    .slice(0, 1)
    .map(f => `${BASE_CERBERUS}/file/d/${f.fname}`)

  if (files.length === 0) return []
  const res = await axios.get(files[0], {
    httpsAgent, responseType: 'arraybuffer', timeout: 30000,
    headers: { Cookie: cookie, 'User-Agent': 'Mozilla/5.0' },
    maxContentLength: 20 * 1024 * 1024,
  })
  const xml = (await gunzip(Buffer.from(res.data))).toString('utf8')
  return parseStoresXml(xml, brandKey)
}

/**
 * Fallback: fetch Shufersal store list from government XML.
 */
async function fetchShufersalStores() {
  const seenSubChains = new Set()
  const SUBCHAIN_MAP = {
    '001': 'shufersal', '002': 'shufersal', '003': 'shufersal',
    '004': 'shufersal', '005': 'shufersal', '007': 'shufersal',
    '008': 'yesh', '018': 'yesh',
  }
  const stores = []

  for (let page = 1; page <= 70; page++) {
    if (seenSubChains.size >= Object.keys(SUBCHAIN_MAP).length) break
    try {
      const res = await axios.get(`${BASE_SHUFERSAL}/?page=${page}`, {
        timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0' },
      })
      const re = /href="([^"]*Stores[^"]*\.gz[^"]*)"/gi
      let m
      while ((m = re.exec(res.data)) !== null) {
        const url = m[1].replace(/&amp;/g, '&').replace(/^(?!http)/, `${BASE_SHUFERSAL}/`)
        const sc = (url.match(/Stores\d+-(\d{3})-/) || [])?.[1]
        if (!sc || seenSubChains.has(sc) || !SUBCHAIN_MAP[sc]) continue
        seenSubChains.add(sc)
        try {
          const dl = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000, headers: { 'User-Agent': 'Mozilla/5.0' }, maxContentLength: 20 * 1024 * 1024 })
          const xml = (await gunzip(Buffer.from(dl.data))).toString('utf8')
          stores.push(...parseStoresXml(xml, SUBCHAIN_MAP[sc]))
        } catch (e) {
          console.warn(`[Stores:Shufersal:${sc}] ${e.message}`)
        }
      }
    } catch {}
  }
  return stores
}

/**
 * Simple Nominatim geocoder — for stores that have address but no lat/lng.
 * Rate limited to 1 req/second.
 */
async function geocodeAddress(address, city) {
  const q = [address, city, 'ישראל'].filter(Boolean).join(', ')
  try {
    await new Promise(r => setTimeout(r, 1200))
    const res = await axios.get('https://nominatim.openstreetmap.org/search', {
      params: { q, format: 'json', limit: 1, countrycodes: 'il' },
      timeout: 8000,
      headers: { 'User-Agent': 'ComPrice/1.0 (doublegil@gmail.com)' },
    })
    if (res.data.length > 0) {
      return { lat: parseFloat(res.data[0].lat), lng: parseFloat(res.data[0].lon) }
    }
  } catch {}
  return null
}

/**
 * Main export — returns all stores across all chains with real lat/lng.
 *
 * Strategy:
 *   1. Try Overpass API — returns all Israeli supermarkets with coordinates in one shot
 *   2. If Overpass has < 50 results, fallback to government XML + Nominatim geocoding
 */
export async function scrapeAllStores() {
  let stores = []

  // ── Strategy 1: Overpass (fast, has coordinates) ──
  try {
    stores = await fetchOverpassStores()
  } catch (err) {
    console.warn(`[Stores] Overpass failed: ${err.message} — trying government XML fallback`)
  }

  // ── Strategy 2: Government XML fallback if Overpass insufficient ──
  if (stores.length < 50) {
    console.log('[Stores] Overpass insufficient, fetching government XML files...')
    const govStores = []

    // Shufersal
    try {
      const s = await fetchShufersalStores()
      govStores.push(...s)
      console.log(`[Stores:Shufersal] ${s.length} stores from XML`)
    } catch (err) {
      console.warn(`[Stores:Shufersal] ${err.message}`)
    }

    // Cerberus chains
    const cerberusChains = [['RamiLevi', 'ramilevi'], ['Yohananof', 'yohananof'], ['osherad', 'osher']]
    for (const [chainName, brandKey] of cerberusChains) {
      try {
        const s = await fetchCerberusChainStores(chainName, brandKey)
        govStores.push(...s)
        console.log(`[Stores:${chainName}] ${s.length} stores from XML`)
      } catch (err) {
        console.warn(`[Stores:${chainName}] ${err.message}`)
      }
    }

    // Geocode stores that have address but no lat/lng
    const needGeocode = govStores.filter(s => !s.lat && (s.address || s.city))
    console.log(`[Stores] Geocoding ${needGeocode.length} stores (rate-limited)...`)
    for (const s of needGeocode) {
      const coords = await geocodeAddress(s.address, s.city)
      if (coords) { s.lat = coords.lat; s.lng = coords.lng }
    }

    const geocoded = govStores.filter(s => s.lat && s.lng)
    // Merge with any Overpass results (Overpass takes priority for same chain)
    const overpassIds = new Set(stores.map(s => `${s.chainKey}:${s.lat.toFixed(4)}:${s.lng.toFixed(4)}`))
    const newFromGov = geocoded.filter(s =>
      s.lat && !overpassIds.has(`${s.chainKey}:${s.lat.toFixed(4)}:${s.lng.toFixed(4)}`)
    )
    stores = [...stores, ...newFromGov]
    console.log(`[Stores] Added ${newFromGov.length} stores from government XML`)
  }

  // Deduplicate by proximity (< 50m apart in same chain = same store)
  const unique = []
  for (const s of stores) {
    const dup = unique.find(u =>
      u.chainKey === s.chainKey &&
      Math.abs(u.lat - s.lat) < 0.0005 &&
      Math.abs(u.lng - s.lng) < 0.0005
    )
    if (!dup) unique.push(s)
  }

  console.log(`[Stores] Final: ${unique.length} unique stores`)
  return unique
}
