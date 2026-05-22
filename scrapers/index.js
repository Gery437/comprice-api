/**
 * Orchestrates all scrapers and builds the unified price cache.
 * Structure: priceMap[barcode] = { shufersal: 8.90, ramilevi: 7.50, ... }
 */

import { scrape as scrapeShufersal } from './shufersal.js'
import { scrape as scrapeCerberus } from './cerberus.js'
import { setCache } from '../cache.js'

/** Wrap a promise with a max timeout — resolves to null if time exceeded */
function withTimeout(promise, ms, label) {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      console.warn(`[timeout] ${label} exceeded ${ms / 1000}s — skipping`)
      resolve(null)
    }, ms)
    promise.then(
      (v) => { clearTimeout(t); resolve(v) },
      (e) => { clearTimeout(t); console.error(`[error] ${label}: ${e.message}`); resolve(null) }
    )
  })
}

export async function refreshAllPrices() {
  console.log('\n========== Starting price refresh ==========')
  const startTime = Date.now()

  // Run all scrapers in parallel, each with a max timeout
  const MAX_SHUFERSAL = 8 * 60 * 1000  // 8 minutes
  const MAX_CERBERUS  = 5 * 60 * 1000  // 5 minutes (3-step auth + parallel file downloads)

  const [shufersalResult, cerberusResult] = await Promise.all([
    withTimeout(scrapeShufersal(), MAX_SHUFERSAL, 'Shufersal'),
    withTimeout(scrapeCerberus(),  MAX_CERBERUS,  'Cerberus'),
  ])

  // Merge all chain results into one map: barcode → { chain: price }
  const priceMap = {}
  const chainStats = {}
  const allNames = {}

  function mergeChain(chainKey, data) {
    if (!data || typeof data !== 'object') return
    let count = 0
    for (const [barcode, price] of Object.entries(data)) {
      if (!priceMap[barcode]) priceMap[barcode] = {}
      priceMap[barcode][chainKey] = price
      count++
    }
    if (count > 0) {
      chainStats[chainKey] = count
      console.log(`[merge] ${chainKey}: ${count} barcodes`)
    }
  }

  function mergeName(names) {
    if (!names || typeof names !== 'object') return
    for (const [barcode, name] of Object.entries(names)) {
      if (!allNames[barcode]) allNames[barcode] = name
    }
  }

  // Shufersal returns { shufersal: {...}, yesh: {...}, names: {...} }
  if (shufersalResult) {
    mergeChain('shufersal', shufersalResult.shufersal)
    mergeChain('yesh', shufersalResult.yesh)
    mergeName(shufersalResult.names)
  }

  // Cerberus returns { ramilevi: {...}, yohananof: {...}, osher: {...}, ..., _names: {...} }
  if (cerberusResult) {
    for (const [chain, data] of Object.entries(cerberusResult)) {
      if (chain === '_names') continue
      mergeChain(chain, data)
    }
    mergeName(cerberusResult._names)
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`\n[refresh] Done in ${elapsed}s — ${Object.keys(priceMap).length} total barcodes, ${Object.keys(allNames).length} names`)
  console.log('==========================================\n')

  setCache(priceMap, chainStats, allNames)
  return priceMap
}
