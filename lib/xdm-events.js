'use strict'

/**
 * AEP XDM ExperienceEvent streaming ingestion.
 *
 * Reference: https://experienceleague.adobe.com/docs/experience-platform/ingestion/streaming/overview.html
 *
 * All Firefly-generated asset impressions and interactions are tracked as
 * XDM ExperienceEvents. This is what enables Customer Journey Analytics to
 * answer: "Which Firefly variant (variantId) drives the highest conversion
 * rate for the travel segment in EMEA?"
 *
 * Two event types used here:
 *
 *   1. decisioning.propositionDisplay
 *      Fired when a variant is selected and served to a channel.
 *      Carries: variantId, campaignCode, modelId, segmentAffinity, offerId.
 *
 *   2. web.webInteraction.linkClicks
 *      Fired when a user interacts with the served content.
 *      Carries: same backbone + conversionType.
 *
 * The Datastream (Edge Network) routes events to:
 *   - AEP (profile stitching + segmentation)
 *   - Customer Journey Analytics (reporting dataset)
 *   - Adobe Analytics (optional, via Datastream mapping)
 *
 * ARCHITECTURE NOTE on Edge Segmentation:
 *   Real-time edge segment evaluation requires the segment to be explicitly
 *   configured for "Edge Evaluation" in AEP Segmentation UI. Not all segment
 *   types qualify (sequential segments, multi-entity segments do NOT evaluate
 *   at edge). Batch and streaming segmentation feed unified profile; only
 *   edge-enabled segments are available for sub-millisecond edge decisioning.
 */

const fetch = require('node-fetch')
const { v4: uuidv4 } = require('crypto')
const logger = require('@adobe/aio-lib-core-logging')(
  'firefly-content-supply-chain:xdm-events',
  { level: process.env.LOG_LEVEL || 'info' }
)

// AEP Streaming Ingestion endpoint (per-inlet, configured in Data Collection UI)
// Format: https://dcs.adobedc.net/collection/{inletId}
const STREAMING_INLET = process.env.AEP_STREAMING_INLET_URL

// ---------------------------------------------------------------------------
// Event builders
// ---------------------------------------------------------------------------

/**
 * Build an XDM ExperienceEvent for a content impression (variant served).
 *
 * Schema: XDM ExperienceEvent + _experience.decisioning extension.
 * The dataset in AEP must have the XDM ExperienceEvent mixin enabled,
 * plus the Decisioning Proposition Details field group.
 *
 * @param {object} opts
 * @param {string}   opts.offerId       AJO Offer ID
 * @param {string}   opts.activityId    AJO Decision Activity ID
 * @param {string}   opts.placementId   AJO Placement ID
 * @param {object}   opts.backbone      MetadataBackbone object
 * @param {string}   [opts.ecid]        ECID of the recipient (if known)
 * @param {string}   [opts.channel]     e.g. 'web' | 'email' | 'push'
 * @returns {object}  XDM event payload ready for streaming endpoint
 */
function buildImpressionEvent ({ offerId, activityId, placementId, backbone, ecid, channel = 'web' }) {
  const eventId = generateEventId()

  return {
    header: {
      datasetId: process.env.AEP_DATASET_ID || '',
      imsOrgId: process.env.AIO_IMS_ORG_ID || '',
      source: { name: 'content-supply-chain-app-builder' },
      schemaRef: {
        id: process.env.AEP_SCHEMA_REF || 'https://ns.adobe.com/experience/decisioning/proposition-event-type/display',
        contentType: 'application/vnd.adobe.xed-full+json;version=1'
      }
    },
    body: {
      xdmMeta: {
        schemaRef: {
          id: process.env.AEP_SCHEMA_REF || 'https://ns.adobe.com/xdm/context/experienceevent',
          contentType: 'application/vnd.adobe.xed-full+json;version=1'
        }
      },
      xdmEntity: {
        _id: eventId,
        eventType: 'decisioning.propositionDisplay',
        timestamp: new Date().toISOString(),
        identityMap: ecid
          ? { ECID: [{ id: ecid, primary: true, authenticatedState: 'ambiguous' }] }
          : {},
        _experience: {
          decisioning: {
            propositionID: generateEventId(),
            propositions: [
              {
                id: generateEventId(),
                scope: channel,
                activity: { id: activityId },
                placement: { id: placementId },
                items: [
                  {
                    id: offerId,
                    schema:
                      'https://ns.adobe.com/experience/offer-management/content-component-imagelink',
                    characteristics: {
                      // Metadata backbone propagated as offer characteristics
                      // so CJA can slice by variantId, campaignCode, modelId
                      variantId: backbone.variantId,
                      campaignCode: backbone.campaignCode,
                      modelId: backbone.modelId,
                      segmentAffinity: backbone.segmentAffinity,
                      generatedAt: backbone.generatedAt
                    }
                  }
                ]
              }
            ]
          },
          // Custom namespace for content supply chain attribution
          contentSupplyChain: {
            variantId: backbone.variantId,
            campaignCode: backbone.campaignCode,
            modelId: backbone.modelId,
            promptLineage: backbone.promptLineage,
            segmentAffinity: backbone.segmentAffinity
          }
        }
      }
    }
  }
}

