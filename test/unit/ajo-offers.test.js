'use strict'

const nock = require('nock')
const {
  findOrCreatePlacement,
  createPersonalizedOffer,
  findOrCreateCollection,
  requestDecision
} = require('../../lib/ajo-offers')

const DPS_BASE = 'https://platform.adobe.io'
const OPTS = {
  imsToken: 'ims-token',
  orgId: 'testOrg@AdobeOrg',
  sandboxName: 'prod',
  clientId: 'test-client-id'
}

const BACKBONE = {
  variantId: 'abcd1234abcd1234',
  campaignCode: 'SUMMER-2025-EMEA',
  modelId: 'standard',
  segmentAffinity: 'travel',
  generatedAt: '2025-06-01T00:00:00.000Z',
  promptLineage: 'UHJvZmVzc2lvbmFsIGhlcm8='
}

afterEach(() => nock.cleanAll())

describe('findOrCreatePlacement', () => {
  it('returns existing placement when found by name', async () => {
    nock(DPS_BASE)
      .get('/data/core/dps/placements')
      .query(true)
      .reply(200, {
        items: [{ id: 'place-001', name: 'Web Hero Banner - SUMMER-2025-EMEA' }]
      })

    const result = await findOrCreatePlacement({
      ...OPTS,
      placementName: 'Web Hero Banner - SUMMER-2025-EMEA'
    })

    expect(result.id).toBe('place-001')
  })

  it('creates a new placement when none exists', async () => {
    nock(DPS_BASE)
      .get('/data/core/dps/placements')
      .query(true)
      .reply(200, { items: [] })

    nock(DPS_BASE)
      .post('/data/core/dps/placements')
      .reply(201, { id: 'place-new', name: 'Web Hero Banner - NEW' })

    const result = await findOrCreatePlacement({
      ...OPTS,
      placementName: 'Web Hero Banner - NEW'
    })

    expect(result.id).toBe('place-new')
  })
})

describe('createPersonalizedOffer', () => {
  it('creates an offer with backbone characteristics and draft status', async () => {
    let capturedBody

    nock(DPS_BASE)
      .post('/data/core/dps/offers', (body) => {
        capturedBody = body
        return true
      })
      .reply(201, {
        id: 'offer-abc123',
        name: 'SUMMER-2025-EMEA - travel - abcd1234abcd1234',
        status: 'draft'
      })

    const result = await createPersonalizedOffer({
      ...OPTS,
      offerName: 'SUMMER-2025-EMEA - travel - abcd1234abcd1234',
      aemAssetUrl: 'https://publish-p1-e1.adobeaemcloud.com/content/dam/hero.jpg',
      placementId: 'place-001',
      backbone: BACKBONE,
      priority: 10
    })

    expect(result.id).toBe('offer-abc123')
    expect(result.status).toBe('draft')

    // Verify backbone characteristics were included in the request
    expect(capturedBody.characteristics.variantId).toBe(BACKBONE.variantId)
    expect(capturedBody.characteristics.campaignCode).toBe(BACKBONE.campaignCode)
    expect(capturedBody.characteristics.segmentAffinity).toBe(BACKBONE.segmentAffinity)
    expect(capturedBody.rank.priority).toBe(10)
  })

  it('throws when DPS returns an error', async () => {
    nock(DPS_BASE)
      .post('/data/core/dps/offers')
      .reply(400, 'Bad Request: invalid placement')

    await expect(
      createPersonalizedOffer({
        ...OPTS,
        offerName: 'test',
        aemAssetUrl: 'https://example.com/asset.jpg',
        placementId: 'bad-placement',
        backbone: BACKBONE
      })
    ).rejects.toThrow(/offer create failed \[400\]/)
  })

  it('includes eligibilityRuleId in selectionConstraint when provided', async () => {
    let capturedBody

    nock(DPS_BASE)
      .post('/data/core/dps/offers', (body) => {
        capturedBody = body
        return true
      })
      .reply(201, { id: 'offer-with-rule', status: 'draft' })

    await createPersonalizedOffer({
      ...OPTS,
      offerName: 'test',
      aemAssetUrl: 'https://example.com/asset.jpg',
      placementId: 'place-001',
      backbone: BACKBONE,
      eligibilityRuleId: 'rule-travel-123'
    })

    expect(capturedBody.selectionConstraint.profileConstraintType).toBe('eligibilityRule')
    expect(capturedBody.selectionConstraint.eligibilityRule).toBe('rule-travel-123')
  })
})

describe('findOrCreateCollection', () => {
  it('creates a new collection for a campaign', async () => {
    nock(DPS_BASE)
      .get('/data/core/dps/offer-collections')
      .query(true)
      .reply(200, { items: [] })

    nock(DPS_BASE)
      .post('/data/core/dps/offer-collections')
      .reply(201, { id: 'coll-summer-2025', name: 'collection-SUMMER-2025-EMEA' })

    const result = await findOrCreateCollection({
      ...OPTS,
      campaignCode: 'SUMMER-2025-EMEA',
      offerIds: ['offer-1', 'offer-2']
    })

    expect(result.id).toBe('coll-summer-2025')
  })
})

describe('requestDecision', () => {
  it('posts a decision request and returns propositions', async () => {
    nock(DPS_BASE)
      .post('/data/core/dps/decisions')
      .reply(200, {
        propositions: [
          {
            activity: { id: 'activity-001' },
            placement: { id: 'place-001' },
            items: [{ id: 'offer-abc123' }]
          }
        ]
      })

    const result = await requestDecision({
      ...OPTS,
      activityId: 'activity-001',
      placementId: 'place-001',
      profileId: 'ecid-abc123'
    })

    expect(result.propositions).toHaveLength(1)
    expect(result.propositions[0].items[0].id).toBe('offer-abc123')
  })
})
