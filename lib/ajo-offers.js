'use strict'

/**
 * AJO Offer Decisioning (Decision Management) wrapper.
 *
 * Adobe Journey Optimizer Decision Management API.
 * Reference: https://experienceleague.adobe.com/docs/journey-optimizer/using/offer-decisioning/api-reference/
 *
 * Base URL:  https://platform.adobe.io/data/core/dps/
 * Auth:      Bearer {imsToken} + x-gw-ims-org-id + x-sandbox-name + x-api-key
 *
 * Key concept: each Firefly-generated variant becomes a Personalized Offer
 * in the AJO Offer Library. The Decision Activity (formerly "Activity") then
 * uses Placement + Eligibility Rules + Ranking to select the right offer
 * per user at request time (Edge) or batch time.
 *
 * Offer hierarchy in Decision Management:
 *   Placements        ← where the offer appears (web banner, email, etc.)
 *   Eligibility Rules ← profile/event conditions
 *   Collections       ← groups of related offers
 *   Offers (Pers.)    ← individual Firefly variant + content component
 *   Fallback Offer    ← shown when no personalized offer qualifies
 *   Decision Activity ← ties Placement + Collection + Ranking together
 */

const fetch = require('node-fetch')
const logger = require('@adobe/aio-lib-core-logging')(
  'firefly-content-supply-chain:ajo-offers',
  { level: process.env.LOG_LEVEL || 'info' }
)

const DPS_BASE = 'https://platform.adobe.io/data/core/dps'

// ---------------------------------------------------------------------------
// Shared headers
// ---------------------------------------------------------------------------

function dpsHeaders (imsToken, orgId, sandboxName, clientId) {
  return {
    Authorization: `Bearer ${imsToken}`,
    'x-gw-ims-org-id': orgId,
    'x-sandbox-name': sandboxName || 'prod',
    'x-api-key': clientId,
    'Content-Type': 'application/json',
    Accept: 'application/json'
  }
}

// ---------------------------------------------------------------------------
// Placements
// ---------------------------------------------------------------------------

/**
 * Retrieve an existing placement by name, or return null if not found.
 * Placements define the channel + format (web banner 2048×2048, email header, etc.)
 *
 * @param {object} opts
 * @param {string}   opts.imsToken
 * @param {string}   opts.orgId
 * @param {string}   opts.sandboxName
 * @param {string}   opts.clientId
 * @param {string}   opts.placementName  Human-readable name
 * @returns {Promise<object|null>}
 */
async function findOrCreatePlacement ({
  imsToken, orgId, sandboxName, clientId, placementName, channelType, contentType
}) {
  const headers = dpsHeaders(imsToken, orgId, sandboxName, clientId)

  // List placements and find by name
  const listRes = await fetch(`${DPS_BASE}/placements?limit=100`, { headers })
  if (!listRes.ok) {
    const body = await listRes.text()
    throw new Error(`DPS placements list failed [${listRes.status}]: ${body}`)
  }

  const list = await listRes.json()
  const existing = (list?.items || []).find((p) => p.name === placementName)
  if (existing) {
    logger.debug('Found existing AJO placement', { id: existing.id, name: placementName })
    return existing
  }

  // Create placement
  const payload = {
    name: placementName,
    description: `Auto-created by Content Supply Chain for ${placementName}`,
    channel: channelType || 'https://ns.adobe.com/xdm/channel-types/web',
    contentTypes: [contentType || 'https://ns.adobe.com/experience/offer-management/content-component-imagelink']
  }

  const createRes = await fetch(`${DPS_BASE}/placements`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  })

  if (!createRes.ok) {
    const body = await createRes.text()
    throw new Error(`DPS placement create failed [${createRes.status}]: ${body}`)
  }

  const placement = await createRes.json()
  logger.info('Created AJO placement', { id: placement.id, name: placementName })
  return placement
}

// ---------------------------------------------------------------------------
// Eligibility rules
// ---------------------------------------------------------------------------

/**
 * Find or create a profile-attribute eligibility rule for a segment affinity.
 *
 * The rule evaluates: profile.segmentMembership contains {segmentAffinity}
 * OR a simpler attribute rule: profile._experience.analytics.customDimensions.eVar5 = {affinity}
 *
 * For production, replace with a pre-built AEP segment ID lookup.
 *
 * @param {object} opts
 * @returns {Promise<{id: string, name: string}>}
 */
