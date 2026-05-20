/**
 * Orchestrates all scrapers and builds the unified price cache.
 * Structure: priceMap[barcode] = { shufersal: 8.90, ramilevi: 7.50, ... }
 */

import { scrape as scrapeShufersal } from './shufersal.js'
import { scrape as scrapeCerberus } from './cerberus.js'
import { setCache } from '../cache.js'

export async function refreshAllPrices() {
  console.log('\n========== Starting price refresh ==========')
  const startTime = Date.now()

  // Run all scrapers (don't let one failure stop others)
  const [shufersalResult, cerberusResult] = await Promise.allSettled([
    scrapeShufersal(),
    scrapeCerberus(),
  ])

  // Merge all chain results into one map: barcode → { chain: price }
  const priceMap = {}
  const chainStats = {}

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

  // Process Shufersal result (returns { shufersal: {...}, yesh: {...} })
  if (shufersalResult.status === 'fulfilled') {
    const res = shufersalResult.value
    mergeChain('shufersal', res.shufersal)
    mergeChain('yesh', res.yesh)
  } else {
    console.error('[Shufersal] Scraper failed:', shufersalResult.reason?.message)
  }

  // Process Cerberus result (returns { ramilevi: {...}, yohananof: {...}, osher: {...} })
  if (cerberusResult.status === 'fulfilled') {
    const res = cerberusResult.value
    for (const [chain, data] of Object.entries(res)) {
      mergeChain(chain, data)
    }
  } else {
    console.error('[Cerberus] Scraper failed:', cerberusResult.reason?.message)
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`\n[refresh] Done in ${elapsed}s — ${Object.keys(priceMap).length} total barcodes`)
  console.log('==========================================\n')

  setCache(priceMap, chainStats)
  return priceMap
}
