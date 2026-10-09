import fs from 'node:fs'
import path from 'node:path'
import type { Attachment, EmbedEvent, EmbedStatus, SearchHit } from '../shared/types'
import { getEntry, ragDocuments, readCatalog } from './ocr'
import { dictDir } from './paths'
import { getApiKey, getRuntimeConfig } from './store'

let building = false
const listeners = new Set<(event: EmbedEvent) => void>()

function emit(event: EmbedEvent): void {
  for (const listener of listeners) listener(event)
}

export function onEmbed(listener: (event: EmbedEvent) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

type RecordMeta = {
  id: string
  entryId?: string
  topicId?: string
  pdfPage: number
  text: string
}

type MetaFile = { model: string; dim: number; records: RecordMeta[] }

function modelSlug(model: string): string {
  return model.replace(/[^a-z0-9]+/gi, '_').slice(0, 80)
}

function filesFor(model: string): { meta: string; bin: string } {
  const dir = path.join(dictDir(), 'vectors')
  fs.mkdirSync(dir, { recursive: true })
  const slug = modelSlug(model)
  return { meta: path.join(dir, `${slug}.json`), bin: path.join(dir, `${slug}.bin`) }
}

function readMeta(): MetaFile | null {
  const { embeddingModel } = getRuntimeConfig()
  try {
    return JSON.parse(fs.readFileSync(filesFor(embeddingModel).meta, 'utf8')) as MetaFile
  } catch {
    return null
  }
}

export function embedStatus(): EmbedStatus {
  const model = getRuntimeConfig().embeddingModel
  const meta = readMeta()
  return {
    model,
    ready: Boolean(meta && meta.model === model && meta.records.length),
    vectors: meta?.records.length || 0,
    building,
    progress: 0,
    total: 0
  }
}

async function embedBatch(inputs: unknown[]): Promise<number[][]> {
  const { baseUrl, embeddingModel } = getRuntimeConfig()
  const apiKey = getApiKey()
  if (!apiKey) throw new Error('请先在设置中保存 ZenMux API Key')
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/embeddings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model: embeddingModel, input: inputs })
  })
  const json = (await response.json()) as {
    error?: { message?: string }
    data?: { index: number; embedding: number[] }[]
  }
  if (!response.ok) throw new Error(json.error?.message || `嵌入接口返回 ${response.status}`)
  const rows = [...(json.data || [])].sort((a, b) => a.index - b.index)
  if (!rows.length || !rows[0].embedding?.length) throw new Error('嵌入接口没有返回向量')
  return rows.map((row) => row.embedding)
}

export async function buildEmbeddings(): Promise<void> {
  if (building) return
  const docs = ragDocuments()
  if (!docs.length) throw new Error('请先完成 OCR 索引')
  building = true
  const model = getRuntimeConfig().embeddingModel
  try {
    const vectors: number[][] = []
    const batchSize = 32
    for (let i = 0; i < docs.length; i += batchSize) {
      const batch = docs.slice(i, i + batchSize).map((doc) => doc.text)
      const embedded = await embedBatch(batch)
      vectors.push(...embedded)
      emit({ type: 'progress', done: Math.min(i + batch.length, docs.length), total: docs.length })
    }
    const dim = vectors[0].length
    const bin = Buffer.alloc(vectors.length * dim * 4)
    vectors.forEach((vector, row) => {
      if (vector.length !== dim) throw new Error('嵌入维度不一致，请换一个嵌入模型后重试')
      for (let col = 0; col < dim; col++) bin.writeFloatLE(vector[col], (row * dim + col) * 4)
    })
    const target = filesFor(model)
    const meta: MetaFile = {
      model,
      dim,
      records: docs.map((doc) => ({
        id: doc.id,
        entryId: doc.entryId,
        topicId: doc.topicId,
        pdfPage: doc.pdfPage,
        text: doc.text
      }))
    }
    fs.writeFileSync(target.bin, bin)
    fs.writeFileSync(target.meta, JSON.stringify(meta))
    emit({ type: 'done', vectors: meta.records.length })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    emit({ type: 'error', message })
    throw error
  } finally {
    building = false
  }
}

function cosine(query: number[], row: Float32Array): number {
  let dot = 0
  let qn = 0
  let rn = 0
  for (let i = 0; i < query.length; i++) {
    dot += query[i] * row[i]
    qn += query[i] * query[i]
    rn += row[i] * row[i]
  }
  if (!qn || !rn) return 0
  return dot / Math.sqrt(qn * rn)
}

export async function vectorSearch(query: string, image?: Attachment | null, limit = 8): Promise<SearchHit[]> {
  const meta = readMeta()
  if (!meta?.records.length) return []
  const target = filesFor(meta.model)
  const bin = fs.readFileSync(target.bin)
  const input = image?.dataUrl
    ? [{ content: [{ type: 'text', text: query || image.name }, { type: 'image_url', image_url: { url: image.dataUrl } }] }]
    : [query]
  let vectors: number[][]
  try {
    vectors = await embedBatch(input)
  } catch (error) {
    if (!image) throw error
    vectors = await embedBatch([query || image.name])
  }
  const queryVec = vectors[0]
  if (queryVec.length !== meta.dim) {
    throw new Error(`当前向量索引是 ${meta.dim} 维，模型返回 ${queryVec.length} 维。请用同一模型重建索引。`)
  }
  const scored = meta.records.map((record, index) => {
    const start = index * meta.dim * 4
    const row = new Float32Array(meta.dim)
    for (let i = 0; i < meta.dim; i++) row[i] = bin.readFloatLE(start + i * 4)
    return { record, score: cosine(queryVec, row) }
  })
  scored.sort((a, b) => b.score - a.score)
  const catalog = readCatalog()
  return scored.slice(0, limit).map(({ record, score }) => {
    const entry = record.entryId ? getEntry(record.entryId) : undefined
    const topic = catalog?.topics.find((item) => item.id === record.topicId)
    return {
      entryId: entry?.id,
      topicId: record.topicId,
      word: entry?.word || topic?.title || record.text.slice(0, 48),
      topic: entry?.topic || topic?.title || '',
      subtopic: entry?.subtopic,
      pdfPage: entry?.pdfPage || record.pdfPage,
      bookPage: entry?.bookPage || topic?.bookPage,
      number: entry?.number,
      score: Math.round(score * 100),
      why: image?.dataUrl ? '图像语义检索' : '语义检索'
    }
  })
}

export function contextFor(query: string, entryId?: string): Promise<string> {
  return vectorSearch(query, null, 6)
    .then((hits) => {
      const lines = hits.map((hit) => `${hit.word} · ${hit.topic} · 第 ${hit.bookPage || hit.pdfPage} 页`)
      if (entryId) lines.unshift(`当前词条 id ${entryId}`)
      return lines.join('\n')
    })
    .catch(() => '')
}
