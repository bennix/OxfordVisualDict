export const DEFAULT_BASE_URL = 'https://zenmux.ai/api/v1'
export const INVITE_URL = 'https://zenmux.ai/invite/GBQMC5'

export const DEFAULT_CHAT_MODELS = [
  'anthropic/claude-haiku-5.5',
  'openai/gpt-6.1-sol',
  'x-ai/grok-4.7'
]

export const DEFAULT_EMBEDDING_MODELS = [
  'google/gemini-embedding-2',
  'qwen/qwen3-vl-embedding',
  'openai/text-embedding-3-large'
]

export type AttachmentKind = 'image' | 'text' | 'file'

export type Attachment = {
  id: string
  name: string
  mime: string
  kind: AttachmentKind
  dataUrl?: string
  text?: string
}

export type SpeechClipFile = {
  line: string
  path: string
  src?: string
}

export type MessageSpeech = {
  engine: string
  clips: SpeechClipFile[]
}

export type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  attachments: Attachment[]
  speech?: MessageSpeech
}

export type Conversation = {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  entryId?: string
  messages: ChatMessage[]
}

export type ConversationSummary = {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messageCount: number
  preview: string
  hasSpeech: boolean
}

export type PointReadInput = {
  entryId: string
  word: string
  topic?: string
  engine: string
  audioBase64: string
}

export type SpeechDownload = {
  conversationId?: string
  title?: string
  clips?: { line: string; audioBase64: string }[]
}

export type Entry = {
  id: string
  word: string
  number?: number
  topic: string
  topicId: string
  subtopic?: string
  pdfPage: number
  bookPage?: number
  y: number
}

export type Topic = {
  id: string
  title: string
  pdfPage: number
  bookPage?: number
  entryCount: number
}

export type OcrWord = {
  text: string
  conf: number
  x: number
  y: number
  w: number
  h: number
}

export type PagePayload = {
  pdfPage: number
  width: number
  height: number
  kind: 'topic' | 'index' | 'toc' | 'other'
  title?: string
  bookPage?: number
  words: OcrWord[]
  entries: Entry[]
}

export type IndexStatus = {
  pdfReady: boolean
  pdfPath: string
  pageCount: number
  indexedPages: number
  entryCount: number
  topicCount: number
  building: boolean
  error?: string
  tools: { tesseract: string | null; pdftoppm: string | null; pdfinfo: string | null }
}

export type EmbedStatus = {
  model: string
  ready: boolean
  vectors: number
  building: boolean
  error?: string
  progress: number
  total: number
}

export type TtsStatus = {
  engine: 'cosyvoice' | 'system'
  version: 'cosyvoice2' | 'cosyvoice3'
  serverUrl: string
  running: boolean
  detail: string
  python: string
  repo: string
  modelDir: string
  weightsDir: string
  bundledReady: boolean
}

export type KeyCheck = {
  ok: boolean
  message: string
}

export type PublicSettings = {
  hasApiKey: boolean
  apiKeyMask: string
  baseUrl: string
  chatModel: string
  chatModels: string[]
  embeddingModel: string
  embeddingModels: string[]
  cosyvoicePython: string
  cosyvoiceRepo: string
  cosyvoiceModelDir: string
  cosyvoiceVersion: 'cosyvoice2' | 'cosyvoice3'
  cosyvoiceServerUrl: string
}

export type NextChar = {
  label: string
  append: string
  count: number
}

export type SuggestResult = {
  next: NextChar[]
  exact: number
  hits: SearchHit[]
  note?: string
}

export type SearchHit = {
  entryId?: string
  topicId?: string
  word: string
  topic: string
  subtopic?: string
  pdfPage: number
  bookPage?: number
  number?: number
  score: number
  why: string
}

export type AiStartRequest = {
  conversationId?: string
  entryId?: string
  prompt: string
  attachments: Attachment[]
  purpose: 'explain' | 'followup'
}

export type AiEvent =
  | { type: 'delta'; requestId: string; text: string }
  | { type: 'done'; requestId: string; conversationId: string }
  | { type: 'error'; requestId: string; message: string }

export type IndexEvent =
  | { type: 'progress'; page: number; total: number; label: string }
  | { type: 'done'; entryCount: number; topicCount: number }
  | { type: 'error'; message: string }

export type EmbedEvent =
  | { type: 'progress'; done: number; total: number }
  | { type: 'done'; vectors: number }
  | { type: 'error'; message: string }

export type WeightEvent =
  | { type: 'progress'; label: string; done: number; total: number }
  | { type: 'done' }
  | { type: 'error'; message: string }

export type DictApi = {
  getStatus: () => Promise<IndexStatus>
  buildIndex: (force?: boolean) => Promise<void>
  onIndex: (cb: (event: IndexEvent) => void) => () => void
  readPdf: () => Promise<Uint8Array>
  getTopics: () => Promise<Topic[]>
  getEntriesByLetter: (letter: string) => Promise<Entry[]>
  getPage: (pdfPage: number) => Promise<PagePayload | null>
  search: (query: string, image?: Attachment | null) => Promise<{ hits: SearchHit[]; note: string }>
  suggest: (prefix: string) => Promise<SuggestResult>
  getSettings: () => Promise<PublicSettings>
  setApiKey: (apiKey: string) => Promise<PublicSettings>
  verifyApiKey: (candidate?: string) => Promise<KeyCheck>
  updateSettings: (patch: Partial<PublicSettings>) => Promise<PublicSettings>
  getEmbedStatus: () => Promise<EmbedStatus>
  buildEmbeddings: () => Promise<void>
  onEmbed: (cb: (event: EmbedEvent) => void) => () => void
  getTtsStatus: () => Promise<TtsStatus>
  startTts: () => Promise<TtsStatus>
  stopTts: () => Promise<TtsStatus>
  speak: (text: string) => Promise<{ engine: string; audioBase64: string; mime: string }>
  startChat: (req: AiStartRequest) => Promise<{ requestId: string; conversationId: string }>
  cancelChat: (requestId: string) => Promise<void>
  onAi: (cb: (event: AiEvent) => void) => () => void
  listHistory: () => Promise<ConversationSummary[]>
  getHistory: (id: string) => Promise<Conversation | null>
  deleteHistory: (ids: string[]) => Promise<void>
  saveSpeech: (
    conversationId: string,
    engine: string,
    clips: { line: string; audioBase64: string }[]
  ) => Promise<Conversation | null>
  savePointRead: (input: PointReadInput) => Promise<Conversation>
  getPointRead: (entryId: string) => Promise<Conversation | null>
  downloadSpeech: (input: SpeechDownload) => Promise<string>
  revealVoiceDir: () => Promise<string>
  importPdf: () => Promise<string>
  downloadWeights: () => Promise<TtsStatus>
  onWeights: (cb: (event: WeightEvent) => void) => () => void
  exportHistory: (ids: string[], format: 'md' | 'json') => Promise<string>
  openExternal: (url: string) => Promise<void>
}
