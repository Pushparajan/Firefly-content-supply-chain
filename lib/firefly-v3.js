'use strict'

/**
 * Firefly V3 Async service wrapper.
 *
 * Flow: submitGenerationJob() → pollUntilComplete() → returns output URLs.
 *
 * Async pattern avoids App Builder's 60-second hard timeout by returning a
 * jobId immediately; the same action then polls within its own extended
 * timeout window (manifest.yml: timeout: 300000).
 */

const { FireflyClient } = require('@adobe/firefly-apis')
const { ServiceConfig } = require('@adobe/firefly-services-common-apis')
const logger = require('@adobe/aio-lib-core-logging')(
  'firefly-content-supply-chain:firefly-v3',
  { level: process.env.LOG_LEVEL || 'info' }
)

const FIREFLY_API_BASE_URL =
  process.env.FIREFLY_API_BASE_URL || 'https://firefly-api.adobe.io'
const DEFAULT_POLL_INTERVAL_MS = parseInt(
  process.env.FIREFLY_POLL_INTERVAL_MS || '5000',
  10
)
const DEFAULT_POLL_MAX_ATTEMPTS = parseInt(
  process.env.FIREFLY_POLL_MAX_ATTEMPTS || '60',
  10
)

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

/**
 * Build an authenticated FireflyClient using OAuth S2S credentials.
 *
 * @param {object} imsToken  Resolved IMS access token string
 * @param {string} clientId  OAuth client ID
 * @returns {FireflyClient}
 */
function createFireflyClient (imsToken, clientId) {
  const serviceConfig = new ServiceConfig({
    clientId,
    accessToken: imsToken,
    baseUrl: FIREFLY_API_BASE_URL
  })
  return new FireflyClient(serviceConfig)
}

// ---------------------------------------------------------------------------
// Job submission
// ---------------------------------------------------------------------------

/**
 * Submit a V3 async image-generation job to Adobe Firefly.
 *
 * The style_reference (brand hero image URL) ensures every rendition
 * inherits the brand's colour palette, lighting mood, and visual tone
 * without hard-coding those attributes into the text prompt.
 *
 * @param {FireflyClient} client
 * @param {object} opts
 * @param {string}   opts.prompt               Text prompt for the generation
 * @param {string}   opts.brandStyleReferenceUrl  HTTPS URL to the brand hero image
 * @param {number}   [opts.numVariations=4]    Number of renditions requested
 * @param {object}   [opts.size]               { width, height } in pixels
 * @param {string}   [opts.contentClass]       'photo' | 'art'
 * @param {number[]} [opts.seeds]              Deterministic seeds for reproducibility
 * @returns {Promise<{jobId: string, statusUrl: string}>}
 */
async function submitGenerationJob (client, opts) {
  const {
    prompt,
    brandStyleReferenceUrl,
    numVariations = parseInt(process.env.FIREFLY_NUM_VARIATIONS || '4', 10),
    size = { width: 2048, height: 2048 },
    contentClass = 'photo',
    seeds
  } = opts

  if (!prompt) throw new Error('Firefly: prompt is required')
  if (!brandStyleReferenceUrl) {
    throw new Error('Firefly: brandStyleReferenceUrl is required for brand consistency')
  }

  const requestBody = {
    numVariations,
    prompt,
    contentClass,
    size,
    style: {
      // style_reference pins brand aesthetics: colour, lighting, mood.
      imageReference: {
        source: { url: brandStyleReferenceUrl }
      },
      strength: 60   // 0–100; 60 gives brand flavour without overriding the prompt
    }
  }

  if (seeds && seeds.length > 0) {
    requestBody.seeds = seeds
  }

  logger.info('Submitting Firefly V3 async generation job', {
    prompt: prompt.substring(0, 80),
    numVariations,
    size,
    brandStyleReferenceUrl
  })

  // FireflyClient.generateImagesAsync maps to POST /v3/images/generate-async
  const response = await client.generateImagesAsync(requestBody)

  const jobId = response?.jobId
  const statusUrl = response?.statusUrl

  if (!jobId) {
    throw new Error(
      `Firefly did not return a jobId. Raw response: ${JSON.stringify(response)}`
    )
  }

  logger.info('Firefly job submitted', { jobId, statusUrl })
  return { jobId, statusUrl }
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

/**
 * Poll the Firefly job status endpoint until the job succeeds or fails.
 *
 * Uses linear back-off via pollIntervalMs; for long-running jobs consider
 * switching to exponential back-off by multiplying the interval each round.
 *
 * @param {FireflyClient} client
 * @param {string} jobId
 * @param {object} [opts]
 * @param {number} [opts.intervalMs]   Milliseconds between polls
 * @param {number} [opts.maxAttempts]  Maximum number of poll attempts
 * @returns {Promise<Array<{seed: number, image: {url: string}}>>} Output assets
 */
async function pollUntilComplete (client, jobId, opts = {}) {
  const intervalMs = opts.intervalMs || DEFAULT_POLL_INTERVAL_MS
  const maxAttempts = opts.maxAttempts || DEFAULT_POLL_MAX_ATTEMPTS

  logger.info('Polling Firefly job', { jobId, intervalMs, maxAttempts })

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const status = await client.getJobStatus(jobId)

    logger.debug('Firefly poll status', {
      jobId,
      attempt,
      status: status?.status
    })

    if (status?.status === 'succeeded') {
      const outputs = status.outputs || []
      logger.info('Firefly job succeeded', { jobId, outputCount: outputs.length })
      return outputs
    }

    if (status?.status === 'failed') {
      const reason = status?.error?.message || JSON.stringify(status)
      throw new Error(`Firefly job ${jobId} failed: ${reason}`)
    }

    // Job is still running ('running' | 'pending'); wait before next attempt
    if (attempt < maxAttempts) {
      await sleep(intervalMs)
    }
  }

  throw new Error(
    `Firefly job ${jobId} did not complete within ${maxAttempts} attempts ` +
    `(${(maxAttempts * intervalMs) / 1000}s)`
  )
}

// ---------------------------------------------------------------------------
// Convenience orchestration helper
// ---------------------------------------------------------------------------

/**
 * End-to-end helper: submit a generation job and poll until complete.
 *
 * @param {string} imsToken          IMS access token
 * @param {string} clientId          OAuth client ID
 * @param {object} generationOptions See submitGenerationJob opts
 * @param {object} [pollOptions]     See pollUntilComplete opts
 * @returns {Promise<Array>}         Array of Firefly output objects
 */
async function generateAndWait (
  imsToken,
  clientId,
  generationOptions,
  pollOptions = {}
) {
  const client = createFireflyClient(imsToken, clientId)
  const { jobId } = await submitGenerationJob(client, generationOptions)
  return pollUntilComplete(client, jobId, pollOptions)
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

module.exports = {
  createFireflyClient,
  submitGenerationJob,
  pollUntilComplete,
  generateAndWait
}
