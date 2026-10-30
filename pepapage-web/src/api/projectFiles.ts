import { api, ApiError } from './client'
import type { BookExport, ProjectFileInfo, ReaderData } from './editorTypes'
import type { BookProject, UploadPolicy } from './types'

const enc = encodeURIComponent

/** 项目文件读写，接口见 docs/team-contract.md 第 2 节。 */
export const projectFilesApi = {
  list: (id: string) => api<ProjectFileInfo[]>(`/book-projects/${id}/files`),
  url: (id: string, name: string) => api<{ url: string }>(`/book-projects/${id}/files/url?name=${enc(name)}`),
  /** 不存在时返回 null（404 也视为不存在）。 */
  tryUrl: async (id: string, name: string): Promise<string | null> => {
    try {
      return (await projectFilesApi.url(id, name)).url
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null
      throw e
    }
  },
  readJson: <T>(id: string, name: string) => api<T | null>(`/book-projects/${id}/files/json?name=${enc(name)}`),
  writeJson: (id: string, name: string, body: unknown) =>
    api<void>(`/book-projects/${id}/files/json?name=${enc(name)}`, { method: 'PUT', body }),
  remove: (id: string, name: string) => api<void>(`/book-projects/${id}/files?name=${enc(name)}`, { method: 'DELETE' }),
  customAudioPolicy: (id: string, fileName: string, boxKey: string) =>
    api<UploadPolicy>(`/book-projects/${id}/upload-policy`, {
      method: 'POST',
      body: { kind: 'custom_audio', fileName, boxKey },
    }),
}

export const bookActionApi = {
  confirmOcr: (id: string, sentenceCount?: number) =>
    api<BookProject>(`/book-projects/${id}/confirm-ocr`, { method: 'POST', body: { sentenceCount } }),
  realign: (id: string) => api<BookProject>(`/book-projects/${id}/realign`, { method: 'POST' }),
  createExport: (id: string, type: 'oid_zip' | 'pdf') =>
    api<{ exportId: string }>(`/book-projects/${id}/exports`, { method: 'POST', body: { type } }),
  getExport: (exportId: string) => api<BookExport>(`/book-exports/${exportId}`),
  reader: (id: string) => api<ReaderData>(`/book-projects/${id}/reader`),
}
