'use strict'

/**
 * Fusion Ingest Action – Content Hub → AEM Assets with Approved Taxonomy
 *
 * This App Builder web action is called by a Workfront Fusion scenario
 * whenever an agency uploads a new asset contribution to Content Hub.
 *
 * Fusion scenario flow (configured in Workfront Fusion):
 *   1. Trigger: Content Hub "New Contribution" watch module (polls every 15 min)
 *      OR: Content Hub AEM event via Adobe I/O Events
 *   2. HTTP module: POST to this action with the asset path + metadata
 *   3. This action performs: taxonomy validation → metadata mapping →
 *      folder resolution → AEM binary cloud upload
 *   4. Fusion receives the AEM asset path and posts it back to Workfront
 *      (Workfront module: "Update Document with AEM Path")
 *
 * Payload from Fusion:
 * {
 *   "assetPath": "/ACME/contributions/hero-banner-summer.psd",
 *   "agencyMetadata": {
 *     "season": "summer",
 *     "market": "emea",
 *     "brand": "Firefly Pro",
 *     "assetType": "hero banner",
 *     "campaign": "Summer 2025 Launch",
 *     "agencyName": "Studio Metropolis",
 *     "usageRights": "Digital & Print, 2 years",
 *     "description": "Hero banner for summer campaign, light mode"
 *   }
 * }
 */

const logger = require('@adobe/aio-lib-core-logging')(
  'firefly-content-supply-chain:fusion-ingest',
  { level: process.env.LOG_LEVEL || 'info' }
)

const { downloadAsset, markContributionProcessed } = require('../../lib/content-hub')
const { initiateUpload, uploadBinaryToCloud, completeUpload } = require('../../lib/aem-cloud')
const { mapToAemTaxonomy, validateRequiredTaxonomy } = require('../../lib/taxonomy')
const { resolveImsToken } = require('../../lib/ims')

// ---------------------------------------------------------------------------
// Action entry point
// ---------------------------------------------------------------------------

