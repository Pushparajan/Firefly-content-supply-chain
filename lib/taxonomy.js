'use strict'

/**
 * AEM Taxonomy mapper.
 *
 * The core problem: agencies fill in free-text metadata in Content Hub
 * ("summer", "EMEA", "hero banner"). AEM Assets requires controlled-vocabulary
 * CQ tag paths ("/content/cq:tags/brand/seasons/summer").
 *
 * This module:
 *  1. Maintains lookup tables for each metadata dimension
 *  2. Normalises agency free-text to lowercase, trims noise
 *  3. Resolves the correct AEM tag path (or throws if unmapped)
 *  4. Derives the correct DAM target folder from the taxonomy
 *  5. Builds the full AEM metadata payload ready for completeUpload
 *
 * Extend TAXONOMY_MAP with your brand's own controlled vocabulary.
 * For large enterprises, replace the static map with a runtime lookup
 * against the AEM Tags API: GET /bin/querybuilder.json?type=cq:Tag
 */

const logger = require('@adobe/aio-lib-core-logging')(
  'firefly-content-supply-chain:taxonomy',
  { level: process.env.LOG_LEVEL || 'info' }
)

// ---------------------------------------------------------------------------
// Controlled vocabulary — extend per your brand taxonomy
// ---------------------------------------------------------------------------

const TAXONOMY_MAP = {
  // ---- Seasons ----
  season: {
    summer: '/content/cq:tags/brand/seasons/summer',
    spring: '/content/cq:tags/brand/seasons/spring',
    autumn: '/content/cq:tags/brand/seasons/autumn',
    fall: '/content/cq:tags/brand/seasons/autumn',   // alias
    winter: '/content/cq:tags/brand/seasons/winter',
    'all-year': '/content/cq:tags/brand/seasons/all-year',
    evergreen: '/content/cq:tags/brand/seasons/all-year'
  },

  // ---- Geographic markets ----
  market: {
    emea: '/content/cq:tags/regions/emea',
    amer: '/content/cq:tags/regions/amer',
    apac: '/content/cq:tags/regions/apac',
    global: '/content/cq:tags/regions/global',
    us: '/content/cq:tags/regions/amer/us',
    uk: '/content/cq:tags/regions/emea/uk',
    de: '/content/cq:tags/regions/emea/de',
    fr: '/content/cq:tags/regions/emea/fr',
    jp: '/content/cq:tags/regions/apac/jp',
    au: '/content/cq:tags/regions/apac/au'
  },

  // ---- Asset type ----
  assetType: {
    'hero banner': '/content/cq:tags/asset-type/hero-banner',
    'hero-banner': '/content/cq:tags/asset-type/hero-banner',
    banner: '/content/cq:tags/asset-type/hero-banner',
    thumbnail: '/content/cq:tags/asset-type/thumbnail',
    'social post': '/content/cq:tags/asset-type/social',
    social: '/content/cq:tags/asset-type/social',
    'email header': '/content/cq:tags/asset-type/email-header',
    email: '/content/cq:tags/asset-type/email-header',
    'product shot': '/content/cq:tags/asset-type/product-shot',
    product: '/content/cq:tags/asset-type/product-shot',
    'lifestyle photo': '/content/cq:tags/asset-type/lifestyle',
    lifestyle: '/content/cq:tags/asset-type/lifestyle',
    video: '/content/cq:tags/asset-type/video',
    gif: '/content/cq:tags/asset-type/animated'
  },

  // ---- Brand lines ----
  brand: {
    'firefly pro': '/content/cq:tags/brand/products/firefly-pro',
    'firefly': '/content/cq:tags/brand/products/firefly',
    'acrobat': '/content/cq:tags/brand/products/acrobat',
    'photoshop': '/content/cq:tags/brand/products/photoshop',
    'express': '/content/cq:tags/brand/products/express',
    'corporate': '/content/cq:tags/brand/corporate'
  },

  // ---- Color palette ----
  colorPalette: {
    red: '/content/cq:tags/brand/colors/red',
    blue: '/content/cq:tags/brand/colors/blue',
    green: '/content/cq:tags/brand/colors/green',
    black: '/content/cq:tags/brand/colors/black',
    white: '/content/cq:tags/brand/colors/white',
    'dark mode': '/content/cq:tags/brand/colors/dark-mode',
    'light mode': '/content/cq:tags/brand/colors/light-mode',
    monochrome: '/content/cq:tags/brand/colors/monochrome'
  }
}

// ---------------------------------------------------------------------------
// Folder routing — derives AEM DAM target path from taxonomy
// ---------------------------------------------------------------------------

