'use strict'

const crypto = require('crypto')

// ---------------------------------------------------------------------------
// Module mocks — must be declared before require()
// ---------------------------------------------------------------------------

jest.mock('../../lib/workfront')
jest.mock('../../lib/firefly-v3')
jest.mock('../../lib/aem-cloud')
jest.mock('../../lib/ims')
jest.mock('@adobe/aio-lib-core-logging', () => () => ({
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))

const { main } = require('../../actions/orchestrate/index')
const workfront = require('../../lib/workfront')
const fireflyV3 = require('../../lib/firefly-v3')
const aemCloud = require('../../lib/aem-cloud')
const ims = require('../../lib/ims')

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const SECRET = 'test-secret'

function makeParams (overrides = {}) {
  const body = JSON.stringify({
    eventType: 'UPDATE',
    objCode: 'DOCU',
    objID: 'doc-abc123'
  })
  const sig = crypto
    .createHmac('sha256', SECRET)
    .update(body, 'utf8')
    .digest('hex')

  return {
    WORKFRONT_BASE_URL: 'https://test.my.workfront.com',
    WORKFRONT_API_KEY: 'wf-api-key',
    WORKFRONT_WEBHOOK_SECRET: SECRET,
    AEM_HOST: 'https://author-p1-e1.adobeaemcloud.com',
    AEM_UPLOAD_BASE_PATH: '/content/dam/generated',
    CLIENT_ID: 'client-id',
    CLIENT_SECRET: 'client-secret',
    BRAND_STYLE_REFERENCE_URL: 'https://cdn.brand.com/hero.jpg',
    __ow_body: body,
    __ow_headers: { 'x-wf-signature': sig },
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// Default mock implementations
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks()

  workfront.verifyWebhookSignature.mockReturnValue(undefined)
  workfront.parseWebhookPayload.mockReturnValue({
    objID: 'doc-abc123',
    objCode: 'DOCU',
    eventType: 'UPDATE'
  })
  workfront.getDocumentAssetUrl.mockResolvedValue({
    assetUrl: 'https://cc.assets.adobe.com/asset.psd',
    fileName: 'hero-banner-summer.psd',
    documentId: 'doc-abc123'
  })
  workfront.updateWorkfrontObject.mockResolvedValue({ data: {} })

  ims.resolveImsToken.mockResolvedValue('ims-access-token')

  fireflyV3.generateAndWait.mockResolvedValue([
    { seed: 1001, image: { url: 'https://ff-output.adobe.io/v1.jpg' } },
    { seed: 1002, image: { url: 'https://ff-output.adobe.io/v2.jpg' } }
  ])

  aemCloud.uploadRenditionsToAem.mockResolvedValue([
    { fileName: 'hero-banner-summer-v1.jpg', aemAsset: { path: '/content/dam/generated/hero-banner-summer-v1.jpg' }, seed: 1001 },
    { fileName: 'hero-banner-summer-v2.jpg', aemAsset: { path: '/content/dam/generated/hero-banner-summer-v2.jpg' }, seed: 1002 }
  ])
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('main (orchestrate)', () => {
  it('returns 200 with rendition paths on happy path', async () => {
    const result = await main(makeParams())

    expect(result.statusCode).toBe(200)
    const body = JSON.parse(result.body)
    expect(body.success).toBe(true)
    expect(body.renditions).toHaveLength(2)
    expect(body.renditions[0].aemPath).toContain('/content/dam/generated')
  })

  it('returns 400 when a required param is missing', async () => {
    const params = makeParams()
    delete params.AEM_HOST

    const result = await main(params)
    expect(result.statusCode).toBe(400)
    expect(JSON.parse(result.body).error).toMatch(/AEM_HOST/)
  })

  it('returns 401 when webhook signature is invalid', async () => {
    workfront.verifyWebhookSignature.mockImplementation(() => {
      throw new Error('Webhook signature verification failed')
    })

    const result = await main(makeParams())
    expect(result.statusCode).toBe(401)
  })

  it('returns 200 with skipped=true for non-DOCU objCode', async () => {
    workfront.parseWebhookPayload.mockReturnValue({
      objID: 'task-123',
      objCode: 'TASK',
      eventType: 'UPDATE'
    })

    const result = await main(makeParams())
    expect(result.statusCode).toBe(200)
    const body = JSON.parse(result.body)
    expect(body.skipped).toBe(true)
  })

  it('returns 500 when IMS token resolution fails', async () => {
    ims.resolveImsToken.mockRejectedValue(new Error('IMS unreachable'))

    const result = await main(makeParams())
    expect(result.statusCode).toBe(500)
    expect(JSON.parse(result.body).error).toMatch(/IMS authentication failed/)
  })

  it('returns 502 when Workfront asset fetch fails', async () => {
    workfront.getDocumentAssetUrl.mockRejectedValue(
      new Error('Workfront 404 on DOCU/doc-abc123')
    )

    const result = await main(makeParams())
    expect(result.statusCode).toBe(502)
  })

  it('returns 502 when Firefly generation fails', async () => {
    fireflyV3.generateAndWait.mockRejectedValue(
      new Error('Firefly job failed: content policy')
    )

    const result = await main(makeParams())
    expect(result.statusCode).toBe(502)
    expect(JSON.parse(result.body).error).toMatch(/Firefly error/)
  })

  it('returns 502 when AEM upload fails', async () => {
    aemCloud.uploadRenditionsToAem.mockRejectedValue(
      new Error('AEM 403 Forbidden')
    )

    const result = await main(makeParams())
    expect(result.statusCode).toBe(502)
    expect(JSON.parse(result.body).error).toMatch(/AEM upload error/)
  })

  it('succeeds even when Workfront write-back fails', async () => {
    workfront.updateWorkfrontObject.mockRejectedValue(
      new Error('Workfront connection timeout')
    )

    const result = await main(makeParams())
    // Write-back failure is non-fatal; overall pipeline should still succeed
    expect(result.statusCode).toBe(200)
    expect(JSON.parse(result.body).success).toBe(true)
  })

  it('passes brand style reference URL to Firefly', async () => {
    await main(makeParams())

    expect(fireflyV3.generateAndWait).toHaveBeenCalledWith(
      'ims-access-token',
      'client-id',
      expect.objectContaining({
        brandStyleReferenceUrl: 'https://cdn.brand.com/hero.jpg'
      }),
      expect.any(Object)
    )
  })

  it('handles malformed JSON webhook body', async () => {
    const params = makeParams()
    params.__ow_body = '{ not valid json'

    const result = await main(params)
    expect(result.statusCode).toBe(400)
    expect(JSON.parse(result.body).error).toMatch(/parse webhook body/)
  })
})