async function findOrCreateEligibilityRule ({
  imsToken, orgId, sandboxName, clientId, segmentAffinity
}) {
  if (!segmentAffinity) return null

  const headers = dpsHeaders(imsToken, orgId, sandboxName, clientId)
  const ruleName = `segment-affinity-${segmentAffinity}`

  const listRes = await fetch(`${DPS_BASE}/eligibility-rules?limit=100`, { headers })
  if (listRes.ok) {
    const list = await listRes.json()
    const existing = (list?.items || []).find((r) => r.name === ruleName)
    if (existing) return existing
  }

  // PQL (Profile Query Language) rule: audience affinity check
  const payload = {
    name: ruleName,
    description: `Auto-generated rule for segment affinity: ${segmentAffinity}`,
    condition: {
      type: 'PQL',
      format: 'pql/text',
      // Checks unified profile attribute set by edge segmentation
      value: `_experience.customerJourneyManagement.messageProfile.channel.typeAtSource = "${segmentAffinity}"`
    }
  }

  const createRes = await fetch(`${DPS_BASE}/eligibility-rules`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  })

  if (!createRes.ok) {
    const body = await createRes.text()
    throw new Error(`DPS eligibility rule create failed [${createRes.status}]: ${body}`)
  }

  const rule = await createRes.json()
  logger.info('Created AJO eligibility rule', { id: rule.id, name: ruleName })
  return rule
}

// ---------------------------------------------------------------------------
// Personalized Offers
// ---------------------------------------------------------------------------

/**
 * Create a Personalized Offer in the AJO Offer Library from a Firefly variant.
 *
 * Each Firefly output seed becomes one Offer. The offer's representation
 * links to the AEM asset URL so the edge can return the correct image.
 *
 * Characteristics (variantId, campaignCode, modelId, etc.) are stored on the
 * offer and flow through to CJA for "which variant converts best?" analysis.
 *
 * @param {object} opts
 * @param {string}   opts.imsToken
 * @param {string}   opts.orgId
 * @param {string}   opts.sandboxName
 * @param {string}   opts.clientId
 * @param {string}   opts.offerName        Human-readable e.g. "Summer Hero - Travel v3"
 * @param {string}   opts.aemAssetUrl      Public URL of the AEM rendition
 * @param {string}   opts.placementId      From findOrCreatePlacement
 * @param {object}   opts.backbone         MetadataBackbone object
 * @param {string}   [opts.eligibilityRuleId]  From findOrCreateEligibilityRule
 * @param {string}   [opts.startDate]      ISO-8601
 * @param {string}   [opts.endDate]        ISO-8601
 * @param {number}   [opts.priority]       Higher = preferred in ranking (0–100)
 * @returns {Promise<object>}  Created offer record including id
 */
async function createPersonalizedOffer ({
  imsToken, orgId, sandboxName, clientId,
  offerName, aemAssetUrl, placementId, backbone,
  eligibilityRuleId, startDate, endDate, priority = 0
}) {
  const headers = dpsHeaders(imsToken, orgId, sandboxName, clientId)

  const now = new Date()
  const defaultEnd = new Date(now.getFullYear() + 1, now.getMonth(), now.getDate())

  const payload = {
    name: offerName,
    status: 'draft',    // promote to 'approved' after review in AJO UI
    representations: [
      {
        placement: placementId,
        components: [
          {
            type: 'https://ns.adobe.com/experience/offer-management/content-component-imagelink',
            // deliveryURL is the public AEM asset URL served by AEM delivery
            deliveryURL: aemAssetUrl,
            language: ['en-US'],
            // Content credentials — links back to generation provenance
            _experience: {
              contentIntelligence: {
                assetID: backbone.variantId,
                generationModel: backbone.modelId
              }
            }
          }
        ]
      }
    ],
    selectionConstraint: {
      startDate: startDate || now.toISOString(),
      endDate: endDate || defaultEnd.toISOString(),
      profileConstraintType: eligibilityRuleId ? 'eligibilityRule' : 'none',
      ...(eligibilityRuleId && { eligibilityRule: eligibilityRuleId })
    },
    rank: {
      priority
    },
    // Characteristics flow through to CJA as offer dimensions
    characteristics: {
      variantId: backbone.variantId,
      campaignCode: backbone.campaignCode,
      modelId: backbone.modelId,
      segmentAffinity: backbone.segmentAffinity,
      generatedAt: backbone.generatedAt,
      promptLineage: backbone.promptLineage
    },
    tags: []
  }

  logger.info('Creating AJO personalized offer', {
    offerName,
    variantId: backbone.variantId,
    campaignCode: backbone.campaignCode
  })

  const res = await fetch(`${DPS_BASE}/offers`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(
      `DPS offer create failed [${res.status}] for ${offerName}: ${body}`
    )
  }

  const offer = await res.json()
  logger.info('AJO offer created', {
    offerId: offer.id,
    variantId: backbone.variantId,
    status: offer.status
  })
  return offer
}

