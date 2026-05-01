'use strict'

const { submitGenerationJob, pollUntilComplete } = require('../../lib/firefly-v3')

// ---------------------------------------------------------------------------
// Mock FireflyClient
// ---------------------------------------------------------------------------

const mockGenerateImagesAsync = jest.fn()
const mockGetJobStatus = jest.fn()

const mockClient = {
  generateImagesAsync: mockGenerateImagesAsync,
  getJobStatus: mockGetJobStatus
}

// Suppress sleep delays during tests
jest.mock('../../lib/firefly-v3', () => {
  const original = jest.requireActual('../../lib/firefly-v3')
  return {
    ...original,
    // Override to speed up tests — inject mock client directly via exported fns
  }
})

afterEach(() => {
  jest.clearAllMocks()
})

describe('submitGenerationJob', () => {
  it('submits job and returns jobId + statusUrl', async () => {
    mockGenerateImagesAsync.mockResolvedValue({
      jobId: 'job-abc123',
      statusUrl: 'https://firefly-api.adobe.io/v3/status/job-abc123'
    })

    const result = await submitGenerationJob(mockClient, {
      prompt: 'Professional product photo on white background',
      brandStyleReferenceUrl: 'https://cdn.brand.com/hero.jpg',
      numVariations: 2
    })

    expect(result.jobId).toBe('job-abc123')
    expect(mockGenerateImagesAsync).toHaveBeenCalledTimes(1)

    const callArg = mockGenerateImagesAsync.mock.calls[0][0]
    expect(callArg.numVariations).toBe(2)
    expect(callArg.style.imageReference.source.url).toBe(
      'https://cdn.brand.com/hero.jpg'
    )
    expect(callArg.style.strength).toBe(60)
  })

  it('throws if prompt is missing', async () => {
    await expect(
      submitGenerationJob(mockClient, {
        brandStyleReferenceUrl: 'https://cdn.brand.com/hero.jpg'
      })
    ).rejects.toThrow(/prompt is required/)
  })

  it('throws if brandStyleReferenceUrl is missing', async () => {
    await expect(
      submitGenerationJob(mockClient, { prompt: 'test' })
    ).rejects.toThrow(/brandStyleReferenceUrl is required/)
  })

  it('throws if Firefly returns no jobId', async () => {
    mockGenerateImagesAsync.mockResolvedValue({})
    await expect(
      submitGenerationJob(mockClient, {
        prompt: 'test',
        brandStyleReferenceUrl: 'https://cdn.brand.com/hero.jpg'
      })
    ).rejects.toThrow(/did not return a jobId/)
  })
})

describe('pollUntilComplete', () => {
  it('returns outputs when job succeeds on first poll', async () => {
    const outputs = [{ seed: 1, image: { url: 'https://firefly.output/1.jpg' } }]
    mockGetJobStatus.mockResolvedValue({ status: 'succeeded', outputs })

    const result = await pollUntilComplete(mockClient, 'job-abc123', {
      intervalMs: 10,
      maxAttempts: 5
    })

    expect(result).toEqual(outputs)
    expect(mockGetJobStatus).toHaveBeenCalledTimes(1)
  })

  it('retries while job is running and resolves on success', async () => {
    const outputs = [{ seed: 2, image: { url: 'https://firefly.output/2.jpg' } }]
    mockGetJobStatus
      .mockResolvedValueOnce({ status: 'running' })
      .mockResolvedValueOnce({ status: 'running' })
      .mockResolvedValueOnce({ status: 'succeeded', outputs })

    // Patch sleep to be instant
    jest.spyOn(global, 'setTimeout').mockImplementation((fn) => fn())

    const result = await pollUntilComplete(mockClient, 'job-xyz', {
      intervalMs: 1,
      maxAttempts: 10
    })

    expect(result).toEqual(outputs)
    expect(mockGetJobStatus).toHaveBeenCalledTimes(3)

    jest.restoreAllMocks()
  })

  it('throws when job fails', async () => {
    mockGetJobStatus.mockResolvedValue({
      status: 'failed',
      error: { message: 'Content policy violation' }
    })

    await expect(
      pollUntilComplete(mockClient, 'job-fail', { intervalMs: 1, maxAttempts: 3 })
    ).rejects.toThrow(/Content policy violation/)
  })

  it('throws when max attempts exceeded', async () => {
    mockGetJobStatus.mockResolvedValue({ status: 'running' })
    jest.spyOn(global, 'setTimeout').mockImplementation((fn) => fn())

    await expect(
      pollUntilComplete(mockClient, 'job-timeout', { intervalMs: 1, maxAttempts: 3 })
    ).rejects.toThrow(/did not complete within 3 attempts/)

    jest.restoreAllMocks()
  })
})
