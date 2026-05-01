'use strict'

/**
 * Adobe Workfront API wrapper.
 *
 * Responsibilities:
 *  - Verify the inbound HMAC-SHA256 webhook signature
 *  - Parse the webhook payload and extract the objID / objCode
 *  - Retrieve the Creative Cloud asset URL associated with a Workfront document
 */

const crypto = require('crypto')
const fetch = require('node-fetch')
const logger = require('@adobe/aio-lib-core-logging')(
  'firefly-content-supply-chain:workfront',
  { level: process.env.LOG_LEVEL || 'info' }
)

const WF_API_VERSION = process.env.WORKFRONT_API_VERSION || '17.0'

// ---------------------------------------------------------------------------
// Webhook signature verification
// ---------------------------------------------------------------------------

/**
 * Verify that the webhook was sent by Workfront using HMAC-SHA256.
 *
 * Workfront places the hex-encoded signature in the X-WF-Signature header.
 * Timing-safe comparison prevents timing attacks.
 *
 * @param {string} rawBody         Raw request body string (pre-JSON-parse)
 * @param {string} signatureHeader Value of X-WF-Signature header
 * @param {string} secret          Shared HMAC secret from .env
 * @throws {Error} If signature is missing or invalid
 */
function verifyWebhookSignature (rawBody, signatureHeader, secret) {
  if (!signatureHeader) {
    throw new Error('Webhook signature header (X-WF-Signature) is missing')
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('hex')

  const expectedBuf = Buffer.from(expected, 'hex')
  const receivedBuf = Buffer.from(signatureHeader, 'hex')

  if (
    expectedBuf.length !== receivedBuf.length ||
    !crypto.timingSafeEqual(expectedBuf, receivedBuf)
  ) {
    throw new Error('Webhook signature verification failed')
  }

  logger.debug('Webhook signature verified')
}

// ---------------------------------------------------------------------------
// Payload parsing
// ---------------------------------------------------------------------------

/**
 * Extract the relevant identifiers from a Workfront event-subscription payload.
 *
 * Workfront event subscriptions emit objects like:
 * {
 *   "eventType": "UPDATE",
 *   "objCode":   "DOCU",
 *   "objID":     "60e8f…",
 *   "newState":  { ... }
 * }
 *
 * @param {object} payload  Parsed JSON webhook body
 * @returns {{ objID: string, objCode: string, eventType: string, newState: object }}
 */
function parseWebhookPayload (payload) {
  const { eventType, objCode, objID, newState } = payload || {}

  if (!objID) throw new Error('Workfront webhook payload missing objID')
  if (!objCode) throw new Error('Workfront webhook payload missing objCode')

  logger.info('Parsed Workfront webhook', { eventType, objCode, objID })
  return { objID, objCode, eventType, newState }
}

// ---------------------------------------------------------------------------
// Workfront REST API calls
// ---------------------------------------------------------------------------

/**
 * Build authenticated request headers for the Workfront REST API.
 * Supports both API-key and session-token auth patterns.
 *
 * @param {string} apiKey
 * @returns {object}
 */
function buildWfHeaders (apiKey) {
  return {
    'Content-Type': 'application/json',
    apiKey
  }
}

/**
 * Retrieve a Workfront Document record and extract the Creative Cloud asset URL.
 *
 * The `contentHandle` field on a DOCU object contains the Adobe CC storage handle
 * which, combined with the CC Files API, gives the downloadable source URL.
 * For direct-upload documents, the `handle` field points to the WF-stored binary.
 *
 * @param {object} opts
 * @param {string}   opts.baseUrl   Workfront instance URL
 * @param {string}   opts.apiKey    Workfront API key
 * @param {string}   opts.objID     Document ID (from webhook)
 * @returns {Promise<{assetUrl: string, fileName: string, documentId: string}>}
 */
async function getDocumentAssetUrl ({ baseUrl, apiKey, objID }) {
  const fields = 'name,contentHandle,handle,downloadURL,fileExtension,docSize'
  const url =
    `${baseUrl}/attask/api/v${WF_API_VERSION}/DOCU/${objID}` +
    `?fields=${fields}`

  logger.info('Fetching Workfront document', { objID, url })

  const response = await fetch(url, {
    method: 'GET',
    headers: buildWfHeaders(apiKey)
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(
      `Workfront API error [${response.status}] fetching DOCU/${objID}: ${body}`
    )
  }

  const json = await response.json()
  const doc = json?.data

  if (!doc) {
    throw new Error(`Workfront returned no data for DOCU/${objID}`)
  }

  // Prefer the Creative Cloud storage URL (contentHandle); fall back to
  // the Workfront-hosted download URL for non-CC assets.
  const assetUrl = doc.downloadURL || doc.contentHandle
  if (!assetUrl) {
    throw new Error(
      `No downloadable URL found on Workfront DOCU/${objID}. ` +
      'Ensure the document has been uploaded or synced from Creative Cloud.'
    )
  }

  const fileName = doc.name || `asset-${objID}`
  logger.info('Retrieved Workfront asset URL', {
    fileName,
    urlPrefix: assetUrl.substring(0, 60) + '…'
  })

  return { assetUrl, fileName, documentId: objID }
}

/**
 * Update a Workfront task or document with generated rendition metadata.
 * Posts a custom form update so stakeholders can see the AEM asset paths.
 *
 * @param {object} opts
 * @param {string}   opts.baseUrl    Workfront instance URL
 * @param {string}   opts.apiKey     Workfront API key
 * @param {string}   opts.objID      Task or Document ID to update
 * @param {string}   opts.objCode    e.g. 'TASK' or 'DOCU'
 * @param {object}   opts.updates    Field key/value pairs to set
 * @returns {Promise<object>}
 */
async function updateWorkfrontObject ({ baseUrl, apiKey, objID, objCode, updates }) {
  const url = `${baseUrl}/attask/api/v${WF_API_VERSION}/${objCode}/${objID}`

  logger.info('Updating Workfront object', { objCode, objID, fields: Object.keys(updates) })

  const response = await fetch(url, {
    method: 'PUT',
    headers: buildWfHeaders(apiKey),
    body: JSON.stringify(updates)
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(
      `Workfront PUT failed [${response.status}] on ${objCode}/${objID}: ${body}`
    )
  }

  const result = await response.json()
  logger.info('Workfront object updated', { objCode, objID })
  return result
}

module.exports = {
  verifyWebhookSignature,
  parseWebhookPayload,
  getDocumentAssetUrl,
  updateWorkfrontObject
}
