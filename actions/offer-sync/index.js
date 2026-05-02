'use strict'

/**
 * Offer Sync Action — Firefly Variants → AJO Offer Library
 *
 * Called internally after the orchestrate action completes AEM upload.
 * Receives the AEM asset paths, metadata backbone records, and taxonomy data,
 * then registers each Firefly variant as a Personalized Offer in AJO
 * Offer Decisioning (Decision Management).
 *
 * Why a separate action?
 *   The orchestrate action already runs close to its 300-second timeout.
 *   Offer Decisioning API calls add another 10–30 seconds per variant.
 *   Separating the concern keeps orchestrate fast and makes offer sync
 *   independently retriable when AJO has transient latency.
 *
 * Caller (orchestrate) invokes this via internal HTTP POST:
 *   POST /offer-sync
 *   { renditions: [{fileName, aemPath, backbone, seed, mimeType}], campaignCode }
 *
 * Payload shape:
 * {
 *   campaignCode: "SUMMER-2025-EMEA",
 *   placementName: "Web Hero Banner 2048x2048",
 *   startDate: "2025-06-01T00:00:00Z",
 *   endDate: "2025-08-31T23:59:59Z",
 *   renditions: [
 *     {
 *       fileName: "hero-banner-summer-v1.jpg",
 *       aemPath: "/content/dam/campaigns/emea/summer/hero-banners/hero-banner-summer-v1.jpg",
 *       aemPublishUrl: "https://publish-p1-e1.adobeaemcloud.com",
 *       backbone: { variantId, campaignCode, modelId, segmentAffinity, promptLineage, ... },
 *       segmentAffinity: "travel"
 *     }
 *   ]
 * }
 */

const logger = require('@adobe/aio-lib-core-logging')(
  'firefly-content-supply-chain:offer-sync',
  { level: process.env.LOG_LEVEL || 'info' }
)

const {
  findOrCreatePlacement,
  findOrCreateEligibilityRule,
  createPersonalizedOffer,
  findOrCreateCollection
} = require('../../lib/ajo-offers')
const { trackOfferImpressions } = require('../../lib/xdm-events')
const { resolveImsToken } = require('../../lib/ims')

// ---------------------------------------------------------------------------
// Action entry point
// ---------------------------------------------------------------------------

