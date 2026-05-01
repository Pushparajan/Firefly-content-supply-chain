'use strict'

const nock = require('nock')
const { initiateUpload, uploadBinaryToCloud, completeUpload, fetchRemoteAsset } =
  require('../../lib/aem-cloud')

const AEM_HOST = 'https://author-p12345-e67890.adobeaemcloud.com'
const TOKEN = 'Bearer test-ims-token'
const FOLDER = '/content/dam/generated-assets'

afterEach(() => {
  nock.cleanAll()
})

describe('initiateUpload', () => {
  it('posts to initiateUpload endpoint and returns upload info', async () => {
    nock(AEM_HOST)
      .post(`${FOLDER}.initiateUpload.json`)
      .reply(200, {
        completeURI: '/content/dam/generated-assets.completeUpload.json',
        files: [
          {
            uploadToken: 'token-abc',
            uploadURIs: ['https://storageaccount.blob.core.windows.net/container/file?sas'],
            mimeType: 'image/jpeg'
          }
        ]
      })

    const result = await initiateUpload({
      aemHost: AEM_HOST,
      imsToken: TOKEN,
      folderPath: FOLDER,
      files: [{ fileName: 'test.jpg', fileSize: 1024, mimeType: 'image/jpeg' }]
    })

    expect(result.completeURI).toBeTruthy()
    expect(result.files).toHaveLength(1)
    expect(result.files[0].uploadToken).toBe('token-abc')
  })

  it('throws on AEM 403', async () => {
    nock(AEM_HOST)
      .post(`${FOLDER}.initiateUpload.json`)
      .reply(403, 'Forbidden')

    await expect(
      initiateUpload({
        aemHost: AEM_HOST,
        imsToken: TOKEN,
        folderPath: FOLDER,
        files: [{ fileName: 'test.jpg', fileSize: 100, mimeType: 'image/jpeg' }]
      })
    ).rejects.toThrow(/initiateUpload failed \[403\]/)
  })
})

describe('uploadBinaryToCloud', () => {
  it('PUTs binary to cloud storage URI', async () => {
    const blobHost = 'https://storageaccount.blob.core.windows.net'
    const blobPath = '/container/file.jpg?sas=token'

    nock(blobHost)
      .put(blobPath)
      .reply(201)

    const buffer = Buffer.from('fake-image-data')
    await expect(
      uploadBinaryToCloud({
        uploadURI: `${blobHost}${blobPath}`,
        buffer,
        mimeType: 'image/jpeg'
      })
    ).resolves.toBeUndefined()
  })

  it('throws on cloud storage error', async () => {
    const blobHost = 'https://storageaccount.blob.core.windows.net'

    nock(blobHost)
      .put('/container/fail.jpg')
      .reply(500, 'Internal Server Error')

    await expect(
      uploadBinaryToCloud({
        uploadURI: `${blobHost}/container/fail.jpg`,
        buffer: Buffer.from('data'),
        mimeType: 'image/jpeg'
      })
    ).rejects.toThrow(/PUT failed \[500\]/)
  })
})

describe('completeUpload', () => {
  it('posts to completeURI to finalize asset creation', async () => {
    const completeURI = '/content/dam/generated-assets.completeUpload.json'

    nock(AEM_HOST)
      .post(completeURI)
      .reply(200, {
        path: '/content/dam/generated-assets/hero-v1.jpg',
        name: 'hero-v1.jpg'
      })

    const result = await completeUpload({
      aemHost: AEM_HOST,
      imsToken: TOKEN,
      completeURI,
      uploadToken: 'token-abc',
      fileName: 'hero-v1.jpg',
      mimeType: 'image/jpeg'
    })

    expect(result.path).toBe('/content/dam/generated-assets/hero-v1.jpg')
  })
})

describe('fetchRemoteAsset', () => {
  it('downloads a remote asset and returns buffer + metadata', async () => {
    const assetHost = 'https://firefly-output.adobe.io'

    nock(assetHost)
      .get('/output/abc.jpg')
      .reply(200, Buffer.from('image-bytes'), {
        'Content-Type': 'image/jpeg'
      })

    const result = await fetchRemoteAsset(`${assetHost}/output/abc.jpg`)

    expect(result.buffer).toBeInstanceOf(Buffer)
    expect(result.contentType).toBe('image/jpeg')
    expect(result.contentLength).toBeGreaterThan(0)
  })

  it('throws on non-200 response', async () => {
    const assetHost = 'https://firefly-output.adobe.io'

    nock(assetHost)
      .get('/output/missing.jpg')
      .reply(404)

    await expect(
      fetchRemoteAsset(`${assetHost}/output/missing.jpg`)
    ).rejects.toThrow(/Failed to fetch remote asset \[404\]/)
  })
})
