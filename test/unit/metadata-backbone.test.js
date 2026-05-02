'use strict'

const {
  buildBackbone,
  backboneToAemMetadata,
  backboneToOfferCharacteristics,
  backboneToXdmContext
} = require('../../lib/metadata-backbone')

const BASE = {
  campaignCode: 'SUMMER-2025-EMEA',
  prompt: 'Professional hero banner, summer lifestyle, beach',
  modelId: 'ff-custom-brand-v2',
  jobId: 'job-abc123def456',
  seed: 98765
}

describe('buildBackbone', () => {
  it('creates a backbone with all required fields', () => {
    const bb = buildBackbone(BASE)
    expect(bb.campaignCode).toBe('SUMMER-2025-EMEA')
    expect(bb.variantId).toBeTruthy()
    expect(bb.promptLineage).toBeTruthy()
    expect(bb.modelId).toBe('ff-custom-brand-v2')
    expect(bb.jobId).toBe('job-abc123def456')
    expect(bb.seed).toBe('98765')
    expect(bb.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('generates a deterministic variantId from jobId + seed', () => {
    const bb1 = buildBackbone(BASE)
    const bb2 = buildBackbone(BASE)
    expect(bb1.variantId).toBe(bb2.variantId)
  })

  it('generates different variantIds for different seeds', () => {
    const bb1 = buildBackbone({ ...BASE, seed: 1 })
    const bb2 = buildBackbone({ ...BASE, seed: 2 })
    expect(bb1.variantId).not.toBe(bb2.variantId)
  })

  it('variantId is 16 hex chars', () => {
    const bb = buildBackbone(BASE)
    expect(bb.variantId).toMatch(/^[0-9a-f]{16}$/)
  })

  it('stores promptLineage as base64url of the prompt', () => {
    const bb = buildBackbone(BASE)
    const decoded = Buffer.from(bb.promptLineage, 'base64url').toString('utf8')
    expect(decoded).toBe(BASE.prompt)
  })

  it('defaults modelId to "standard" when not provided', () => {
    const bb = buildBackbone({ ...BASE, modelId: undefined })
    expect(bb.modelId).toBe('standard')
  })

  it('defaults segmentAffinity to empty string', () => {
    const bb = buildBackbone(BASE)
    expect(bb.segmentAffinity).toBe('')
  })

  it('includes segmentAffinity when provided', () => {
    const bb = buildBackbone({ ...BASE, segmentAffinity: 'travel' })
    expect(bb.segmentAffinity).toBe('travel')
  })

  it('throws when campaignCode is missing', () => {
    expect(() => buildBackbone({ ...BASE, campaignCode: undefined })).toThrow(/campaignCode/)
  })

  it('throws when jobId is missing', () => {
    expect(() => buildBackbone({ ...BASE, jobId: undefined })).toThrow(/jobId/)
  })

  it('throws when seed is missing', () => {
    expect(() => buildBackbone({ ...BASE, seed: undefined })).toThrow(/seed/)
  })
})

describe('backboneToAemMetadata', () => {
  it('maps to xmp: namespaced AEM properties', () => {
    const bb = buildBackbone(BASE)
    const meta = backboneToAemMetadata(bb)
    expect(meta['xmp:CampaignCode']).toBe('SUMMER-2025-EMEA')
    expect(meta['xmp:VariantId']).toBe(bb.variantId)
    expect(meta['xmp:ModelId']).toBe('ff-custom-brand-v2')
    expect(meta['xmp:PromptLineage']).toBe(bb.promptLineage)
    expect(meta['xmp:FireflyJobId']).toBe('job-abc123def456')
  })
})

describe('backboneToOfferCharacteristics', () => {
  it('returns AJO-compatible characteristics map', () => {
    const bb = buildBackbone({ ...BASE, segmentAffinity: 'premium' })
    const chars = backboneToOfferCharacteristics(bb)
    expect(chars.variantId).toBe(bb.variantId)
    expect(chars.campaignCode).toBe('SUMMER-2025-EMEA')
    expect(chars.segmentAffinity).toBe('premium')
  })
})

describe('backboneToXdmContext', () => {
  it('returns XDM extension fields without sensitive data', () => {
    const bb = buildBackbone(BASE)
    const ctx = backboneToXdmContext(bb)
    expect(ctx.variantId).toBe(bb.variantId)
    expect(ctx.campaignCode).toBe('SUMMER-2025-EMEA')
    // promptSha should be the already-hashed variantId (not the raw prompt)
    expect(ctx.promptSha).toBe(bb.variantId)
    // Raw prompt must NOT be in the XDM event (PII/IP risk)
    expect(JSON.stringify(ctx)).not.toContain(BASE.prompt)
  })
})
