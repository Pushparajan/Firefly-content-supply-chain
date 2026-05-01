'use strict'

/**
 * AEM as a Cloud Service – Binary Cloud Upload wrapper.
 *
 * Implements the three-phase Direct Binary Access Upload protocol:
 *   1. Initiate  – tell AEM about the incoming file; receive pre-signed URIs
 *   2. Upload    – PUT the binary directly to Azure Blob Storage (or S3)
 *   3. Complete  – notify AEM so it can trigger DAM workflows
 *
 * This pattern bypasses the AEM author tier for the binary transfer,
 * dramatically improving throughput for large AI-generated assets.
 */

const fetch = require('node-fetch')
const logger = require('@adobe/aio-lib-core-logging')(
  'firefly-content-supply-chain:aem-cloud',
  { level: process.env.LOG_LEVEL || 'info' }
)

// ---------------------------------------------------------------------------
// Phase 1 – Initiate
// ---------------------------------------------------------------------------

/**
 * Initiate a Direct Binary Upload for one or more files.
 *
 * @param {object} opts
 * @param {string}   opts.aemHost      e.g. https://author-pXXXX-eYYYY.adobeaemcloud.com
 * @param {string}   opts.imsToken     Bearer token with AEM write permissions
 * @param {string}   opts.folderPath   AEM DAM path, e.g. /content/dam/generated-assets
 * @param {Array<{fileName: string, fileSize: number, mimeType: string}>} opts.files
 * @returns {Promise<{completeURI: string, files: Array}>}
 */
async function initiateUpload ({ aemHost, imsToken, folderPath, files }) {
  const url = `${aemHost}${folderPath}.initiateUpload.json`

  // AEM expects a flat multipart-encoded list of fileName/fileSize pairs
  const params = new URLSearchParams()
  for (const file of files) {
    params.append('fileName', file.fileName)
    params.append('fileSize', String(file.fileSize))
  }

  logger.info('Initiating AEM upload', { url, fileCount: files.length })

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
      `AEM initiateUpload failed [${response.status}] at ${url}: ${body}`
    )
  }

  const data = await response.json()
  logger.debug('AEM initiateUpload response', { completeURI: data.completeURI })
  return data
}

// ---------------------------------------------------------------------------
// Phase 2 – Upload binary to cloud storage
// ---------------------------------------------------------------------------

/**
 * Upload a single binary chunk directly to the pre-signed cloud URI.
 *
 * AEM may return multiple uploadURIs for chunked uploads; this function
 * handles the simple single-chunk case (files up to ~5 GB via one PUT).
 * For very large files, iterate over uploadURIs with byte-range headers.
 *
 * @param {object} opts
 * @param {string}   opts.uploadURI   Pre-signed Azure Blob / S3 URI from initiate
 * @param {Buffer}   opts.buffer      File binary content
 * @param {string}   opts.mimeType    MIME type for Content-Type header
 * @returns {Promise<void>}
 */
async function uploadBinaryToCloud ({ uploadURI, buffer, mimeType }) {
  logger.info('Uploading binary to cloud storage', {
    bytes: buffer.length,
    mimeType,
    uriPrefix: uploadURI.substring(0, 60) + '…'
  })

  const response = await fetch(uploadURI, {
    method: 'PUT',
    headers: {
      'Content-Type': mimeType,
      'Content-Length': String(buffer.length)
    },
    body: buffer
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(
      `Cloud storage PUT failed [${response.status}]: ${body}`
    )
  }

  logger.info('Binary uploaded to cloud storage successfully')
}

// ---------------------------------------------------------------------------
// Phase 3 – Complete
// ---------------------------------------------------------------------------

/**
 * Notify AEM that the binary upload has finished.
 * AEM uses this call to create/update the asset node and trigger DAM workflows.
 *
 * @param {object} opts
 * @param {string}   opts.aemHost       AEM author host
 * @param {string}   opts.imsToken      Bearer token
 * @param {string}   opts.completeURI   URI returned by initiateUpload
 * @param {string}   opts.uploadToken   Per-file token from initiateUpload response
 * @param {string}   opts.fileName      Original file name
 * @param {string}   opts.mimeType      MIME type
 * @param {boolean}  [opts.createVersion=true]  Create a new version if asset already exists
 * @returns {Promise<object>} AEM asset metadata
 */
async function completeUpload ({
  aemHost,
  imsToken,
  completeURI,
  uploadToken,
  fileName,
  mimeType,
  createVersion = true
}) {
  // completeURI may be relative; normalise to absolute
  const url = completeURI.startsWith('http')
    ? completeURI
    : `${aemHost}${completeURI}`

  const body = new URLSearchParams({
    uploadToken,
    fileName,
    mimeType,
    createVersion: String(createVersion)
  })

  logger.info('Completing AEM upload', { url, fileName, mimeType })

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${imsToken}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body.toString()
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(
      `AEM completeUpload failed [${response.status}] at ${url}: ${text}`
    )
  }

  const result = await response.json()
  logger.info('AEM upload complete', { fileName, path: result?.path })
  return result
}

