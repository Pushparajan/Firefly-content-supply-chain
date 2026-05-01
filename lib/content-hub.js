'use strict'

/**
 * Adobe Content Hub (Brand Portal) API wrapper.
 *
 * Content Hub is the agency-facing upload surface. External studios upload
 * raw creative assets here without AEM author access. This module:
 *  - Lists new contributions from an agency-designated folder
 *  - Downloads the asset binary and its metadata
 *  - Marks a contribution as "processed" after successful AEM ingestion
 *
 * Content Hub REST API base: https://{tenant}.brand-portal.adobe.com/api/assets
 * Auth: same IMS OAuth S2S token as AEM (add 'brand_portal' scope)
 */

const fetch = require('node-fetch')
const logger = require('@adobe/aio-lib-core-logging')(
  'firefly-content-supply-chain:content-hub',
  { level: process.env.LOG_LEVEL || 'info' }
)

// ---------------------------------------------------------------------------
// Asset contribution listing
// ---------------------------------------------------------------------------

/**
 * List new/unprocessed asset contributions in a Content Hub folder.
 *
 * Agencies upload to a designated "contribution folder" that has the
 * contributionStatus property set to "NEW" until processed.
 *
 * @param {object} opts
 * @param {string}   opts.contentHubHost   e.g. https://acme.brand-portal.adobe.com
 * @param {string}   opts.imsToken         IMS bearer token with brand_portal scope
 * @param {string}   opts.contributionPath DAM path configured as contribution folder
 * @param {number}   [opts.limit=50]       Page size
 * @returns {Promise<Array<ContentHubAsset>>}
 */
async function listNewContributions ({ contentHubHost, imsToken, contributionPath, limit = 50 }) {
  // Content Hub uses AEM Assets HTTP API format with a status filter
  const url =
    `${contentHubHost}/api/assets${contributionPath}.json` +
    `?limit=${limit}&orderby=jcr:created&order=desc`

  logger.info('Listing Content Hub contributions', { contributionPath, limit })

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${imsToken}` }
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(
      `Content Hub list failed [${response.status}] at ${url}: ${body}`
    )
  }

  const data = await response.json()
  const entities = data?.entities || []

  // Filter to only unprocessed contributions
  const newAssets = entities.filter(
    (e) =>
      e?.properties?.['dam:contributionStatus'] === 'NEW' ||
      !e?.properties?.['dam:contributionStatus']
  )

  logger.info('Found new Content Hub contributions', {
    total: entities.length,
    unprocessed: newAssets.length
  })

  return newAssets.map(normalizeContributionAsset)
}

/**
 * Fetch the full metadata record for a single Content Hub asset.
 *
 * @param {object} opts
 * @param {string}   opts.contentHubHost
 * @param {string}   opts.imsToken
 * @param {string}   opts.assetPath   AEM path of the asset in Content Hub
 * @returns {Promise<ContentHubAsset>}
 */
async function getAssetMetadata ({ contentHubHost, imsToken, assetPath }) {
  const url = `${contentHubHost}/api/assets${assetPath}.json`

  logger.info('Fetching Content Hub asset metadata', { assetPath })

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${imsToken}` }
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(
      `Content Hub metadata fetch failed [${response.status}]: ${body}`
    )
  }

  const data = await response.json()
  return normalizeContributionAsset(data)
}

/**
 * Download the binary of a Content Hub asset into a Buffer.
 *
 * @param {object} opts
 * @param {string}   opts.contentHubHost
 * @param {string}   opts.imsToken
 * @param {string}   opts.assetPath      Path in Content Hub, e.g. /ACME/uploads/hero.psd
 * @returns {Promise<{buffer: Buffer, contentType: string}>}
 */
