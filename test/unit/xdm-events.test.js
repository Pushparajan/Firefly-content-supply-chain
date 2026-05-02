'use strict'

const nock = require('nock')
const {
  buildImpressionEvent,
  buildConversionEvent,
  sendXdmEvent,
  trackOfferImpressions
} = require('../../lib/xdm-events')

const BACKBONE = {
  variantId: 'abcd1234abcd1234',
  campaignCode: 'SUMMER-2025-EMEA',
  modelId: 'standard',
  segmentAffinity: 'travel',
  generatedAt: '2025-06-01T00:00:00.000Z',
  promptLineage: 'UHJvZmVzc2lvbmFsIGhlcm8='
}

describe('buildImpressionEvent', () => {
  it('builds a valid decisioning.propositionDisplay event', () => {
    const event = buildImpressionEvent({
      offerId: 'offer-abc',
      activityId: 'activity-001',
      placementId: 'place-001',
      backbone: BACKBONE,
      ecid: 'ecid-xyz',
      channel: 'web'
    })

    expect(event.body.xdmEntity.eventType).toBe('decisioning.propositionDisplay')
    expect(event.body.xdmEntity.identityMap.ECID[0].id).toBe('ecid-xyz')

    const props = event.body.xdmEntity._experience.decisioning.propositions[0]
    expect(props.items[0].characteristics.variantId).toBe(BACKBONE.variantId)
    expect(props.items[0].characteristics.campaignCode).toBe(BACKBONE.campaignCode)

    const csc = event.body.xdmEntity._experience.contentSupplyChain
    expect(csc.variantId).toBe(BACKBONE.variantId)
    expect(csc.modelId).toBe(BACKBONE.modelId)
  })

  it('works without an ECID (anonymous visitor)', () => {
    const event = buildImpressionEvent({
      offerId: 'offer-abc',
      activityId: 'activity-001',
      placementId: 'place-001',
      backbone: BACKBONE
    })

    expect(event.body.xdmEntity.identityMap).toEqual({})
  })

  it('does not include the raw prompt in the event payload', () => {
    const event = buildImpressionEvent({
      offerId: 'offer-abc',
      activityId: 'activity-001',
      placementId: 'place-001',
      backbone: { ...BACKBONE, promptLineage: 'cmF3IHByb21wdA==' }
    })

    const raw = JSON.stringify(event)
    expect(raw).not.toContain('raw prompt')
  })
})

describe('buildConversionEvent', () => {
  it('builds a click conversion event', () => {
    const event = buildConversionEvent({
      offerId: 'offer-abc',
      backbone: BACKBONE,
      conversionType: 'click',
      ecid: 'ecid-xyz'
    })

    expect(event.body.xdmEntity.eventType).toBe('web.webInteraction.linkClicks')
    expect(event.body.xdmEntity._experience.contentSupplyChain.conversionType).toBe('click')
  })

  it('builds a purchase event with order value', () => {
    const event = buildConversionEvent({
      offerId: 'offer-abc',
      backbone: BACKBONE,
      conversionType: 'purchase',
      orderValue: 149.99
    })

    expect(event.body.xdmEntity.eventType).toBe('commerce.purchases')
    expect(event.body.xdmEntity.commerce.order.priceTotal).toBe(149.99)
  })
})

describe('sendXdmEvent', () => {
  const INLET_HOST = 'https://dcs.adobedc.net'
  const INLET_PATH = '/collection/test-inlet-id'
  const INLET_URL = `${INLET_HOST}${INLET_PATH}`

  afterEach(() => nock.cleanAll())

  it('POSTs the event to the streaming inlet', async () => {
    nock(INLET_HOST)
      .post(INLET_PATH)
      .reply(200, { inletId: 'test-inlet-id' })

    const event = buildImpressionEvent({
      offerId: 'offer-abc',
      activityId: 'activity-001',
      placementId: 'place-001',
      backbone: BACKBONE
    })

    await expect(sendXdmEvent(event, INLET_URL)).resolves.toBeUndefined()
  })

  it('logs a warning (non-fatal) when inlet URL is not configured', async () => {
    const originalEnv = process.env.AEP_STREAMING_INLET_URL
    delete process.env.AEP_STREAMING_INLET_URL

    const event = buildImpressionEvent({
      offerId: 'offer-abc',
      activityId: 'act',
      placementId: 'plc',
      backbone: BACKBONE
    })

    // Should not throw — non-fatal path
    await expect(sendXdmEvent(event, null)).resolves.toBeUndefined()

    process.env.AEP_STREAMING_INLET_URL = originalEnv
  })

  it('handles non-200 from inlet gracefully (non-fatal)', async () => {
    nock(INLET_HOST)
      .post(INLET_PATH)
      .reply(503, 'Service Unavailable')

    const event = buildImpressionEvent({
      offerId: 'offer-abc',
      activityId: 'act',
      placementId: 'plc',
      backbone: BACKBONE
    })

    // Should not throw
    await expect(sendXdmEvent(event, INLET_URL)).resolves.toBeUndefined()
  })
})

describe('trackOfferImpressions', () => {
  afterEach(() => nock.cleanAll())

  it('sends one XDM event per offer record', async () => {
    const inletHost = 'https://dcs.adobedc.net'
    const inletPath = '/collection/test-inlet'
    process.env.AEP_STREAMING_INLET_URL = `${inletHost}${inletPath}`

    let callCount = 0
    nock(inletHost)
      .post(inletPath)
      .times(3)
      .reply(200, () => { callCount++; return {} })

    const records = [
      { offerId: 'o1', backbone: BACKBONE },
      { offerId: 'o2', backbone: BACKBONE },
      { offerId: 'o3', backbone: BACKBONE }
    ]

    await trackOfferImpressions(records, { channel: 'web' })
    expect(callCount).toBe(3)

    delete process.env.AEP_STREAMING_INLET_URL
  })
})
