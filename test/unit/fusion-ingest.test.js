'use strict'

jest.mock('../../lib/content-hub')
jest.mock('../../lib/aem-cloud')
jest.mock('../../lib/taxonomy')
jest.mock('../../lib/ims')
jest.mock('node-fetch')
jest.mock('@adobe/aio-lib-core-logging', () => () => ({
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))

const { main } = require('../../actions/fusion-ingest/index')
const contentHub = require('../../lib/content-hub')
const aemCloud = require('../../lib/aem-cloud')
const taxonomy = require('../../lib/taxonomy')
const ims = require('../../lib/ims')
const fetch = require('node-fetch')

const FUSION_SECRET = 'fusion-test-secret'

function makeParams (overrides = {}) {
  const payload = {
    assetPath: '/ACME/contributions/hero-summer.psd',
    agencyMetadata: {
      season: 'summer',
      market: 'emea',
      brand: 'Firefly Pro',
      assetType: 'hero banner',
      agencyName: 'Studio X',
      description: 'Summer hero'
    }
  }
  return {
    FUSION_INGEST_SECRET: FUSION_SECRET,
    AEM_HOST: 'https://author-p1-e1.adobeaemcloud.com',
    CONTENT_HUB_HOST: 'https://acme.brand-portal.adobe.com',
    AEM_UPLOAD_BASE_PATH: '/content/dam/campaigns',
    CLIENT_ID: 'client-id',
    CLIENT_SECRET: 'client-secret',
    AIO_IMS_ORG_ID: 'org@AdobeOrg',
    __ow_body: JSON.stringify(payload),
    __ow_headers: { 'x-fusion-secret': FUSION_SECRET },
    ...overrides
  }
}

beforeEach(() => {
  jest.clearAllMocks()

  ims.resolveImsToken.mockResolvedValue('ims-token')

  taxonomy.validateRequiredTaxonomy.mockReturnValue(undefined)
  taxonomy.mapToAemTaxonomy.mockReturnValue({
    aemMetadata: {
      'cq:tags': [
        '/content/cq:tags/brand/seasons/summer',
        '/content/cq:tags/regions/emea'
      ],
      'dc:title': 'Summer hero',
      'dam:usageRights': 'Digital only'
    },
    targetFolder: '/content/dam/campaigns/emea/summer/hero-banners',
    warnings: []
  })

  contentHub.downloadAsset.mockResolvedValue({
    buffer: Buffer.from('fake-psd-data'),
    contentType: 'image/vnd.adobe.photoshop'
  })

  aemCloud.initiateUpload.mockResolvedValue({
    completeURI: '/content/dam/campaigns/emea/summer/hero-banners.completeUpload.json',
    files: [
      {
        uploadToken: 'tok-abc',
        uploadURIs: ['https://storage.blob.core.windows.net/container/hero.psd?sas=x']
      }
    ]
  })

  aemCloud.uploadBinaryToCloud.mockResolvedValue(undefined)

  aemCloud.completeUpload.mockResolvedValue({
    path: '/content/dam/campaigns/emea/summer/hero-banners/hero-summer.psd'
  })

  contentHub.markContributionProcessed.mockResolvedValue(undefined)

  // node-fetch used by applyAemMetadata
  fetch.mockResolvedValue({ ok: true, json: async () => ({}) })
})

describe('fusion-ingest action', () => {
  it('returns 200 with aemAssetPath and applied tags on happy path', async () => {
    const result = await main(makeParams())
    expect(result.statusCode).toBe(200)
    const body = JSON.parse(result.body)
    expect(body.success).toBe(true)
    expect(body.aemAssetPath).toBe(
      '/content/dam/campaigns/emea/summer/hero-banners/hero-summer.psd'
    )
    expect(body.targetFolder).toBe('/content/dam/campaigns/emea/summer/hero-banners')
    expect(body.appliedTags).toHaveLength(2)
  })

  it('returns 401 when Fusion secret is wrong', async () => {
    const params = makeParams()
    params.__ow_headers['x-fusion-secret'] = 'wrong-secret'
    const result = await main(params)
    expect(result.statusCode).toBe(401)
  })

  it('returns 400 when assetPath is missing', async () => {
    const params = makeParams()
    params.__ow_body = JSON.stringify({ agencyMetadata: {} })
    const result = await main(params)
    expect(result.statusCode).toBe(400)
  })

  it('returns 422 when taxonomy validation fails', async () => {
    taxonomy.validateRequiredTaxonomy.mockImplementation(() => {
      throw new Error('brand="???" not in controlled vocabulary')
    })
    const result = await main(makeParams())
    expect(result.statusCode).toBe(422)
    expect(JSON.parse(result.body).error).toMatch(/controlled vocabulary/)
  })

  it('returns 502 when Content Hub download fails', async () => {
    contentHub.downloadAsset.mockRejectedValue(new Error('Content Hub 404'))
    const result = await main(makeParams())
    expect(result.statusCode).toBe(502)
    expect(JSON.parse(result.body).error).toMatch(/Content Hub download/)
  })

  it('returns 502 when AEM initiate fails', async () => {
    aemCloud.initiateUpload.mockRejectedValue(new Error('AEM 503'))
    const result = await main(makeParams())
    expect(result.statusCode).toBe(502)
  })

  it('succeeds even when metadata apply fails (non-fatal)', async () => {
    fetch.mockResolvedValue({ ok: false, text: async () => 'Sling error', status: 500 })
    const result = await main(makeParams())
    // Metadata failure is non-fatal
    expect(result.statusCode).toBe(200)
  })

  it('succeeds even when Content Hub status mark fails (non-fatal)', async () => {
    contentHub.markContributionProcessed.mockRejectedValue(
      new Error('Content Hub unreachable')
    )
    const result = await main(makeParams())
    expect(result.statusCode).toBe(200)
  })

  it('calls validateRequiredTaxonomy before downloading the binary', async () => {
    const callOrder = []
    taxonomy.validateRequiredTaxonomy.mockImplementation(() => {
      callOrder.push('validate')
    })
    contentHub.downloadAsset.mockImplementation(async () => {
      callOrder.push('download')
      return { buffer: Buffer.from('x'), contentType: 'image/jpeg' }
    })

    await main(makeParams())

    expect(callOrder.indexOf('validate')).toBeLessThan(callOrder.indexOf('download'))
  })
})
