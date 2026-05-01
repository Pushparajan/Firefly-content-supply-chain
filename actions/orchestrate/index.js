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
 *  5. Submit Firefly V3 async image-generation job (with brand style reference)
 *  6. Poll Firefly until the job succeeds (or fails after max attempts)
 *  7. Upload every rendition to AEM Assets via Binary Cloud Upload
 *  8. Update the Workfront record with generated AEM asset paths
 *  9. Return a structured JSON response
 */

const logger = require('@adobe/aio-lib-core-logging')(
  'firefly-content-supply-chain:orchestrate',
  { level: process.env.LOG_LEVEL || 'info' }
)

const { verifyWebhookSignature, parseWebhookPayload, getDocumentAssetUrl, updateWorkfrontObject } =
  require('../../lib/workfront')
const { generateAndWait } = require('../../lib/firefly-v3')
const { uploadRenditionsToAem } = require('../../lib/aem-cloud')
const { resolveImsToken } = require('../../lib/ims')

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

  let fireflyOutputs
  try {
    fireflyOutputs = await generateAndWait(
      imsToken,
      clientId,
      {
        // Prompt derived from the Workfront document name; extend with custom
        // metadata fields from Workfront custom forms as needed.
        prompt: buildGenerationPrompt(fileName, webhookPayload),
        brandStyleReferenceUrl,
        numVariations: parseInt(
          params.FIREFLY_NUM_VARIATIONS || process.env.FIREFLY_NUM_VARIATIONS || '4',
          10
        ),
        size: { width: 2048, height: 2048 },
        contentClass: 'photo'
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

  logger.info('Firefly generation complete', {
    outputCount: fireflyOutputs.length
  })

  // ---- 7. Upload renditions to AEM Assets ----
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
      fireflyOutputs
    })
  } catch (aemError) {
    logger.error('AEM upload failed', { error: aemError.message })
    return errorResponse(502, `AEM upload error: ${aemError.message}`)
  }

  logger.info('All renditions uploaded to AEM', {
    count: aemResults.length,
    paths: aemResults.map((r) => r.aemAsset?.path)
  })

  // ---- 8. Write back to Workfront ----
  const aemPaths = aemResults
    .map((r) => r.aemAsset?.path)
    .filter(Boolean)
    .join(', ')

  try {
    await updateWorkfrontObject({
      baseUrl: params.WORKFRONT_BASE_URL || process.env.WORKFRONT_BASE_URL,
      apiKey: params.WORKFRONT_API_KEY || process.env.WORKFRONT_API_KEY,
      objID,
      objCode: 'DOCU',
      updates: {
        // DE_ prefix = custom form field; adjust to match your Workfront schema
        DE_aem_rendition_paths: aemPaths,
        DE_supply_chain_status: 'RENDITIONS_GENERATED',
        DE_rendition_count: String(aemResults.length)
      }
    })
  } catch (wfUpdateError) {
    // Non-fatal: log but don't fail the whole pipeline
    logger.warn('Workfront write-back failed (non-fatal)', {
      error: wfUpdateError.message
    })
  }

  // ---- 9. Return success ----
  const responseBody = {
    success: true,
    objID,
    sourceAsset: assetUrl,
    renditions: aemResults.map((r) => ({
      fileName: r.fileName,
      aemPath: r.aemAsset?.path,
      seed: r.seed
    }))
  }

  logger.info('Orchestration complete', responseBody)
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
