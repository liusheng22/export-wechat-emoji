import type { EmojiAlbum } from '../types'
import { Body, getClient, ResponseType } from '@tauri-apps/api/http'
import {
  APP_VERSION,
  GITHUB_REPOSITORY_URL,
  STICKERHUB_FEEDBACK_URL,
  STICKERHUB_URL
} from '../consts/app'

export interface MissingAlbumFeedbackMember {
  memberIndex: number
  md5: string
}

export interface MissingAlbumFeedbackPayload {
  schemaVersion: 1
  productId: string
  albumName: string
  expectedMemberCount: number
  members: MissingAlbumFeedbackMember[]
  clientVersion: string
  contactEmail?: string
}

export interface MissingAlbumFeedbackResponse {
  schemaVersion: 1
  status: 'accepted'
}

export function buildMissingAlbumFeedbackPayload(
  album: EmojiAlbum,
  contactEmail?: string
): MissingAlbumFeedbackPayload {
  const members = (album.members || [])
    .map((member) => ({
      memberIndex: member.sortOrder,
      md5: member.md5.trim().toLowerCase()
    }))
    .filter((member) => /^[a-f0-9]{32}$/.test(member.md5))
    .sort((left, right) => left.memberIndex - right.memberIndex)

  const normalizedContactEmail = contactEmail?.trim()
  return {
    schemaVersion: 1,
    productId: album.packageId || album.id,
    albumName: album.name,
    expectedMemberCount: album.count,
    members,
    clientVersion: APP_VERSION,
    ...(normalizedContactEmail ? { contactEmail: normalizedContactEmail } : {})
  }
}

export function isValidFeedbackContactEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
}

function formatGitHubBody(payload: MissingAlbumFeedbackPayload): string {
  const members = payload.members.length
    ? payload.members
        .map((member) => `${member.memberIndex}. ${member.md5}`)
        .join('\n')
    : '未解析到成员 MD5。'

  return [
    '## 缺失专辑信息',
    '',
    `- 专辑名称：${payload.albumName}`,
    `- productId：\`${payload.productId}\``,
    `- 成员数量：${payload.expectedMemberCount}`,
    `- 客户端版本：${payload.clientVersion}`,
    '',
    '## 成员 MD5',
    '',
    '```text',
    members,
    '```',
    '',
    '该专辑在客户端本地可见，但 StickerHub API 暂未收录。',
    '',
    `专辑表情包由 StickerHub API 提供支持：${STICKERHUB_URL}`
  ].join('\n')
}

export function buildGitHubMissingAlbumIssueUrl(
  payload: MissingAlbumFeedbackPayload
): string {
  const url = new URL(`${GITHUB_REPOSITORY_URL}/issues/new`)
  url.searchParams.set('template', 'missing-album.md')
  url.searchParams.set('title', `[缺失专辑] ${payload.albumName}`)
  url.searchParams.set('labels', 'missing-album')
  url.searchParams.set('body', formatGitHubBody(payload))
  return url.toString()
}

export async function submitMissingAlbumEmailFeedback(
  payload: MissingAlbumFeedbackPayload
): Promise<MissingAlbumFeedbackResponse> {
  const client = await getClient()
  const response = await client.post<MissingAlbumFeedbackResponse>(
    STICKERHUB_FEEDBACK_URL,
    Body.json(payload),
    {
      responseType: ResponseType.JSON,
      timeout: 15_000
    }
  )

  if (!response.ok || response.data?.status !== 'accepted') {
    throw new Error('feedback email was not accepted')
  }

  return response.data
}