/**
 * Build an XDM ExperienceEvent for a content conversion (click, form submit, purchase).
 *
 * @param {object} opts
 * @param {string}   opts.offerId
 * @param {object}   opts.backbone
 * @param {string}   opts.conversionType  e.g. 'click' | 'purchase' | 'formSubmit'
 * @param {string}   [opts.ecid]
 * @param {number}   [opts.orderValue]    For purchase events
 * @returns {object}
 */
function buildConversionEvent ({
  offerId, backbone, conversionType = 'click', ecid, orderValue
}) {
  const eventId = generateEventId()

  const event = {
    header: {
      datasetId: process.env.AEP_DATASET_ID || '',
      imsOrgId: process.env.AIO_IMS_ORG_ID || '',
      source: { name: 'content-supply-chain-app-builder' }
    },
    body: {
      xdmMeta: {
        schemaRef: {
          id: process.env.AEP_SCHEMA_REF || 'https://ns.adobe.com/xdm/context/experienceevent',
          contentType: 'application/vnd.adobe.xed-full+json;version=1'
        }
      },
      xdmEntity: {
        _id: eventId,
        eventType:
          conversionType === 'purchase'
            ? 'commerce.purchases'
            : 'web.webInteraction.linkClicks',
        timestamp: new Date().toISOString(),
        identityMap: ecid
          ? { ECID: [{ id: ecid, primary: true, authenticatedState: 'ambiguous' }] }
          : {},
        _experience: {
          contentSupplyChain: {
            variantId: backbone.variantId,
            campaignCode: backbone.campaignCode,
            modelId: backbone.modelId,
            offerId,
            conversionType,
            segmentAffinity: backbone.segmentAffinity
          }
        }
      }
    }
  }

  if (conversionType === 'purchase' && orderValue !== undefined) {
    event.body.xdmEntity.commerce = {
      purchases: { value: 1 },
      order: { priceTotal: orderValue, currencyCode: 'USD' }
    }
  }

  return event
}

// ---------------------------------------------------------------------------
// Streaming ingestion
// ---------------------------------------------------------------------------

/**
 * Send a single XDM ExperienceEvent to the AEP Streaming Inlet.
 *
 * @param {object} xdmEvent  Built by buildImpressionEvent or buildConversionEvent
 * @param {string} [inletUrl] Override inlet URL (for testing)
 * @returns {Promise<void>}
 */
async function sendXdmEvent (xdmEvent, inletUrl) {
  const url = inletUrl || STREAMING_INLET
  if (!url) {
    logger.warn(
      'AEP_STREAMING_INLET_URL not configured — XDM event skipped (non-fatal). ' +
      'Configure this to enable CJA attribution.'
    )
    return
  }

  logger.info('Sending XDM ExperienceEvent', {
    eventType: xdmEvent?.body?.xdmEntity?.eventType,
    variantId: xdmEvent?.body?.xdmEntity?._experience?.contentSupplyChain?.variantId
  })

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(xdmEvent)
  })

  if (!response.ok) {
    const body = await response.text()
    // Non-fatal: event loss is acceptable; AEM asset and offer still exist
    logger.warn('XDM streaming failed (non-fatal)', {
      status: response.status,
      body: body.substring(0, 200)
    })
    return
  }

  logger.info('XDM event accepted by AEP streaming inlet')
}

/**
 * Convenience: fire an impression event for each offer created from Firefly outputs.
 *
 * @param {Array<{offerId, backbone}>} offerRecords
 * @param {object} opts  activityId, placementId, channel, ecid
 * @returns {Promise<void>}
 */
async function trackOfferImpressions (offerRecords, opts = {}) {
  for (const { offerId, backbone } of offerRecords) {
    const event = buildImpressionEvent({
      offerId,
      activityId: opts.activityId || '',
      placementId: opts.placementId || '',
      backbone,
      ecid: opts.ecid,
      channel: opts.channel || 'web'
    })
    await sendXdmEvent(event)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateEventId () {
  // Use crypto.randomUUID if available (Node 15.6+), otherwise fallback
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

module.exports = {
  buildImpressionEvent,
  buildConversionEvent,
  sendXdmEvent,
  trackOfferImpressions
}
