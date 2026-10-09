import { safeStorage } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_BASE_URL,
  DEFAULT_CHAT_MODELS,
  DEFAULT_EMBEDDING_MODELS,
  type Attachment,
  type ChatMessage,
  type Conversation,
  type ConversationSummary,
  type MessageSpeech,
  type PointReadInput,
  type PublicSettings,
  type SpeechDownload
} from '../shared/types'
import { attachmentDir, ensureDir, userRoot } from './paths'

type PersistedSettings = {
  apiKeyEnc?: string
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
  speechEngine: 'cosyvoice' | 'edge'
}

function settingsPath(): string {
  return path.join(ensureDir(userRoot()), 'settings.json')
}

function historyPath(): string {
  return path.join(ensureDir(userRoot()), 'history.json')
}

function defaults(): PersistedSettings {
  return {
    apiKeyMask: '',
    baseUrl: DEFAULT_BASE_URL,
    chatModel: DEFAULT_CHAT_MODELS[0],
    chatModels: [...DEFAULT_CHAT_MODELS],
    embeddingModel: DEFAULT_EMBEDDING_MODELS[0],
    embeddingModels: [...DEFAULT_EMBEDDING_MODELS],
    cosyvoicePython: '',
    cosyvoiceRepo: '',
    cosyvoiceModelDir: '',
    cosyvoiceVersion: 'cosyvoice3',
    cosyvoiceServerUrl: 'http://127.0.0.1:8765',
    speechEngine: 'cosyvoice'
  }
}

function readSettings(): PersistedSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) as PersistedSettings
    return { ...defaults(), ...raw, chatModels: raw.chatModels?.length ? raw.chatModels : defaults().chatModels, embeddingModels: raw.embeddingModels?.length ? raw.embeddingModels : defaults().embeddingModels }
  } catch {
    return defaults()
  }
}

function writeSettings(settings: PersistedSettings): void {
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2))
}

export function toPublic(settings: PersistedSettings): PublicSettings {
  return {
    hasApiKey: Boolean(settings.apiKeyEnc),
    apiKeyMask: settings.apiKeyMask,
    baseUrl: settings.baseUrl,
    chatModel: settings.chatModel,
    chatModels: settings.chatModels,
    embeddingModel: settings.embeddingModel,
    embeddingModels: settings.embeddingModels,
    cosyvoicePython: settings.cosyvoicePython,
    cosyvoiceRepo: settings.cosyvoiceRepo,
    cosyvoiceModelDir: settings.cosyvoiceModelDir,
    cosyvoiceVersion: settings.cosyvoiceVersion,
    cosyvoiceServerUrl: settings.cosyvoiceServerUrl,
    speechEngine: settings.speechEngine === 'edge' ? 'edge' : 'cosyvoice'
  }
}

export function getPublicSettings(): PublicSettings {
  return toPublic(readSettings())
}

export function getApiKey(): string {
  const settings = readSettings()
  if (!settings.apiKeyEnc) return ''
  const buf = Buffer.from(settings.apiKeyEnc, 'base64')
  try {
    if (safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(buf)
  } catch {
    return ''
  }
  return buf.toString('utf8')
}

export function setApiKey(apiKey: string): PublicSettings {
  const settings = readSettings()
  const trimmed = apiKey.trim()
  if (!trimmed) {
    delete settings.apiKeyEnc
    settings.apiKeyMask = ''
    writeSettings(settings)
    return toPublic(settings)
  }
  const encrypted = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(trimmed)
    : Buffer.from(trimmed, 'utf8')
  settings.apiKeyEnc = encrypted.toString('base64')
  settings.apiKeyMask = `••••••••${trimmed.slice(-4)}`
  writeSettings(settings)
  return toPublic(settings)
}

export async function verifyApiKey(candidate?: string): Promise<{ ok: boolean; message: string }> {
  const settings = readSettings()
  const typed = candidate?.trim() || ''
  const apiKey = typed || getApiKey()
  if (!apiKey) {
    if (!typed && settings.apiKeyEnc) return { ok: false, message: '密钥已保存在本机，但无法解密。请重新填写并保存。' }
    return { ok: false, message: '还没有可测试的密钥' }
  }
  const base = (settings.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '')
  try {
    const response = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    })
    if (response.ok) return { ok: true, message: '密钥有效，ZenMux 已接受' }
    const text = await response.text()
    let detail = text.slice(0, 180)
    try {
      const body = JSON.parse(text) as { error?: { message?: string }; message?: string }
      detail = body.error?.message || body.message || detail
    } catch {
      /* 保留原始响应片段 */
    }
    if (response.status === 401 || response.status === 403) return { ok: false, message: `密钥无效：${detail}` }
    return { ok: false, message: `验证失败（${response.status}）：${detail}` }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

function cleanList(list: string[] | undefined, fallback: string[]): string[] {
  const next = (list || [])
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item.length < 120)
  return [...new Set(next.length ? next : fallback)]
}

