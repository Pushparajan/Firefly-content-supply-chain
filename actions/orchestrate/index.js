'use strict'

/**
 * Content Supply Chain – Main Orchestration Action
 *
 * Entry point for the App Builder web action.
 *
 * Full pipeline:
 *  1. Verify Workfront HMAC-SHA256 webhook signature
 *  2. Parse objID / objCode from webhook payload
 *  3. Resolve IMS OAuth S2S access token
 *  4. Retrieve source Creative Cloud asset URL from Workfront
 *  5. Submit Firefly V3 async job (standard or custom model) with style_reference
 *  6. Poll Firefly until the job succeeds (or fails after max attempts)
 *  7. Build metadata backbone per variant (campaignCode, variantId, promptLineage, modelId)
 *  8. Upload every rendition to AEM Assets via Direct Binary Upload + backbone metadata
 *  9. Trigger offer-sync action (Firefly variants → AJO Offer Library)  [async, non-blocking]
 * 10. Update the Workfront record with generated AEM asset paths
 * 11. Return a structured JSON response
 */

const fetch = require('node-fetch')
const logger = require('@adobe/aio-lib-core-logging')(
  'firefly-content-supply-chain:orchestrate',
  { level: process.env.LOG_LEVEL || 'info' }
)

const { verifyWebhookSignature, parseWebhookPayload, getDocumentAssetUrl, updateWorkfrontObject } =
  require('../../lib/workfront')
const { generateAndWait } = require('../../lib/firefly-v3')
const { uploadRenditionsToAem } = require('../../lib/aem-cloud')
const { resolveImsToken } = require('../../lib/ims')
const { buildBackbone, backboneToAemMetadata } = require('../../lib/metadata-backbone')

// ---------------------------------------------------------------------------
// Action entry point
// ---------------------------------------------------------------------------