// ---------------------------------------------------------------------------
// Convenience: fetch a remote URL and return a Buffer
// ---------------------------------------------------------------------------

/**
 * Download a remote asset (e.g. Firefly pre-signed output URL) into memory.
 *
 * @param {string} url
 * @returns {Promise<{buffer: Buffer, contentType: string, contentLength: number}>}
 */
async function fetchRemoteAsset (url) {
  logger.info('Fetching remote asset', {
    urlPrefix: url.substring(0, 80) + '…'
  })

  const response = await fetch(url)

  if (!response.ok) {
    throw new Error(
      `Failed to fetch remote asset [${response.status}]: ${url}`
    )
  }

  const buffer = Buffer.from(await response.arrayBuffer())
  const contentType =
    response.headers.get('content-type') || 'application/octet-stream'
  const contentLength = buffer.length

  logger.debug('Remote asset fetched', { contentType, contentLength })
  return { buffer, contentType, contentLength }
}

// ---------------------------------------------------------------------------
// High-level batch upload: Firefly outputs → AEM
// ---------------------------------------------------------------------------

/**
 * Upload all Firefly output renditions to AEM in one coordinated sequence.
 *
 * Each rendition goes through the full Initiate → Upload → Complete cycle.
 * Uploads run sequentially to avoid flooding AEM; for higher throughput
 * switch to Promise.allSettled with a concurrency limiter.
 *
 * @param {object} opts
 * @param {string}   opts.aemHost       AEM author host
 * @param {string}   opts.imsToken      IMS bearer token
 * @param {string}   opts.folderPath    Target DAM folder
 * @param {string}   opts.baseFileName  Root name (e.g. "hero-banner"); index appended
 * @param {Array}    opts.fireflyOutputs Array from pollUntilComplete()
 * @returns {Promise<Array<object>>}    Array of AEM asset metadata objects
 */
async function uploadRenditionsToAem ({
  aemHost,
  imsToken,
  folderPath,
  baseFileName,
  fireflyOutputs
}) {
  const results = []

  for (let i = 0; i < fireflyOutputs.length; i++) {
    const output = fireflyOutputs[i]
    const assetUrl = output?.image?.url || output?.image?.presignedUrl

    if (!assetUrl) {
      logger.warn('Skipping output with no image URL', { index: i, output })
      continue
    }

    const { buffer, contentType } = await fetchRemoteAsset(assetUrl)
    const ext = mimeToExt(contentType)
    const fileName = `${baseFileName}-v${i + 1}${ext}`

    // ---- Phase 1: Initiate ----
    const initData = await initiateUpload({
      aemHost,
      imsToken,
      folderPath,
      files: [{ fileName, fileSize: buffer.length, mimeType: contentType }]
    })

    const fileInfo = initData.files?.[0]
    if (!fileInfo) {
      throw new Error(`AEM initiateUpload returned no file info for ${fileName}`)
    }

    // ---- Phase 2: Upload to cloud ----
    const uploadURI = fileInfo.uploadURIs?.[0]
    if (!uploadURI) {
      throw new Error(`No uploadURI returned for ${fileName}`)
    }

    await uploadBinaryToCloud({
      uploadURI,
      buffer,
      mimeType: contentType
    })

    // ---- Phase 3: Complete ----
    const aemAsset = await completeUpload({
      aemHost,
      imsToken,
      completeURI: initData.completeURI,
      uploadToken: fileInfo.uploadToken,
      fileName,
      mimeType: contentType,
      createVersion: true
    })

    results.push({ fileName, aemAsset, seed: output.seed })
    logger.info('Rendition uploaded to AEM', { fileName, path: aemAsset?.path })
  }

  return results
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function mimeToExt (mimeType) {
  const map = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/tiff': '.tif'
  }
  return map[mimeType] || '.jpg'
}

module.exports = {
  initiateUpload,
  uploadBinaryToCloud,
  completeUpload,
  fetchRemoteAsset,
  uploadRenditionsToAem
}