export function updateSettings(patch: Partial<PublicSettings>): PublicSettings {
  const settings = readSettings()
  if (typeof patch.baseUrl === 'string' && patch.baseUrl.trim()) settings.baseUrl = patch.baseUrl.trim()
  if (patch.chatModels) settings.chatModels = cleanList(patch.chatModels, DEFAULT_CHAT_MODELS)
  if (patch.embeddingModels) settings.embeddingModels = cleanList(patch.embeddingModels, DEFAULT_EMBEDDING_MODELS)
  if (typeof patch.chatModel === 'string' && patch.chatModel.trim()) {
    const model = patch.chatModel.trim()
    if (!settings.chatModels.includes(model)) settings.chatModels.push(model)
    settings.chatModel = model
  }
  if (typeof patch.embeddingModel === 'string' && patch.embeddingModel.trim()) {
    const model = patch.embeddingModel.trim()
    if (!settings.embeddingModels.includes(model)) settings.embeddingModels.push(model)
    settings.embeddingModel = model
  }
  if (!settings.chatModels.includes(settings.chatModel)) settings.chatModel = settings.chatModels[0]
  if (!settings.embeddingModels.includes(settings.embeddingModel)) settings.embeddingModel = settings.embeddingModels[0]
  if (typeof patch.cosyvoicePython === 'string') settings.cosyvoicePython = patch.cosyvoicePython.trim()
  if (typeof patch.cosyvoiceRepo === 'string') settings.cosyvoiceRepo = patch.cosyvoiceRepo.trim()
  if (typeof patch.cosyvoiceModelDir === 'string') settings.cosyvoiceModelDir = patch.cosyvoiceModelDir.trim()
  if (patch.cosyvoiceVersion === 'cosyvoice2' || patch.cosyvoiceVersion === 'cosyvoice3') {
    settings.cosyvoiceVersion = patch.cosyvoiceVersion
  }
  if (typeof patch.cosyvoiceServerUrl === 'string' && patch.cosyvoiceServerUrl.trim()) {
    settings.cosyvoiceServerUrl = patch.cosyvoiceServerUrl.trim()
  }
  if (patch.speechEngine === 'edge' || patch.speechEngine === 'cosyvoice') {
    settings.speechEngine = patch.speechEngine
  }
  writeSettings(settings)
  return toPublic(settings)
}

export function getRuntimeConfig(): PersistedSettings {
  return readSettings()
}

function readHistory(): Conversation[] {
  try {
    const raw = JSON.parse(fs.readFileSync(historyPath(), 'utf8')) as { conversations?: Conversation[] }
    return raw.conversations || []
  } catch {
    return []
  }
}

function writeHistory(conversations: Conversation[]): void {
  fs.writeFileSync(historyPath(), JSON.stringify({ conversations }, null, 2))
}

function hydrate(conversation: Conversation): Conversation {
  return {
    ...conversation,
    messages: conversation.messages.map((message) => ({
      ...message,
      attachments: (message.attachments || []).map((item) => hydrateAttachment(item)),
      speech: hydrateSpeech(message.speech)
    }))
  }
}

function hydrateSpeech(speech: MessageSpeech | undefined): MessageSpeech | undefined {
  if (!speech?.clips?.length) return undefined
  const clips = speech.clips
    .filter((clip) => clip.path && fs.existsSync(clip.path))
    .map((clip) => ({
      line: clip.line,
      path: clip.path,
      src: `data:audio/wav;base64,${fs.readFileSync(clip.path).toString('base64')}`
    }))
  return clips.length ? { engine: speech.engine, clips } : undefined
}

function persistSpeech(speech: MessageSpeech | undefined): MessageSpeech | undefined {
  if (!speech?.clips?.length) return undefined
  const clips = speech.clips
    .filter((clip) => clip.path && fs.existsSync(clip.path))
    .map(({ line, path }) => ({ line, path }))
  return clips.length ? { engine: speech.engine, clips } : undefined
}