// ---------------------------------------------------------------------------
// Offer Collections
// ---------------------------------------------------------------------------

/**
 * Add offers to an Offer Collection so they can be used in a Decision Activity.
 * Collections group related offers (e.g. all Summer 2025 EMEA variants).
 *
 * @param {object} opts
 * @param {string}   opts.imsToken
 * @param {string}   opts.orgId
 * @param {string}   opts.sandboxName
 * @param {string}   opts.clientId
 * @param {string}   opts.campaignCode  Used as collection name/filter
 * @param {string[]} opts.offerIds      Array of offer IDs to include
 * @returns {Promise<object>}
 */
async function findOrCreateCollection ({
  imsToken, orgId, sandboxName, clientId, campaignCode, offerIds = []
}) {
  const headers = dpsHeaders(imsToken, orgId, sandboxName, clientId)
  const collectionName = `collection-${campaignCode}`

  const listRes = await fetch(`${DPS_BASE}/offer-collections?limit=100`, { headers })
  if (listRes.ok) {
    const list = await listRes.json()
    const existing = (list?.items || []).find((c) => c.name === collectionName)
    if (existing) {
      logger.debug('Found existing AJO collection', { id: existing.id, collectionName })
      return existing
    }
  }

  const payload = {
    name: collectionName,
    description: `Auto-created for campaign ${campaignCode}`,
    filter: {
      type: 'offerFilter',
      ids: offerIds
    }
  }

  const createRes = await fetch(`${DPS_BASE}/offer-collections`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  })

  if (!createRes.ok) {
    const body = await createRes.text()
    throw new Error(`DPS collection create failed [${createRes.status}]: ${body}`)
  }

  const collection = await createRes.json()
  logger.info('AJO offer collection created', { id: collection.id, collectionName })
  return collection
}

// ---------------------------------------------------------------------------
// Offer query (server-side decisioning)
// ---------------------------------------------------------------------------

/**
 * Request a server-side offer decision for a given profile + placement.
 *
 * This is the server-side path (App Builder → DPS). For real-time edge
 * personalization use the Web SDK `sendEvent` with decisionScopes instead.
 *
 * IMPORTANT: Edge Segmentation must be explicitly enabled on the AEP segment
 * for real-time edge evaluation. Server-side is synchronous but incurs
 * a round-trip. Both modes use the same Offer Library data.
 *
 * @param {object} opts
 * @param {string}   opts.imsToken
 * @param {string}   opts.orgId
 * @param {string}   opts.sandboxName
 * @param {string}   opts.clientId
 * @param {string}   opts.activityId   AJO Decision Activity ID
 * @param {string}   opts.placementId
 * @param {string}   opts.profileId    ECID or CRM ID
 * @returns {Promise<object>}  Winning offer
 */
async function requestDecision ({
  imsToken, orgId, sandboxName, clientId,
  activityId, placementId, profileId
}) {
  const headers = dpsHeaders(imsToken, orgId, sandboxName, clientId)

  const payload = {
    'xdm:activityId': activityId,
    'xdm:placementId': placementId,
    'xdm:itemCount': 1
  }

  if (profileId) {
    payload['xdm:identityMap'] = {
      ECID: [{ id: profileId, authenticatedState: 'authenticated' }]
    }
  }

  logger.info('Requesting AJO offer decision', { activityId, placementId, profileId })

  const res = await fetch(`${DPS_BASE}/decisions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`DPS decision request failed [${res.status}]: ${body}`)
  }

  const decision = await res.json()
  logger.info('AJO decision received', {
    offersReturned: decision?.propositions?.length || 0
  })
  return decision
}

module.exports = {
  findOrCreatePlacement,
  findOrCreateEligibilityRule,
  createPersonalizedOffer,
  findOrCreateCollection,
  requestDecision
}
