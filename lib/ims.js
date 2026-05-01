'use strict'

/**
 * IMS token resolver using the @adobe/aio-sdk IMS context.
 *
 * App Builder actions run with pre-injected __ow_headers that include
 * user bearer tokens for user-based flows. For server-to-server flows
 * (this pipeline) we resolve tokens from the OAuth S2S credentials
 * stored in the action's environment params.
 */

const { IMS } = require('@adobe/aio-sdk')
const logger = require('@adobe/aio-lib-core-logging')(
  'firefly-content-supply-chain:ims',
  { level: process.env.LOG_LEVEL || 'info' }
)

/**
 * Resolve an IMS OAuth Server-to-Server access token.
 *
 * Reads CLIENT_ID / CLIENT_SECRET from action params (injected by App Builder
 * at runtime from manifest environment bindings).
 *
 * @param {object} params   App Builder action params object
 * @returns {Promise<string>}  Raw access token string
 */
async function resolveImsToken (params) {
  const clientId = params.CLIENT_ID || process.env.CLIENT_ID
  const clientSecret = params.CLIENT_SECRET || process.env.CLIENT_SECRET
  const imsOrgId = params.AIO_IMS_ORG_ID || process.env.AIO_IMS_ORG_ID

  if (!clientId || !clientSecret) {
    throw new Error(
      'IMS credentials missing: CLIENT_ID and CLIENT_SECRET must be set in action params'
    )
  }

  logger.debug('Resolving IMS S2S token', { clientId, imsOrgId })

  const imsClient = await IMS.createImsClient({
    clientId,
    clientSecret,
    imsOrgId,
    scopes: [
      'AdobeID',
      'openid',
      'firefly_api',
      'ff_apis',
      'aem_assets_api'
    ]
  })

  const tokenResponse = await imsClient.getAccessToken()
  const token = tokenResponse?.access_token || tokenResponse

  if (!token) {
    throw new Error('IMS returned no access token')
  }

  logger.info('IMS token resolved successfully')
  return token
}

module.exports = { resolveImsToken }