const FOLDER_ROUTING = {
  // assetType slug → sub-folder
  'hero-banner': 'hero-banners',
  thumbnail: 'thumbnails',
  social: 'social',
  'email-header': 'email',
  'product-shot': 'products',
  lifestyle: 'lifestyle',
  video: 'video',
  animated: 'animated'
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Map free-text agency metadata to AEM approved taxonomy.
 *
 * Returns a fully resolved AEM metadata payload including:
 *  - cq:tags array of resolved tag paths
 *  - dc:title, dc:description
 *  - dam:scene7Domain ready for S7 integration
 *  - Target DAM folder path
 *
 * @param {object} agencyMetadata   Raw metadata from Content Hub asset
 * @param {string} baseFolder       Root AEM DAM folder, e.g. /content/dam/campaigns
 * @returns {{ aemMetadata: object, targetFolder: string, warnings: string[] }}
 */
function mapToAemTaxonomy (agencyMetadata, baseFolder = '/content/dam/campaigns') {
  const warnings = []
  const tags = []

  // Resolve each dimension; collect warnings for unmapped values
  for (const [dimension, value] of Object.entries(agencyMetadata)) {
    if (!value || !(dimension in TAXONOMY_MAP)) continue

    const normalised = value.toString().toLowerCase().trim()
    const tagPath = TAXONOMY_MAP[dimension]?.[normalised]

    if (tagPath) {
      tags.push(tagPath)
    } else {
      warnings.push(
        `[taxonomy] No AEM tag for ${dimension}="${value}" — asset will be ingested without this tag`
      )
      logger.warn('Unmapped taxonomy value', { dimension, value: normalised })
    }
  }

  // Derive target folder from assetType
  const assetTypeNorm = (agencyMetadata.assetType || '').toLowerCase().trim()
  const assetTypeTag = TAXONOMY_MAP.assetType?.[assetTypeNorm] || ''
  const assetTypeSlug = assetTypeTag.split('/').pop() || 'uncategorised'
  const subFolder = FOLDER_ROUTING[assetTypeSlug] || 'uncategorised'

  // Incorporate season and market into folder path for browse-ability
  const seasonNorm = (agencyMetadata.season || '').toLowerCase().trim()
  const marketNorm = (agencyMetadata.market || '').toLowerCase().trim()
  const seasonSlug = seasonNorm.replace(/\s+/g, '-') || 'evergreen'
  const marketSlug = marketNorm.replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') || 'global'

  // Final folder: /content/dam/campaigns/{market}/{season}/{assetType}
  const targetFolder = [baseFolder, marketSlug, seasonSlug, subFolder]
    .filter(Boolean)
    .join('/')

  const aemMetadata = {
    'dc:title': agencyMetadata.description || '',
    'dc:description': agencyMetadata.description || '',
    'cq:tags': tags,
    'dam:assetState': 'processed',
    'dam:scene7Domain': '',   // populated downstream if S7 is in scope
    'xmp:CreatorTool': 'Adobe Content Hub Agency Contribution',
    'xmp:Agency': agencyMetadata.agencyName || '',
    'dam:usageRights': agencyMetadata.usageRights || 'Internal Use Only'
  }

  logger.info('Taxonomy mapped', {
    tagCount: tags.length,
    targetFolder,
    warnings: warnings.length
  })

  return { aemMetadata, targetFolder, warnings }
}

/**
 * Validate that mandatory taxonomy fields are present before ingestion.
 * Throw if any required field is missing or unresolvable.
 *
 * @param {object} agencyMetadata
 * @param {string[]} requiredDimensions  e.g. ['brand', 'market', 'assetType']
 * @throws {Error}
 */
function validateRequiredTaxonomy (agencyMetadata, requiredDimensions = ['brand', 'market', 'assetType']) {
  const missing = []

  for (const dim of requiredDimensions) {
    const raw = agencyMetadata[dim]
    if (!raw) {
      missing.push(`${dim} (missing)`)
      continue
    }
    const norm = raw.toString().toLowerCase().trim()
    if (!TAXONOMY_MAP[dim]?.[norm]) {
      missing.push(`${dim}="${raw}" (not in controlled vocabulary)`)
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Asset rejected: required taxonomy fields unresolvable: ${missing.join('; ')}. ` +
      'Update the agency upload form or extend TAXONOMY_MAP.'
    )
  }
}

/**
 * Return the full TAXONOMY_MAP for introspection or UI rendering.
 * Useful for populating Content Hub upload form dropdowns so agencies
 * only see valid values.
 */
function getTaxonomyMap () {
  return JSON.parse(JSON.stringify(TAXONOMY_MAP))
}

module.exports = {
  mapToAemTaxonomy,
  validateRequiredTaxonomy,
  getTaxonomyMap
}
