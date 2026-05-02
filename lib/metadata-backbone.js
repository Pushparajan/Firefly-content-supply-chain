'use strict'

/**
 * Metadata Backbone — standard identity block attached to every Firefly output.
 *
 * Adobe Experience League design principle: "Metadata is the backbone.
 * Without this, the system fails." Every asset generated, stored, or offered
 * must carry a consistent identity so AEM, AJO, and CJA can all correlate
 * the same object without ETL stitching.
 *
 * Fields:
 *   campaignCode   — links asset to a Workfront campaign (joins WF ↔ AEM ↔ AJO)
 *   variantId      — unique per Firefly output seed; used as AJO Offer externalId
 *   promptLineage  — full prompt text; enables "which prompt converts best?" in CJA
 *   modelId        — Firefly model used (standard or custom); enables model attribution
 *   segmentAffinity — intended audience; Offer Decisioning eligibility hint
 *   jobId          — Firefly async job reference for support/audit
 */

const crypto = require('crypto')

/**
 * Build the metadata backbone object for a Firefly generation job.
 *
 * @param {object} opts
 * @param {string}   opts.campaignCode      WF campaign identifier, e.g. "SUMMER-2025-EMEA"
 * @param {string}   opts.prompt            Full generation prompt (preserved verbatim)
 * @param {string}   opts.modelId           Firefly model ID ('standard' or custom UUID)
 * @param {string}   opts.jobId             Firefly async job ID
 * @param {number}   opts.seed              Variant seed from Firefly output
 * @param {string}   [opts.segmentAffinity] Intended audience, e.g. 'travel' | 'premium'
 * @param {object}   [opts.taxonomyTags]    Resolved taxonomy from mapToAemTaxonomy
 * @returns {MetadataBackbone}
 *
 * @typedef {object} MetadataBackbone
 * @property {string} campaignCode
 * @property {string} variantId          Deterministic: sha256(jobId+seed).slice(0,16)
 * @property {string} promptLineage      URL-safe base64 of the prompt
 * @property {string} modelId
 * @property {string} jobId
 * @property {string} segmentAffinity
 * @property {string} generatedAt        ISO-8601 timestamp
 */
function buildBackbone (opts) {
  const {
    campaignCode,
    prompt,
    modelId = 'standard',
    jobId,
    seed,
    segmentAffinity = '',
    taxonomyTags = {}
  } = opts

  if (!campaignCode) throw new Error('metadata-backbone: campaignCode is required')
  if (!jobId) throw new Error('metadata-backbone: jobId is required')
  if (seed === undefined || seed === null) throw new Error('metadata-backbone: seed is required')

  // Deterministic variantId: content-addressable, safe for use as AJO externalId
  const variantId = crypto
    .createHash('sha256')
    .update(`${jobId}:${seed}`)
    .digest('hex')
    .slice(0, 16)

  // Store the prompt without truncation — critical for CJA "prompt performance" analysis
  const promptLineage = Buffer.from(prompt || '', 'utf8').toString('base64url')

  return {
    campaignCode,
    variantId,
    promptLineage,
    modelId,
    jobId,
    seed: String(seed),
    segmentAffinity,
    generatedAt: new Date().toISOString(),
    ...flattenTaxonomy(taxonomyTags)
  }
}

/**
 * Convert backbone into AEM Sling POST form parameters.
 * Keys are namespaced under xmp: to avoid collision with system properties.
 *
 * @param {MetadataBackbone} backbone
 * @returns {object}  Flat key→value map for Sling POST metadata node
 */
function backboneToAemMetadata (backbone) {
  return {
    'xmp:CampaignCode': backbone.campaignCode,
    'xmp:VariantId': backbone.variantId,
    'xmp:PromptLineage': backbone.promptLineage,
    'xmp:ModelId': backbone.modelId,
    'xmp:FireflyJobId': backbone.jobId,
    'xmp:FireflySeed': backbone.seed,
    'xmp:SegmentAffinity': backbone.segmentAffinity,
    'xmp:GeneratedAt': backbone.generatedAt
  }
}

/**
 * Convert backbone into an AJO Offer characteristics map.
 * AJO stores these as free key/value pairs on the offer record,
 * queryable in Decision Management reports.
 *
 * @param {MetadataBackbone} backbone
 * @returns {object}
 */
function backboneToOfferCharacteristics (backbone) {
  return {
    variantId: backbone.variantId,
    campaignCode: backbone.campaignCode,
    modelId: backbone.modelId,
    segmentAffinity: backbone.segmentAffinity,
    generatedAt: backbone.generatedAt,
    promptLineage: backbone.promptLineage
  }
}

/**
 * Convert backbone into XDM ExperienceEvent content field.
 * Used when tracking impressions/interactions in AEP.
 *
 * @param {MetadataBackbone} backbone
 * @returns {object}  XDM _experience.decisioning extension
 */
function backboneToXdmContext (backbone) {
  return {
    variantId: backbone.variantId,
    campaignCode: backbone.campaignCode,
    modelId: backbone.modelId,
    segmentAffinity: backbone.segmentAffinity,
    promptSha: backbone.variantId   // already hashed; safe to expose in events
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function flattenTaxonomy (tags) {
  if (!tags || typeof tags !== 'object') return {}
  const flat = {}
  for (const [k, v] of Object.entries(tags)) {
    flat[`taxonomy_${k}`] = Array.isArray(v) ? v.join(',') : String(v)
  }
  return flat
}

module.exports = {
  buildBackbone,
  backboneToAemMetadata,
  backboneToOfferCharacteristics,
  backboneToXdmContext
}
