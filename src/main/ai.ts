import type { Attachment, ChatMessage } from '../shared/types'
import { contextFor } from './embeddings'
import { getEntry, pageContext } from './ocr'
import { getApiKey, getHistory, getRuntimeConfig, saveConversation } from './store'

const SYSTEM = `你是图解词典学习助手。用户正在本地阅读 The New Oxford Picture Dictionary 的扫描件。
请用 Markdown 讲解，并且中文和英文同时给出。严格使用这个结构：

## 释义
**中文：** …
**English：** …

## 例句
1. EN: …
   中文：…
2. EN: …
   中文：…
3. EN: …

## 使用场景
**中文：** …
**English：** …

## 搭配与注意
- …

要求：
- 每条例句都先给英文，再给意思对应的中文，英文句子要自然、可朗读。
- 优先讲图解词典里的那个义项。OCR 原文可能有错字，不要把错字当真。
- 不要编造页码。追问时继续保持中英并列。`

type DeltaHandler = (text: string) => void

function contentOf(text: string, attachments: Attachment[]): string | unknown[] {
  const blocks: unknown[] = []
  const notes: string[] = []
  for (const item of attachments.slice(0, 5)) {
    if (item.kind === 'image' && item.dataUrl) {
      blocks.push({ type: 'image_url', image_url: { url: item.dataUrl } })
    } else if (item.text) {
      notes.push(`附件 ${item.name}:\n${item.text.slice(0, 12000)}`)
    } else {
      notes.push(`附件 ${item.name}（${item.mime}）未能读取成文本。`)
    }
  }
  const merged = [text, notes.length ? `\n\n${notes.join('\n\n')}` : ''].join('')
  if (!blocks.length) return merged
  return [{ type: 'text', text: merged }, ...blocks]
}

async function postChat(messages: unknown[], stream: boolean, signal?: AbortSignal): Promise<Response> {
  const apiKey = getApiKey()
  if (!apiKey) throw new Error('还没有 API Key。可以在设置页通过邀请链接申请。')
  const { baseUrl, chatModel } = getRuntimeConfig()
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model: chatModel, stream, messages })
  })
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(detail.slice(0, 400) || `模型接口返回 ${response.status}`)
  }
  return response
}

export async function translateKeywords(query: string): Promise<string[]> {
  const response = await postChat(
    [
      {
        role: 'system',
        content:
          '把用户的中文检索词转换成 1 到 6 个可能出现在英语图解词典里的英文单词或主题。只输出 JSON，形如 {"keywords":["bathroom","towel"]}。不要解释。'
      },
      { role: 'user', content: query }
    ],
    false
  )
  const json = (await response.json()) as { choices?: { message?: { content?: string } }[] }
  const text = json.choices?.[0]?.message?.content || ''
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return []
  const parsed = JSON.parse(match[0]) as { keywords?: string[] }
  return (parsed.keywords || []).map((item) => item.trim()).filter(Boolean).slice(0, 6)
}

async function readStream(response: Response, onDelta: DeltaHandler, signal?: AbortSignal): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('模型没有返回流')
  const decoder = new TextDecoder()
  let buffer = ''
  let full = ''
  while (true) {
    if (signal?.aborted) {
      await reader.cancel()
      break
    }
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const data = trimmed.slice(5).trim()
      if (!data || data === '[DONE]') continue
      try {
        const json = JSON.parse(data) as { choices?: { delta?: { content?: string } }[] }
        const delta = json.choices?.[0]?.delta?.content
        if (delta) {
          full += delta
          onDelta(delta)
        }
      } catch {
        continue
      }
    }
  }
  return full
}

export async function runChat(options: {
  conversationId?: string
  entryId?: string
  prompt: string
  attachments: Attachment[]
  purpose: 'explain' | 'followup'
  onDelta: DeltaHandler
  signal?: AbortSignal
}): Promise<{ conversationId: string }> {
  const now = new Date().toISOString()
  const existing = options.conversationId ? getHistory(options.conversationId) : null
  const entry = options.entryId ? getEntry(options.entryId) : undefined
  const conversation = existing || {
    id: options.conversationId || crypto.randomUUID(),
    title: entry ? `${entry.word} · ${entry.topic}` : options.prompt.slice(0, 32) || '对话',
    createdAt: now,
    updatedAt: now,
    entryId: options.entryId,
    messages: [] as ChatMessage[]
  }
  const userMessage: ChatMessage = {
    id: crypto.randomUUID(),
    role: 'user',
    content: options.prompt,
    createdAt: now,
    attachments: options.attachments.slice(0, 5)
  }
  const page = entry ? pageContext(entry.pdfPage) : ''
  const related = await contextFor(options.prompt, options.entryId)
  const messages: unknown[] = [
    { role: 'system', content: SYSTEM },
    {
      role: 'system',
      content: `词典页 OCR：\n${page || '（无）'}\n\n语义检索摘录：\n${related || '（暂无向量索引）'}`
    }
  ]
  for (const message of conversation.messages) {
    messages.push({
      role: message.role,
      content: contentOf(message.content, message.attachments || [])
    })
  }
  messages.push({ role: 'user', content: contentOf(userMessage.content, userMessage.attachments) })
  const response = await postChat(messages, true, options.signal)
  const answer = await readStream(response, options.onDelta, options.signal)
  const assistant: ChatMessage = {
    id: crypto.randomUUID(),
    role: 'assistant',
    content: answer,
    createdAt: new Date().toISOString(),
    attachments: []
  }
  conversation.messages = [...conversation.messages, userMessage, assistant]
  conversation.updatedAt = assistant.createdAt
  saveConversation(conversation)
  return { conversationId: conversation.id }
}