function hydrateAttachment(item: Attachment & { path?: string }): Attachment {
  const stored = item as Attachment & { path?: string }
  if (stored.kind === 'image' && stored.path && fs.existsSync(stored.path)) {
    const buf = fs.readFileSync(stored.path)
    const mime = stored.mime || 'image/png'
    return { ...stored, dataUrl: `data:${mime};base64,${buf.toString('base64')}` }
  }
  if (stored.kind === 'text' && stored.path && fs.existsSync(stored.path) && !stored.text) {
    return { ...stored, text: fs.readFileSync(stored.path, 'utf8').slice(0, 20000) }
  }
  return stored
}

export function listHistory(): ConversationSummary[] {
  return readHistory()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((item) => ({
      id: item.id,
      title: item.title,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      messageCount: item.messages.length,
      preview: item.messages.find((m) => m.role === 'user')?.content.slice(0, 80) || '',
      hasSpeech: item.messages.some((message) => Boolean(message.speech?.clips?.length))
    }))
}

export function getHistory(id: string): Conversation | null {
  const found = readHistory().find((item) => item.id === id)
  return found ? hydrate(found) : null
}

export function saveConversation(conversation: Conversation): void {
  const all = readHistory()
  const stored: Conversation = {
    ...conversation,
    messages: conversation.messages.map((message) => persistMessage(message))
  }
  const idx = all.findIndex((item) => item.id === stored.id)
  if (idx >= 0) all[idx] = stored
  else all.push(stored)
  writeHistory(all)
}

function persistMessage(message: ChatMessage): ChatMessage {
  return {
    ...message,
    attachments: (message.attachments || []).map((item) => persistAttachment(item)),
    speech: persistSpeech(message.speech)
  }
}

function persistAttachment(item: Attachment & { path?: string }): Attachment & { path?: string } {
  if (item.path && fs.existsSync(item.path)) {
    const { dataUrl: _dataUrl, ...rest } = item
    return rest
  }
  if (item.kind === 'image' && item.dataUrl) {
    const match = item.dataUrl.match(/^data:([^;]+);base64,(.+)$/)
    if (!match) return item
    const file = path.join(attachmentDir(), `${item.id}-${safeName(item.name)}`)
    fs.writeFileSync(file, Buffer.from(match[2], 'base64'))
    return { id: item.id, name: item.name, mime: item.mime, kind: item.kind, path: file }
  }
  if ((item.kind === 'text' || item.kind === 'file') && item.text) {
    const file = path.join(attachmentDir(), `${item.id}-${safeName(item.name)}`)
    fs.writeFileSync(file, item.text)
    return { id: item.id, name: item.name, mime: item.mime, kind: item.kind, path: file, text: item.text.slice(0, 20000) }
  }
  const { dataUrl: _dataUrl, ...rest } = item
  return rest
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 60) || 'file'
}

export function deleteHistory(ids: string[]): void {
  const drop = new Set(ids)
  const all = readHistory()
    for (const item of all) {
    if (!drop.has(item.id)) continue
    for (const message of item.messages) {
      for (const attachment of message.attachments || []) {
        const file = (attachment as Attachment & { path?: string }).path
        if (file && fs.existsSync(file)) fs.rmSync(file, { force: true })
      }
    }
    fs.rmSync(path.join(userRoot(), 'speech', item.id), { recursive: true, force: true })
  }
  writeHistory(all.filter((item) => !drop.has(item.id)))
}

export function getPointRead(entryId: string): Conversation | null {
  const found = readHistory().find((item) => item.entryId === entryId && item.title.startsWith('点读 ·'))
  return found ? hydrate(found) : null
}