async function downloadAsset ({ contentHubHost, imsToken, assetPath }) {
  // Content Hub serves the binary at the asset path without extension suffix
  const url = `${contentHubHost}/content/dam${assetPath}`

  logger.info('Downloading Content Hub asset binary', { assetPath })

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${imsToken}` }
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(
      `Content Hub download failed [${response.status}] for ${assetPath}: ${body}`
    )
  }

  const buffer = Buffer.from(await response.arrayBuffer())
  const contentType =
    response.headers.get('content-type') || 'application/octet-stream'

  logger.info('Content Hub asset downloaded', {
    assetPath,
    bytes: buffer.length,
    contentType
  })

  return { buffer, contentType }
}

/**
 * Mark a Content Hub contribution as processed so it won't be re-ingested.
 * Updates the dam:contributionStatus metadata property to "PROCESSED".
 *
 * @param {object} opts
 * @param {string}   opts.contentHubHost
 * @param {string}   opts.imsToken
 * @param {string}   opts.assetPath
 * @param {string}   [opts.aemAssetPath]  Path of the resulting AEM asset (for audit)
 * @returns {Promise<void>}
 */
async function markContributionProcessed ({
  contentHubHost,
  imsToken,
  assetPath,
  aemAssetPath
}) {
  // Content Hub uses AEM PATCH semantics for metadata updates
  const url = `${contentHubHost}/api/assets${assetPath}`

  const patch = [
    {
      op: 'replace',
      path: 'properties/dam:contributionStatus',
      value: 'PROCESSED'
    }
  ]

  if (aemAssetPath) {
    patch.push({
      op: 'add',
      path: 'properties/dam:aemAssetPath',
      value: aemAssetPath
    })
  }

  logger.info('Marking Content Hub contribution as processed', {
    assetPath,
    aemAssetPath
  })

  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${imsToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(patch)
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(
      `Content Hub PATCH failed [${response.status}] for ${assetPath}: ${body}`
    )
  }

  logger.info('Content Hub contribution marked PROCESSED', { assetPath })
}

// ---------------------------------------------------------------------------
// Internal normalizer
// ---------------------------------------------------------------------------

/**
 * Normalize a raw Content Hub entity into a flat, predictable shape
 * that the taxonomy mapper and ingest action can consume.
 *
 * @param {object} raw  Raw entity from Content Hub API
 * @returns {ContentHubAsset}
 *
 * @typedef {object} ContentHubAsset
 * @property {string}  assetPath         AEM path within Content Hub
 * @property {string}  fileName
 * @property {string}  mimeType
 * @property {number}  fileSize
 * @property {string}  contributionStatus  'NEW' | 'PROCESSED'
 * @property {object}  agencyMetadata      Raw free-text metadata from agency
 */
function normalizeContributionAsset (raw) {
  const props = raw?.properties || {}
  return {
    assetPath: raw?.id || raw?.path || '',
    fileName: props['dc:title'] || props.name || '',
    mimeType: props['dc:format'] || props['jcr:mimeType'] || 'application/octet-stream',
    fileSize: parseInt(props['dam:assetSize'] || props['jcr:content/metadata/dam:size'] || '0', 10),
    contributionStatus: props['dam:contributionStatus'] || 'NEW',
    agencyMetadata: {
      season: props['dam:season'] || props['xmp:Season'] || '',
      market: props['dam:market'] || props['xmp:Market'] || '',
      brand: props['dam:brand'] || props['xmp:Brand'] || '',
      assetType: props['dam:assetType'] || props['xmp:AssetType'] || '',
      campaign: props['dam:campaign'] || props['xmp:Campaign'] || '',
      colorPalette: props['dam:colorPalette'] || props['xmp:ColorPalette'] || '',
      usageRights: props['dam:usageRights'] || props['xmp:UsageRights'] || '',
      agencyName: props['dam:agencyName'] || props['xmp:Agency'] || '',
      description: props['dc:description'] || ''
    }
  }
}

module.exports = {
  listNewContributions,
  getAssetMetadata,
  downloadAsset,
  markContributionProcessed
}
