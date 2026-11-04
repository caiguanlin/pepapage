import { api, ApiError } from './client'
import type { AudioLibraryItem, AudioLibraryManifest, BookAnalysis, BookExport, ProjectFileInfo, ReaderData } from './editorTypes'
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
}

/** 编辑器音频库（docs/team-contract.md 5.4）：上传额外音源并单独识别，不参与原书对齐。 */
export const audioLibraryApi = {
  /** kind=library_audio 上传策略：不需要 boxKey，单文件上限 200 MiB，key 为 custom-audio-lib-* */
  policy: (id: string, fileName: string) =>
    api<UploadPolicy>(`/book-projects/${id}/upload-policy`, { method: 'POST', body: { kind: 'library_audio', fileName } }),
  /** 清单 book-audio-library.json；不存在时服务端返回空 items */
  list: (id: string) => api<AudioLibraryManifest>(`/book-projects/${id}/audio-library`),
  /** 加入清单并开始识别；已在清单时 queued/running 原样返回，其他状态重置为 queued（失败重试 / 旧文件补识别） */
  add: (id: string, fileName: string, originalName: string) =>
    api<AudioLibraryItem>(`/book-projects/${id}/audio-library`, { method: 'POST', body: { fileName, originalName } }),
  /** 移除清单项并删除音频与 asr.json，同时清掉 book-custom-audio.json 里的所有引用绑定 */
  remove: (id: string, fileName: string) =>
    api<{ removedBoxKeys: string[] }>(`/book-projects/${id}/audio-library?fileName=${enc(fileName)}`, { method: 'DELETE' }),
}

export const bookActionApi = {
  confirmOcr: (id: string, sentenceCount?: number) =>
    api<BookProject>(`/book-projects/${id}/confirm-ocr`, { method: 'POST', body: { sentenceCount } }),
  realign: (id: string) => api<BookProject>(`/book-projects/${id}/realign`, { method: 'POST' }),
  createExport: (id: string, type: 'oid_zip' | 'pdf') =>
    api<{ exportId: string }>(`/book-projects/${id}/exports`, { method: 'POST', body: { type } }),
  getExport: (exportId: string) => api<BookExport>(`/book-exports/${exportId}`),
  reader: (id: string) => api<ReaderData>(`/book-projects/${id}/reader`),
  /** 解析详情与编辑器右栏共用，服务端合并后返回，见 docs/team-contract.md 第 2 节。 */
  analysis: (id: string) => api<BookAnalysis>(`/book-projects/${id}/analysis`),
}
