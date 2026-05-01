'use strict'

const crypto = require('crypto')
const {
  verifyWebhookSignature,
  parseWebhookPayload
} = require('../../lib/workfront')

const SECRET = 'test-secret-abc'

function sign (body) {
  return crypto.createHmac('sha256', SECRET).update(body, 'utf8').digest('hex')
}

describe('verifyWebhookSignature', () => {
  it('accepts a valid HMAC-SHA256 signature', () => {
    const body = JSON.stringify({ objID: '123', objCode: 'DOCU' })
    expect(() => verifyWebhookSignature(body, sign(body), SECRET)).not.toThrow()
  })

  it('rejects a tampered body', () => {
    const body = JSON.stringify({ objID: '123', objCode: 'DOCU' })
    const sig = sign(body)
    expect(() => verifyWebhookSignature(body + 'x', sig, SECRET)).toThrow(
      /signature verification failed/i
    )
  })

  it('rejects a missing signature header', () => {
    expect(() => verifyWebhookSignature('body', '', SECRET)).toThrow(
      /missing/i
    )
  })
})

describe('parseWebhookPayload', () => {
  it('extracts objID and objCode', () => {
    const payload = { eventType: 'UPDATE', objCode: 'DOCU', objID: 'abc123' }
    const result = parseWebhookPayload(payload)
    expect(result.objID).toBe('abc123')
    expect(result.objCode).toBe('DOCU')
    expect(result.eventType).toBe('UPDATE')
  })

  it('throws if objID is missing', () => {
    expect(() => parseWebhookPayload({ objCode: 'DOCU' })).toThrow(/objID/)
  })

  it('throws if objCode is missing', () => {
    expect(() => parseWebhookPayload({ objID: 'abc123' })).toThrow(/objCode/)
  })

  it('throws on null payload', () => {
    expect(() => parseWebhookPayload(null)).toThrow()
  })
})
