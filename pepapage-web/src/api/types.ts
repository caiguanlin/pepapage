export interface UserInfo {
  id: string
  email: string
  nickname: string
}

export interface LoginResponse {
  token: string
  user: UserInfo
}

export interface BookFolder {
  id: string
  parentId: string | null
  name: string
  createdAt: string
  updatedAt: string
}

export type AudioMode = 'single' | 'multi' | 'tts'
export type ProjectStatus = 'uploading' | 'processing' | 'completed' | 'failed'
export type StepStatus = 'pending' | 'running' | 'completed' | 'skipped' | 'failed'

export interface ProcessingStep {
  key: 'ocr' | 'audio_conversion' | 'transcription' | 'alignment'
  status: StepStatus
  progress: number
}

export interface BookProject {
  id: string
  folderId: string | null
  title: string
  audioMode: AudioMode
  sourceType: string
  sourceFileKey?: string
  coverKey?: string
  audioFileKey?: string
  audioFiles?: { fileKey: string; originalName: string }[]
  ttsVoice?: string
  ttsSpeed?: number
  status: ProjectStatus
  processingSteps: ProcessingStep[]
  currentStepIndex: number
  processingError?: string
  ocrConfirmed: boolean
  pageCount?: number
  durationSeconds?: number
  metadata?: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface UploadPolicy {
  host: string
  key: string
  policy: string
  signature: string
  accessKeyId: string
  expireAt: number
}