async function main (params) {
  logger.info('Fusion ingest action invoked')

  // ---- 0. Validate caller is Fusion via shared secret ----
  const fusionSecret =
    params.FUSION_INGEST_SECRET || process.env.FUSION_INGEST_SECRET
  const callerSecret =
    params.__ow_headers?.['x-fusion-secret'] || params.fusionSecret

  if (!fusionSecret || callerSecret !== fusionSecret) {
    logger.error('Fusion secret mismatch — rejecting ingest request')
    return errorResponse(401, 'Unauthorized: invalid Fusion ingest secret')
  }

  // ---- 1. Parse Fusion payload ----
  let body
  try {
    body = typeof params.__ow_body === 'string'
      ? JSON.parse(params.__ow_body)
      : (params.__ow_body || params)
  } catch {
    return errorResponse(400, 'Could not parse request body as JSON')
  }

  const { assetPath, agencyMetadata } = body

  if (!assetPath) {
    return errorResponse(400, 'Missing required field: assetPath')
  }
  if (!agencyMetadata || typeof agencyMetadata !== 'object') {
    return errorResponse(400, 'Missing required field: agencyMetadata (object)')
  }

  logger.info('Processing Content Hub contribution', {
    assetPath,
    agency: agencyMetadata.agencyName,
    brand: agencyMetadata.brand
  })

  // ---- 2. Resolve IMS token ----
  let imsToken
  try {
    imsToken = await resolveImsToken(params)
  } catch (imsError) {
    return errorResponse(500, `IMS authentication failed: ${imsError.message}`)
  }

  // ---- 3. Validate required taxonomy dimensions before any download ----
  // Fail fast: reject assets missing mandatory metadata so agencies must fix
  // the upload form fields rather than having garbage assets land in AEM.
  try {
    validateRequiredTaxonomy(agencyMetadata, ['brand', 'market', 'assetType'])
  } catch (taxError) {
    logger.warn('Taxonomy validation failed — returning 422 to Fusion', {
      error: taxError.message
    })
    // 422 Unprocessable: Fusion will surface this in the scenario error log
    // so the agency coordinator can fix the metadata and re-trigger.
    return errorResponse(422, taxError.message)
  }

  // ---- 4. Map agency free-text to AEM controlled vocabulary ----
  const baseFolder =
    params.AEM_UPLOAD_BASE_PATH || process.env.AEM_UPLOAD_BASE_PATH ||
    '/content/dam/campaigns'

  const { aemMetadata, targetFolder, warnings } = mapToAemTaxonomy(
    agencyMetadata,
    baseFolder
  )

  if (warnings.length > 0) {
    logger.warn('Taxonomy warnings (non-fatal)', { warnings })
  }

  // ---- 5. Download binary from Content Hub ----
  const contentHubHost =
    params.CONTENT_HUB_HOST || process.env.CONTENT_HUB_HOST

  let buffer, contentType
  try {
    ;({ buffer, contentType } = await downloadAsset({
      contentHubHost,
      imsToken,
      assetPath
    }))
  } catch (downloadError) {
    return errorResponse(502, `Content Hub download failed: ${downloadError.message}`)
  }

  const fileName = assetPath.split('/').pop() || 'agency-asset'

  // ---- 6. AEM Direct Binary Upload: Initiate ----
  const aemHost = params.AEM_HOST || process.env.AEM_HOST

  let initData
  try {
    initData = await initiateUpload({
      aemHost,
      imsToken,
      folderPath: targetFolder,
      files: [{ fileName, fileSize: buffer.length, mimeType: contentType }]
    })
  } catch (initError) {
    return errorResponse(502, `AEM initiate upload failed: ${initError.message}`)
  }

  const fileInfo = initData.files?.[0]
  if (!fileInfo) {
    return errorResponse(502, 'AEM initiate upload returned no file info')
  }

  // ---- 7. AEM Direct Binary Upload: Upload to cloud storage ----
  const uploadURI = fileInfo.uploadURIs?.[0]
  if (!uploadURI) {
    return errorResponse(502, 'AEM initiate upload returned no uploadURI')
  }

  try {
    await uploadBinaryToCloud({ uploadURI, buffer, mimeType: contentType })
  } catch (uploadError) {
    return errorResponse(502, `Cloud storage upload failed: ${uploadError.message}`)
  }

  // ---- 8. AEM Direct Binary Upload: Complete with taxonomy metadata ----
  let aemAsset
  try {
    aemAsset = await completeUpload({
      aemHost,
      imsToken,
      completeURI: initData.completeURI,
      uploadToken: fileInfo.uploadToken,
      fileName,
      mimeType: contentType,
      createVersion: false   // first-time ingestion: no version needed
    })
  } catch (completeError) {
    return errorResponse(502, `AEM complete upload failed: ${completeError.message}`)
  }

  // ---- 9. Apply taxonomy metadata to the AEM asset ----
  // After binary upload, patch the JCR metadata node with resolved tags.
  // Uses AEM Assets HTTP API PATCH to set dc:title, cq:tags, etc.
  try {
    await applyAemMetadata({
      aemHost,
      imsToken,
      assetJcrPath: aemAsset.path,
      metadata: aemMetadata
    })
  } catch (metaError) {
    // Metadata write failure is non-fatal — asset exists in AEM, tags can be
    // applied manually. Log clearly so ops can run a backfill script.
    logger.warn('AEM metadata apply failed (non-fatal)', {
      error: metaError.message,
      aemPath: aemAsset.path
    })
  }

  // ---- 10. Mark Content Hub contribution as processed ----
  try {
    await markContributionProcessed({
      contentHubHost,
      imsToken,
      assetPath,
      aemAssetPath: aemAsset.path
    })
  } catch (markError) {
    logger.warn('Content Hub status update failed (non-fatal)', {
      error: markError.message
    })
  }

  // ---- 11. Return to Fusion ----
  // Fusion reads this response and uses the aemAssetPath to update Workfront.
  const result = {
    success: true,
    sourceAssetPath: assetPath,
    aemAssetPath: aemAsset.path,
    targetFolder,
    appliedTags: aemMetadata['cq:tags'],
    taxonomyWarnings: warnings,
    agencyName: agencyMetadata.agencyName
  }

  logger.info('Fusion ingest complete', {
    aemAssetPath: aemAsset.path,
    tagCount: aemMetadata['cq:tags'].length
  })

  return successResponse(result)
}

// ---------------------------------------------------------------------------
// Apply AEM metadata via Assets HTTP API
// ---------------------------------------------------------------------------

/**
 * Patch JCR metadata properties onto an already-uploaded AEM asset.
 * Uses the AEM Assets HTTP API PATCH endpoint.
 *
 * @param {object} opts
 * @param {string}   opts.aemHost
 * @param {string}   opts.imsToken
 * @param {string}   opts.assetJcrPath  e.g. /content/dam/campaigns/emea/hero.jpg
 * @param {object}   opts.metadata      Key/value pairs to set on the metadata node
 */
async function applyAemMetadata ({ aemHost, imsToken, assetJcrPath, metadata }) {
  const fetch = require('node-fetch')

  // Build a flat form-body with property:value pairs for AEM Sling POST servlet
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(metadata)) {
    if (Array.isArray(value)) {
      for (const v of value) {
        params.append(`./jcr:content/metadata/${key}`, v)
      }
    } else if (value !== undefined && value !== null && value !== '') {
      params.append(`./jcr:content/metadata/${key}`, String(value))
    }
  }

  // AEM Sling POST servlet on the asset node
  const url = `${aemHost}${assetJcrPath}`

  logger.info('Applying AEM metadata via Sling POST', {
    assetJcrPath,
    keys: Object.keys(metadata)
  })

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${imsToken}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params.toString()
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(
      `AEM metadata PATCH failed [${response.status}] at ${url}: ${body}`
    )
  }

  logger.info('AEM metadata applied', { assetJcrPath })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function successResponse (body) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }
}

function errorResponse (statusCode, message) {
  logger.error(`Fusion ingest error [${statusCode}]: ${message}`)
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ success: false, error: message })
  }
}

module.exports = { main }