async function main (params) {
  logger.info('Offer sync action invoked')

  // ---- 0. Auth ----
  let imsToken
  try {
    imsToken = await resolveImsToken(params)
  } catch (imsError) {
    return errorResponse(500, `IMS authentication failed: ${imsError.message}`)
  }

  const orgId = params.AIO_IMS_ORG_ID || process.env.AIO_IMS_ORG_ID
  const sandboxName = params.AEP_SANDBOX_NAME || process.env.AEP_SANDBOX_NAME || 'prod'
  const clientId = params.CLIENT_ID || process.env.CLIENT_ID
  const aemPublishHost = params.AEM_PUBLISH_HOST || process.env.AEM_PUBLISH_HOST

  // ---- 1. Parse payload ----
  let body
  try {
    body = typeof params.__ow_body === 'string'
      ? JSON.parse(params.__ow_body)
      : (params.__ow_body || params)
  } catch {
    return errorResponse(400, 'Could not parse request body as JSON')
  }

  const { campaignCode, renditions = [], placementName, startDate, endDate } = body

  if (!campaignCode) return errorResponse(400, 'Missing campaignCode')
  if (!renditions.length) return errorResponse(400, 'renditions array is empty')

  logger.info('Syncing Firefly variants to AJO Offer Library', {
    campaignCode,
    variantCount: renditions.length
  })

  const dpsOpts = { imsToken, orgId, sandboxName, clientId }

  // ---- 2. Resolve or create the Placement ----
  // A placement defines where the offer is shown: channel + format.
  // Using one placement per campaign dimension keeps Decision Activities manageable.
  let placement
  try {
    placement = await findOrCreatePlacement({
      ...dpsOpts,
      placementName: placementName || `Web Hero Banner - ${campaignCode}`,
      channelType: 'https://ns.adobe.com/xdm/channel-types/web',
      contentType: 'https://ns.adobe.com/experience/offer-management/content-component-imagelink'
    })
  } catch (placementError) {
    return errorResponse(502, `AJO placement error: ${placementError.message}`)
  }

  // ---- 3. Create one Personalized Offer per Firefly variant ----
  const createdOffers = []
  const offerErrors = []

  for (const rendition of renditions) {
    const { aemPath, backbone, segmentAffinity } = rendition

    if (!aemPath || !backbone) {
      offerErrors.push({ rendition: rendition.fileName, error: 'missing aemPath or backbone' })
      continue
    }

    // 3a. Resolve eligibility rule for segment affinity
    let eligibilityRule = null
    if (segmentAffinity) {
      try {
        eligibilityRule = await findOrCreateEligibilityRule({
          ...dpsOpts,
          segmentAffinity
        })
      } catch (ruleError) {
        logger.warn('Eligibility rule creation failed (offer will have no eligibility constraint)', {
          segmentAffinity,
          error: ruleError.message
        })
      }
    }

    // 3b. Build the public AEM asset URL for the offer representation.
    // AEM Assets content is served by the publish/CDN tier, not author.
    const aemAssetUrl = aemPublishHost
      ? `${aemPublishHost}${aemPath}`
      : `https://placeholder-publish.adobeaemcloud.com${aemPath}`

    const offerName =
      `${campaignCode} - ${segmentAffinity || 'general'} - ${backbone.variantId}`

    // 3c. Create the Personalized Offer in AJO
    try {
      const offer = await createPersonalizedOffer({
        ...dpsOpts,
        offerName,
        aemAssetUrl,
        placementId: placement.id,
        backbone,
        eligibilityRuleId: eligibilityRule?.id,
        startDate,
        endDate,
        // Higher segment affinity precision → higher priority in ranking
        priority: segmentAffinity ? 10 : 0
      })

      createdOffers.push({
        offerId: offer.id,
        offerName,
        variantId: backbone.variantId,
        segmentAffinity: segmentAffinity || 'general',
        aemAssetUrl,
        backbone
      })
    } catch (offerError) {
      logger.error('Failed to create AJO offer for variant', {
        variantId: backbone.variantId,
        error: offerError.message
      })
      offerErrors.push({ rendition: rendition.fileName, error: offerError.message })
    }
  }

  // ---- 4. Create / update Offer Collection for the campaign ----
  let collection = null
  if (createdOffers.length > 0) {
    try {
      collection = await findOrCreateCollection({
        ...dpsOpts,
        campaignCode,
        offerIds: createdOffers.map((o) => o.offerId)
      })
    } catch (collectionError) {
      logger.warn('Collection create failed (non-fatal)', {
        error: collectionError.message
      })
    }

    // ---- 5. Track creation as XDM impression events (supply-side) ----
    // These events feed CJA with the "offer was created and available" signal.
    // Actual impression tracking happens when the offer is served to an end user
    // via Web SDK / Edge Network. We track here for supply-chain attribution.
    try {
      await trackOfferImpressions(
        createdOffers.map((o) => ({ offerId: o.offerId, backbone: o.backbone })),
        { channel: 'content-supply-chain' }
      )
    } catch (xdmError) {
      logger.warn('XDM impression tracking failed (non-fatal)', {
        error: xdmError.message
      })
    }
  }

  // ---- 6. Return ----
  const result = {
    success: true,
    campaignCode,
    placementId: placement.id,
    collectionId: collection?.id,
    offersCreated: createdOffers.map((o) => ({
      offerId: o.offerId,
      variantId: o.variantId,
      segmentAffinity: o.segmentAffinity,
      status: 'draft'   // Offers require manual promotion to 'approved' in AJO UI
    })),
    offerErrors,
    note: 'Offers are in draft status. Promote to approved in AJO Offer Library before activating the Decision Activity.'
  }

  logger.info('Offer sync complete', {
    created: createdOffers.length,
    errors: offerErrors.length,
    campaignCode
  })

  return successResponse(result)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function successResponse (body) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }
}

function errorResponse (statusCode, message) {
  logger.error(`Offer sync error [${statusCode}]: ${message}`)
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ success: false, error: message })
  }
}

module.exports = { main }