async function main (params) {
  logger.info('Orchestrate action invoked')

  // ---- 0. Validate required environment params ----
  const missingParams = requiredParams.filter(
    (key) => !params[key] && !process.env[key]
  )
  if (missingParams.length > 0) {
    return errorResponse(400, `Missing required params: ${missingParams.join(', ')}`)
  }

  // ---- 1. Verify Workfront webhook signature ----
  const rawBody = params.__ow_body || ''
  const signatureHeader =
    params.__ow_headers?.['x-wf-signature'] || ''
  const webhookSecret =
    params.WORKFRONT_WEBHOOK_SECRET || process.env.WORKFRONT_WEBHOOK_SECRET

  try {
    verifyWebhookSignature(rawBody, signatureHeader, webhookSecret)
  } catch (signatureError) {
    logger.error('Webhook signature rejected', { error: signatureError.message })
    return errorResponse(401, 'Webhook signature verification failed')
  }

  // ---- 2. Parse webhook payload ----
  let webhookPayload
  try {
    webhookPayload = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody
  } catch {
    return errorResponse(400, 'Could not parse webhook body as JSON')
  }

  let objID, objCode
  try {
    ;({ objID, objCode } = parseWebhookPayload(webhookPayload))
  } catch (parseError) {
    return errorResponse(400, parseError.message)
  }

  // Only process document-level events; ignore task/project events
  if (objCode !== 'DOCU') {
    logger.info('Ignoring non-document event', { objCode, objID })
    return successResponse({ skipped: true, reason: `objCode ${objCode} not handled` })
  }

  // ---- 3. Resolve IMS access token ----
  let imsToken
  try {
    imsToken = await resolveImsToken(params)
  } catch (imsError) {
    logger.error('IMS token resolution failed', { error: imsError.message })
    return errorResponse(500, `IMS authentication failed: ${imsError.message}`)
  }

  const clientId = params.CLIENT_ID || process.env.CLIENT_ID

  // ---- 4. Retrieve Workfront source asset URL ----
  let assetUrl, fileName
  try {
    ;({ assetUrl, fileName } = await getDocumentAssetUrl({
      baseUrl: params.WORKFRONT_BASE_URL || process.env.WORKFRONT_BASE_URL,
      apiKey: params.WORKFRONT_API_KEY || process.env.WORKFRONT_API_KEY,
      objID
    }))
  } catch (wfError) {
    logger.error('Workfront asset retrieval failed', { error: wfError.message })
    return errorResponse(502, `Workfront error: ${wfError.message}`)
  }

  // ---- 5 & 6. Submit Firefly V3 job and poll to completion ----
  const baseFileName = stripExtension(fileName) || `asset-${objID}`
  const brandStyleReferenceUrl =
    params.BRAND_STYLE_REFERENCE_URL || process.env.BRAND_STYLE_REFERENCE_URL

  // campaignCode links every downstream asset (AEM, AJO, CJA) to this campaign
  const campaignCode =
    webhookPayload?.newState?.DE_campaign_code ||
    params.CAMPAIGN_CODE ||
    process.env.CAMPAIGN_CODE ||
    `WF-${objID}`

  const generationPrompt = buildGenerationPrompt(fileName, webhookPayload)

  let fireflyResult
  try {
    fireflyResult = await generateAndWait(
      imsToken,
      clientId,
      {
        prompt: generationPrompt,
        brandStyleReferenceUrl,
        numVariations: parseInt(
          params.FIREFLY_NUM_VARIATIONS || process.env.FIREFLY_NUM_VARIATIONS || '4',
          10
        ),
        size: { width: 2048, height: 2048 },
        contentClass: 'photo',
        // Custom model: pass FIREFLY_CUSTOM_MODEL_ID env var or Workfront custom form field
        customModelId:
          webhookPayload?.newState?.DE_firefly_model_id ||
          params.FIREFLY_CUSTOM_MODEL_ID ||
          process.env.FIREFLY_CUSTOM_MODEL_ID ||
          null
      },
      {
        intervalMs: parseInt(
          params.FIREFLY_POLL_INTERVAL_MS || process.env.FIREFLY_POLL_INTERVAL_MS || '5000',
          10
        ),
        maxAttempts: parseInt(
          params.FIREFLY_POLL_MAX_ATTEMPTS ||
            process.env.FIREFLY_POLL_MAX_ATTEMPTS ||
            '60',
          10
        )
      }
    )
  } catch (fireflyError) {
    logger.error('Firefly generation failed', { error: fireflyError.message })
    return errorResponse(502, `Firefly error: ${fireflyError.message}`)
  }

  const { outputs: fireflyOutputs, jobId: fireflyJobId, modelId } = fireflyResult

  logger.info('Firefly generation complete', {
    outputCount: fireflyOutputs.length,
    jobId: fireflyJobId,
    modelId
  })

  // ---- 7. Build metadata backbone per variant ----
  // Every downstream system (AEM, AJO, CJA) uses these fields to correlate
  // the same asset without ETL stitching. variantId is the primary join key.
  const backbones = fireflyOutputs.map((output) =>
    buildBackbone({
      campaignCode,
      prompt: generationPrompt,
      modelId,
      jobId: fireflyJobId,
      seed: output.seed,
      segmentAffinity: webhookPayload?.newState?.DE_segment_affinity || ''
    })
  )

  // ---- 8. Upload renditions to AEM Assets (with backbone metadata) ----
  const aemHost = params.AEM_HOST || process.env.AEM_HOST
  const folderPath =
    params.AEM_UPLOAD_BASE_PATH || process.env.AEM_UPLOAD_BASE_PATH ||
    '/content/dam/generated-assets'

  let aemResults
  try {
    aemResults = await uploadRenditionsToAem({
      aemHost,
      imsToken,
      folderPath,
      baseFileName,
      fireflyOutputs,
      // Backbone metadata is merged into AEM asset metadata on completeUpload
      backbones: backbones.map((b) => backboneToAemMetadata(b))
    })
  } catch (aemError) {
    logger.error('AEM upload failed', { error: aemError.message })
    return errorResponse(502, `AEM upload error: ${aemError.message}`)
  }

  logger.info('All renditions uploaded to AEM', {
    count: aemResults.length,
    paths: aemResults.map((r) => r.aemAsset?.path)
  })

  // ---- 9. Trigger offer-sync (async, fire-and-forget) ----
  // offer-sync registers each Firefly variant as a Personalized Offer in AJO
  // Offer Library so the Decision Engine can select the right variant per user.
  // This is non-blocking: the orchestrate action does not wait for offer-sync
  // to complete; it fires the call and continues so the Workfront webhook
  // caller receives a timely response.
  const offerSyncUrl = buildOfferSyncUrl(params)
  if (offerSyncUrl) {
    const offerSyncPayload = {
      campaignCode,
      placementName: `Web Hero Banner - ${campaignCode}`,
      renditions: aemResults.map((r, i) => ({
        fileName: r.fileName,
        aemPath: r.aemAsset?.path,
        backbone: backbones[i],
        segmentAffinity: backbones[i]?.segmentAffinity || ''
      }))
    }
    // Fire-and-forget: intentionally not awaited
    fetch(offerSyncUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-offer-sync-secret': params.OFFER_SYNC_SECRET || process.env.OFFER_SYNC_SECRET || ''
      },
      body: JSON.stringify(offerSyncPayload)
    }).catch((err) =>
      logger.warn('offer-sync fire-and-forget failed (non-fatal)', { error: err.message })
    )
    logger.info('offer-sync triggered (non-blocking)', { offerSyncUrl, campaignCode })
  } else {
    logger.warn(
      'OFFER_SYNC_ACTION_URL not configured — AJO Offer Library sync skipped. ' +
      'Set this to the deployed offer-sync action URL to enable decisioning.'
    )
  }

  // ---- 10. Write back to Workfront ----
  const aemPaths = aemResults
    .map((r) => r.aemAsset?.path)
    .filter(Boolean)
    .join(', ')

  const variantIds = backbones.map((b) => b.variantId).join(', ')

  try {
    await updateWorkfrontObject({
      baseUrl: params.WORKFRONT_BASE_URL || process.env.WORKFRONT_BASE_URL,
      apiKey: params.WORKFRONT_API_KEY || process.env.WORKFRONT_API_KEY,
      objID,
      objCode: 'DOCU',
      updates: {
        DE_aem_rendition_paths: aemPaths,
        DE_supply_chain_status: 'RENDITIONS_GENERATED',
        DE_rendition_count: String(aemResults.length),
        DE_variant_ids: variantIds,
        DE_firefly_model_used: modelId,
        DE_campaign_code: campaignCode
      }
    })
  } catch (wfUpdateError) {
    logger.warn('Workfront write-back failed (non-fatal)', {
      error: wfUpdateError.message
    })
  }

  // ---- 11. Return success ----
  const responseBody = {
    success: true,
    objID,
    campaignCode,
    modelId,
    sourceAsset: assetUrl,
    renditions: aemResults.map((r, i) => ({
      fileName: r.fileName,
      aemPath: r.aemAsset?.path,
      variantId: backbones[i]?.variantId,
      seed: r.seed
    }))
  }

  logger.info('Orchestration complete', {
    campaignCode,
    renditionCount: aemResults.length,
    modelId
  })
  return successResponse(responseBody)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const requiredParams = [
  'WORKFRONT_BASE_URL',
  'WORKFRONT_API_KEY',
  'WORKFRONT_WEBHOOK_SECRET',
  'AEM_HOST',
  'CLIENT_ID',
  'CLIENT_SECRET',
  'BRAND_STYLE_REFERENCE_URL'
]

