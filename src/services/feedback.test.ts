import type { EmojiAlbum } from '../types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  postMock: vi.fn(),
  getClientMock: vi.fn()
}))

vi.mock('@tauri-apps/api/http', () => ({
  Body: {
    json: (value: unknown) => ({ type: 'Json', value })
  },
  ResponseType: {
    JSON: 1
  },
  getClient: mocks.getClientMock
}))

import {
  buildGitHubMissingAlbumIssueUrl,
  buildMissingAlbumFeedbackPayload,
  isValidFeedbackContactEmail,
  submitMissingAlbumEmailFeedback
} from './feedback'

const productId = 'com.tencent.xin.emoticon.person.feedback_album'
const album: EmojiAlbum = {
  id: productId,
  packageId: productId,
  name: '缺失专辑',
  count: 3,
  urls: [],
  members: [
    { sortOrder: 2, md5: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' },
    { sortOrder: 1, md5: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
    { sortOrder: 3, md5: 'not-an-md5' }
  ]
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getClientMock.mockResolvedValue({ post: mocks.postMock })
})

describe('missing album feedback', () => {
  it('builds a normalized, ordered payload and drops invalid member identifiers', () => {
    expect(buildMissingAlbumFeedbackPayload(album)).toMatchObject({
      schemaVersion: 1,
      productId,
      albumName: '缺失专辑',
      expectedMemberCount: 3,
      members: [
        { memberIndex: 1, md5: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        { memberIndex: 2, md5: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }
      ]
    })
  })

  it('creates a prefilled GitHub issue URL without submitting the issue', () => {
    const url = new URL(
      buildGitHubMissingAlbumIssueUrl(buildMissingAlbumFeedbackPayload(album))
    )

    expect(url.pathname).toBe('/liusheng22/export-wechat-emoji/issues/new')
    expect(url.searchParams.get('template')).toBe('missing-album.md')
    expect(url.searchParams.get('labels')).toBe('missing-album')
    expect(url.searchParams.get('title')).toBe('[缺失专辑] 缺失专辑')
    expect(url.searchParams.get('body')).toContain(productId)
    expect(url.searchParams.get('body')).toContain(
      '1. aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    )
    expect(url.searchParams.get('body')).toContain(
      'https://stickerhub.lius.me/'
    )
  })

  it('keeps an optional contact email out of the GitHub issue body', () => {
    const payload = buildMissingAlbumFeedbackPayload(
      album,
      ' user@example.com '
    )
    const url = new URL(buildGitHubMissingAlbumIssueUrl(payload))

    expect(payload.contactEmail).toBe('user@example.com')
    expect(url.searchParams.get('body')).not.toContain('user@example.com')
    expect(isValidFeedbackContactEmail('user@example.com')).toBe(true)
    expect(isValidFeedbackContactEmail('not-an-email')).toBe(false)
  })

  it('sends the payload to the feedback endpoint and accepts the response', async () => {
    mocks.postMock.mockResolvedValue({
      ok: true,
      data: { schemaVersion: 1, status: 'accepted' }
    })
    const payload = buildMissingAlbumFeedbackPayload(album)

    await expect(submitMissingAlbumEmailFeedback(payload)).resolves.toEqual({
      schemaVersion: 1,
      status: 'accepted'
    })

    expect(mocks.getClientMock).toHaveBeenCalledTimes(1)
    expect(mocks.postMock).toHaveBeenCalledWith(
      'https://stickerhub.lius.me/api/integrations/wxemoticon/missing-albums',
      expect.objectContaining({ type: 'Json', value: payload }),
      { responseType: 1, timeout: 15_000 }
    )
  })

  it('rejects non-accepted responses so the UI can offer GitHub instead', async () => {
    mocks.postMock.mockResolvedValue({
      ok: false,
      data: { schemaVersion: 1, status: 'accepted' }
    })

    await expect(
      submitMissingAlbumEmailFeedback(buildMissingAlbumFeedbackPayload(album))
    ).rejects.toThrow('feedback email was not accepted')
  })
})
