/**
 * In-memory price cache
 * Structure: { barcode: { shufersal: 8.90, ramilevi: 7.50, ... } }
 */

let priceCache = {}
let lastUpdated = null
let chainStats = {}

export function setCache(data, stats = {}) {
  priceCache = data
  lastUpdated = new Date().toISOString()
  chainStats = stats
  console.log(`[Cache] Updated: ${Object.keys(priceCache).length} barcodes, chains: ${JSON.stringify(stats)}`)
}

export function getByBarcode(barcode) {
  const clean = String(barcode).replace(/\D/g, '')
  return priceCache[clean] || priceCache[barcode] || null
}

export function getCacheInfo() {
  return {
    totalBarcodes: Object.keys(priceCache).length,
    lastUpdated,
    chainStats,
  }
}

export function isCacheReady() {
  return Object.keys(priceCache).length > 0
}
