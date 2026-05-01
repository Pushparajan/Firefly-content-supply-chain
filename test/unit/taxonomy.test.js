'use strict'

const {
  mapToAemTaxonomy,
  validateRequiredTaxonomy,
  getTaxonomyMap
} = require('../../lib/taxonomy')

describe('mapToAemTaxonomy', () => {
  const validMeta = {
    season: 'summer',
    market: 'emea',
    brand: 'Firefly Pro',
    assetType: 'hero banner',
    agencyName: 'Studio X',
    usageRights: 'Digital only',
    description: 'Test asset'
  }

  it('resolves all known taxonomy values to CQ tag paths', () => {
    const { aemMetadata } = mapToAemTaxonomy(validMeta, '/content/dam/campaigns')

    expect(aemMetadata['cq:tags']).toContain('/content/cq:tags/brand/seasons/summer')
    expect(aemMetadata['cq:tags']).toContain('/content/cq:tags/regions/emea')
    expect(aemMetadata['cq:tags']).toContain('/content/cq:tags/brand/products/firefly-pro')
    expect(aemMetadata['cq:tags']).toContain('/content/cq:tags/asset-type/hero-banner')
  })

  it('derives the correct target folder from taxonomy', () => {
    const { targetFolder } = mapToAemTaxonomy(validMeta, '/content/dam/campaigns')
    // folder = baseFolder / market / season / assetType-slug
    expect(targetFolder).toBe('/content/dam/campaigns/emea/summer/hero-banners')
  })

  it('handles alias "fall" → autumn tag', () => {
    const { aemMetadata } = mapToAemTaxonomy(
      { ...validMeta, season: 'fall' },
      '/content/dam/campaigns'
    )
    expect(aemMetadata['cq:tags']).toContain('/content/cq:tags/brand/seasons/autumn')
  })

  it('returns warnings for unrecognised taxonomy values', () => {
    const { warnings } = mapToAemTaxonomy(
      { ...validMeta, season: 'monsoon' },
      '/content/dam/campaigns'
    )
    expect(warnings.length).toBeGreaterThan(0)
    expect(warnings[0]).toMatch(/season.*monsoon/i)
  })

  it('is case-insensitive for input values', () => {
    const { aemMetadata } = mapToAemTaxonomy(
      { ...validMeta, market: 'EMEA', brand: 'FIREFLY PRO' },
      '/content/dam/campaigns'
    )
    expect(aemMetadata['cq:tags']).toContain('/content/cq:tags/regions/emea')
    expect(aemMetadata['cq:tags']).toContain('/content/cq:tags/brand/products/firefly-pro')
  })

  it('routes uncategorised assetType to uncategorised folder', () => {
    const { targetFolder } = mapToAemTaxonomy(
      { ...validMeta, assetType: 'unknown-type' },
      '/content/dam/campaigns'
    )
    expect(targetFolder).toContain('uncategorised')
  })

  it('uses "evergreen" season slug when season is empty', () => {
    const { targetFolder } = mapToAemTaxonomy(
      { ...validMeta, season: '' },
      '/content/dam/campaigns'
    )
    expect(targetFolder).toContain('evergreen')
  })

  it('preserves usageRights in AEM metadata', () => {
    const { aemMetadata } = mapToAemTaxonomy(validMeta, '/content/dam/campaigns')
    expect(aemMetadata['dam:usageRights']).toBe('Digital only')
  })
})

describe('validateRequiredTaxonomy', () => {
  const validMeta = {
    brand: 'Firefly Pro',
    market: 'emea',
    assetType: 'hero banner'
  }

  it('passes when all required dimensions are present and mapped', () => {
    expect(() => validateRequiredTaxonomy(validMeta)).not.toThrow()
  })

  it('throws when a required field is entirely missing', () => {
    const meta = { brand: 'Firefly Pro', assetType: 'hero banner' }
    expect(() => validateRequiredTaxonomy(meta)).toThrow(/market.*missing/i)
  })

  it('throws when a field value is not in the controlled vocabulary', () => {
    const meta = { ...validMeta, brand: 'UnknownBrand XYZ' }
    expect(() => validateRequiredTaxonomy(meta)).toThrow(/brand.*not in controlled vocabulary/i)
  })

  it('throws listing all invalid dimensions', () => {
    const meta = { brand: '???', market: '???', assetType: '???' }
    expect(() => validateRequiredTaxonomy(meta)).toThrow()
  })
})

describe('getTaxonomyMap', () => {
  it('returns a deep copy of the taxonomy map', () => {
    const map = getTaxonomyMap()
    expect(map).toHaveProperty('season')
    expect(map).toHaveProperty('market')
    expect(map).toHaveProperty('assetType')
    expect(map).toHaveProperty('brand')
    // Ensure it's a copy, not the original reference
    map.season.MODIFIED = 'test'
    expect(getTaxonomyMap().season.MODIFIED).toBeUndefined()
  })
})