export function savePointRead(input: PointReadInput): Conversation {
  const all = readHistory()
  const now = new Date().toISOString()
  let conversation = all.find((item) => item.entryId === input.entryId && item.title.startsWith('点读 ·'))
  if (!conversation) {
    conversation = {
      id: crypto.randomUUID(),
      title: `点读 · ${input.word}`,
      createdAt: now,
      updatedAt: now,
      entryId: input.entryId,
      messages: []
    }
    all.push(conversation)
  }
  let message = conversation.messages.find((item) => item.role === 'assistant')
  if (!message) {
    message = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: input.word,
      createdAt: now,
      attachments: []
    }
    conversation.messages = [message]
  }
  message.content = input.word
  const dir = ensureDir(path.join(userRoot(), 'speech', conversation.id, message.id))
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.wav')) fs.rmSync(path.join(dir, name), { force: true })
  }
  const file = path.join(dir, '00.wav')
  fs.writeFileSync(file, Buffer.from(input.audioBase64, 'base64'))
  message.speech = { engine: input.engine, clips: [{ line: input.word, path: file }] }
  conversation.title = `点读 · ${input.word}`
  conversation.updatedAt = now
  writeHistory(all)
  return hydrate(conversation)
}

export function saveSpeech(
  conversationId: string,
  engine: string,
  clips: { line: string; audioBase64: string }[]
): Conversation | null {
  const all = readHistory()
  const conversation = all.find((item) => item.id === conversationId)
  if (!conversation) return null
  const message = [...conversation.messages].reverse().find((item) => item.role === 'assistant')
  if (!message || !clips.length) return null
  const dir = ensureDir(path.join(userRoot(), 'speech', conversationId, message.id))
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.wav')) fs.rmSync(path.join(dir, name), { force: true })
  }
  message.speech = {
    engine,
    clips: clips.map((clip, index) => {
      const file = path.join(dir, `${String(index).padStart(2, '0')}.wav`)
      fs.writeFileSync(file, Buffer.from(clip.audioBase64, 'base64'))
      return { line: clip.line, path: file }
    })
  }
  conversation.updatedAt = new Date().toISOString()
  writeHistory(all)
  return hydrate(conversation)
}

export function buildSpeechWav(input: SpeechDownload): { title: string; wav: Buffer } {
  const fromDisk = input.conversationId ? speechBuffers(input.conversationId) : []
  const fromClips = (input.clips || []).map((clip) => Buffer.from(clip.audioBase64, 'base64')).filter((buf) => buf.length)
  const parts = fromClips.length ? fromClips : fromDisk
  if (!parts.length) throw new Error('还没有可下载的音频')
  const stored = input.conversationId ? readHistory().find((item) => item.id === input.conversationId)?.title : ''
  return { title: input.title || stored || '讲解', wav: concatWav(parts) }
}

function speechBuffers(conversationId: string): Buffer[] {
  const conversation = readHistory().find((item) => item.id === conversationId)
  const message = [...(conversation?.messages || [])].reverse().find((item) => item.role === 'assistant')
  if (!message?.speech) return []
  return message.speech.clips.filter((clip) => fs.existsSync(clip.path)).map((clip) => fs.readFileSync(clip.path))
}

function concatWav(parts: Buffer[]): Buffer {
  const parsed = parts.map(wavData)
  const { rate, channels, bits } = parsed[0]
  const pcm = Buffer.concat(parsed.map((part) => part.pcm))
  const blockAlign = channels * (bits / 8)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * blockAlign, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bits, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

function wavData(buffer: Buffer): { rate: number; channels: number; bits: number; pcm: Buffer } {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF') throw new Error('音频不是 WAV')
  let offset = 12
  let rate = 24000
  let channels = 1
  let bits = 16
  let pcm = Buffer.alloc(0)
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const start = offset + 8
    if (id === 'fmt ') {
      channels = buffer.readUInt16LE(start + 2)
      rate = buffer.readUInt32LE(start + 4)
      bits = buffer.readUInt16LE(start + 14)
    } else if (id === 'data') {
      pcm = Buffer.from(buffer.subarray(start, start + size))
    }
    offset = start + size + (size % 2)
  }
  if (!pcm.length) throw new Error('音频里没有数据')
  return { rate, channels, bits, pcm }
}

export function exportHistory(ids: string[], format: 'md' | 'json'): string {
  const wanted = new Set(ids)
  const rows = readHistory().filter((item) => !wanted.size || wanted.has(item.id))
  if (format === 'json') return JSON.stringify(rows, null, 2)
  return rows
    .map((item) => {
      const body = item.messages
        .map((message) => {
          const files = (message.attachments || []).map((file) => file.name).join(', ')
          return `### ${message.role === 'user' ? '用户' : '助手'}\n\n${message.content}${files ? `\n\n附件：${files}` : ''}`
        })
        .join('\n\n')
      return `# ${item.title}\n\n${body}`
    })
    .join('\n\n---\n\n')
}
