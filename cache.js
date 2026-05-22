/**
 * In-memory price cache
 * Structure: { barcode: { shufersal: 8.90, ramilevi: 7.50, ... } }
 */

let priceCache = {}
let nameCache = {}
let storeCache = []
let lastUpdated = null
let chainStats = {}

export function setCache(data, stats = {}, names = {}) {
  priceCache = data
  lastUpdated = new Date().toISOString()
  chainStats = stats
  nameCache = names
  console.log(`[Cache] Updated: ${Object.keys(priceCache).length} barcodes, ${Object.keys(nameCache).length} names, chains: ${JSON.stringify(stats)}`)
}

/**
 * Generate lookup candidates for a barcode.
 * Israeli EAN-13 (729...) products are stored in government XML
 * under internal codes that are often just the suffix of the EAN-13.
 * e.g. "7290002040891" → try also "2040891", "02040891", "002040891"
 */
function barcodeCandidates(barcode) {
  const clean = String(barcode).replace(/\D/g, '')
  const candidates = [clean]

  if (clean.length === 13 && clean.startsWith('729')) {
    // Strip 729 prefix → 10 digits
    candidates.push(clean.slice(3))
    // Strip leading zeros from that
    const stripped = clean.slice(3).replace(/^0+/, '')
    if (stripped) candidates.push(stripped)
    // Also try last 8 and last 7 digits directly
    candidates.push(clean.slice(-8))
    candidates.push(clean.slice(-7))
  }

  // Deduplicate while preserving order
  return [...new Set(candidates)]
}

export function getByBarcode(barcode) {
  for (const c of barcodeCandidates(barcode)) {
    if (priceCache[c]) return priceCache[c]
  }
  return null
}

export function getNameByBarcode(barcode) {
  for (const c of barcodeCandidates(barcode)) {
    if (nameCache[c]) return nameCache[c]
  }
  return null
}

export function getCacheInfo() {
  return {
    totalBarcodes: Object.keys(priceCache).length,
    totalNames: Object.keys(nameCache).length,
    lastUpdated,
    chainStats,
  }
}

export function setStores(stores) {
  storeCache = stores
  console.log(`[Cache] Stores: ${stores.length} store locations loaded`)
}

export function getStores() {
  return storeCache
}

export function isCacheReady() {
  return Object.keys(priceCache).length > 0
}
