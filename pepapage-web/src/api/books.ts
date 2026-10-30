import { api } from './client'
import type { AudioMode, BookFolder, BookProject, UploadPolicy } from './types'

export const folderApi = {
  list: () => api<BookFolder[]>('/book-folders'),
  create: (name: string, parentId: string | null) =>
    api<BookFolder>('/book-folders', { method: 'POST', body: { name, parentId } }),
  rename: (id: string, name: string) => api<BookFolder>(`/book-folders/${id}/name`, { method: 'PUT', body: { name } }),
  move: (id: string, parentId: string | null) =>
    api<void>(`/book-folders/${id}/parent`, { method: 'PUT', body: { parentId } }),
  remove: (id: string) => api<void>(`/book-folders/${id}`, { method: 'DELETE' }),
}

export interface ListProjectParams {
  folderId?: string | null
  keyword?: string
  sort: 'createdAt' | 'title'
  order: 'asc' | 'desc'
}

export const projectApi = {
  list: (p: ListProjectParams) => {
    const q = new URLSearchParams({ sort: p.sort, order: p.order })
    if (p.keyword) q.set('keyword', p.keyword)
    else if (p.folderId) q.set('folderId', p.folderId)
    return api<BookProject[]>(`/book-projects?${q}`)
  },
  get: (id: string) => api<BookProject>(`/book-projects/${id}`),
  create: (body: {
    title?: string
    sourceFileName: string
    folderId: string | null
    audioMode: AudioMode
    ttsVoice?: string
    ttsSpeed?: number
  }) => api<BookProject>('/book-projects', { method: 'POST', body }),
  uploadPolicy: (id: string, kind: 'source' | 'audio' | 'multi_audio', fileName: string) =>
    api<UploadPolicy>(`/book-projects/${id}/upload-policy`, { method: 'POST', body: { kind, fileName } }),
  submit: (
    id: string,
    body: { sourceFileKey: string; audioFileKey?: string; audioFiles?: { fileKey: string; originalName: string }[] },
  ) => api<BookProject>(`/book-projects/${id}/submit`, { method: 'POST', body }),
  retry: (id: string) => api<BookProject>(`/book-projects/${id}/retry`, { method: 'POST' }),
  rename: (id: string, title: string) => api<BookProject>(`/book-projects/${id}/title`, { method: 'PUT', body: { title } }),
  move: (ids: string[], folderId: string | null) =>
    api<void>('/book-projects/move', { method: 'POST', body: { ids, folderId } }),
  batchDelete: (ids: string[]) => api<void>('/book-projects/batch-delete', { method: 'POST', body: { ids } }),
}

export const storageApi = {
  signedUrl: (key: string) => api<{ url: string }>(`/storage/signed-url?key=${encodeURIComponent(key)}`),
}

/** 使用后端签发的 PostPolicy 直传 OSS，带上传进度回调。 */
export function uploadToOss(policy: UploadPolicy, file: Blob, onProgress?: (ratio: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const form = new FormData()
    form.append('key', policy.key)
    form.append('policy', policy.policy)
    form.append('OSSAccessKeyId', policy.accessKeyId)
    form.append('Signature', policy.signature)
    form.append('success_action_status', '200')
    form.append('file', file)

    const xhr = new XMLHttpRequest()
    xhr.open('POST', policy.host)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total)
    }
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`上传失败（${xhr.status}）`)))
    xhr.onerror = () => reject(new Error('上传失败，请检查网络或 OSS 跨域设置'))
    xhr.send(form)
  })
}