/**
 * Build a generation prompt from Workfront document metadata.
 * Extend this to pull from Workfront custom form fields for richer prompts.
 */
function buildGenerationPrompt (fileName, webhookPayload) {
  const docName = stripExtension(fileName) || 'product asset'
  const eventType = webhookPayload?.eventType || 'UPDATE'
  // Clean up file-name noise to form a natural-language prompt
  const cleaned = docName
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
  return `Professional marketing rendition of ${cleaned}, studio lighting, clean background, brand campaign visual`
}

function stripExtension (fileName) {
  if (!fileName) return ''
  return fileName.replace(/\.[^/.]+$/, '')
}

function buildOfferSyncUrl (params) {
  const url = params.OFFER_SYNC_ACTION_URL || process.env.OFFER_SYNC_ACTION_URL
  if (!url) return null
  // Resolve relative action URL to absolute when running in App Builder
  if (url.startsWith('/')) {
    const namespace = params.__OW_NAMESPACE || process.env.__OW_NAMESPACE || ''
    return `https://adobeioruntime.net/api/v1/web/${namespace}/content-supply-chain/offer-sync`
  }
  return url
}

function successResponse (body) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }
}

function errorResponse (statusCode, message) {
  logger.error(`Action error [${statusCode}]: ${message}`)
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ success: false, error: message })
  }
}

module.exports = { main }
