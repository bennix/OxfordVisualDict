import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Entry, IndexEvent, IndexStatus, PagePayload, Topic } from '../shared/types'
import { suggestEntries } from './suggest'
import { parsePage, parseTsv, pngSize, type RawWord } from './parse'
import { activePdfPath, dictDir, findBinary, pageFile } from './paths'

const execFileAsync = promisify(execFile)

type Catalog = {
  pageCount: number
  topics: Topic[]
  entries: Entry[]
  bookToPdf: Record<string, number>
}

let building = false
let cancel = false
const listeners = new Set<(event: IndexEvent) => void>()

function emit(event: IndexEvent): void {
  for (const listener of listeners) listener(event)
}

export function onIndex(listener: (event: IndexEvent) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function catalogPath(): string {
  return path.join(dictDir(), 'catalog.json')
}

export function readCatalog(): Catalog | null {
  try {
    return JSON.parse(fs.readFileSync(catalogPath(), 'utf8')) as Catalog
  } catch {
    return null
  }
}

export function readPage(pdfPage: number): PagePayload | null {
  try {
    return JSON.parse(fs.readFileSync(pageFile(pdfPage), 'utf8')) as PagePayload
  } catch {
    return null
  }
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'word'
}

function normalizeWords(words: RawWord[], width: number, height: number) {
  return words
    .filter((word) => word.conf >= 55 && /[A-Za-z]{2,}/.test(word.text))
    .map((word) => ({
      text: word.text,
      conf: word.conf,
      x: word.left / width,
      y: word.top / height,
      w: word.width / width,
      h: word.height / height
    }))
}

async function pageCount(pdf: string, pdfinfo: string | null): Promise<number> {
  if (pdfinfo) {
    const { stdout } = await execFileAsync(pdfinfo, [pdf])
    const match = stdout.match(/Pages:\s+(\d+)/)
    if (match) return Number(match[1])
  }
  const { stdout } = await execFileAsync('python3', [
    '-c',
    'import pypdf,sys; print(len(pypdf.PdfReader(sys.argv[1]).pages))',
    pdf
  ])
  return Number(stdout.trim())
}

export async function getStatus(): Promise<IndexStatus> {
  const pdfPath = activePdfPath()
  const tools = {
    tesseract: findBinary('tesseract'),
    pdftoppm: findBinary('pdftoppm'),
    pdfinfo: findBinary('pdfinfo')
  }
  const catalog = readCatalog()
  let pages = catalog?.pageCount || 0
  if (!pages && fs.existsSync(pdfPath) && tools.pdfinfo) {
    try {
      pages = await pageCount(pdfPath, tools.pdfinfo)
    } catch {
      pages = 0
    }
  }
  return {
    pdfReady: fs.existsSync(pdfPath),
    pdfPath,
    pageCount: pages,
    indexedPages: catalog ? pages : countIndexed(pages),
    entryCount: catalog?.entries.length || 0,
    topicCount: catalog?.topics.length || 0,
    building,
    tools
  }
}

function countIndexed(pageCountValue: number): number {
  const dir = path.join(dictDir(), 'pages')
  if (!fs.existsSync(dir)) return 0
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.json'))
  return pageCountValue ? Math.min(files.length, pageCountValue) : files.length
}

export async function buildIndex(force = false): Promise<void> {
  if (building) return
  const pdfPath = activePdfPath()
  const tesseract = findBinary('tesseract')
  const pdftoppm = findBinary('pdftoppm')
  if (!fs.existsSync(pdfPath)) throw new Error('请先导入词典 PDF')
  if (!tesseract || !pdftoppm) throw new Error('需要本机的 tesseract 和 pdftoppm（poppler）才能识别扫描页')
  building = true
  cancel = false
  const tmp = path.join(dictDir(), 'tmp')
  fs.mkdirSync(path.join(dictDir(), 'pages'), { recursive: true })
  fs.mkdirSync(tmp, { recursive: true })
  try {
    const total = await pageCount(pdfPath, findBinary('pdfinfo'))
    const pages: PagePayload[] = []
    for (let page = 1; page <= total; page++) {
      if (cancel) break
      emit({ type: 'progress', page, total, label: `正在识别第 ${page} / ${total} 页` })
      const existing = !force ? readPage(page) : null
      if (existing) {
        pages.push(existing)
        continue
      }
      const base = path.join(tmp, `page-${page}`)
      await execFileAsync(pdftoppm, ['-f', String(page), '-l', String(page), '-r', '120', '-png', '-singlefile', pdfPath, base])
      const png = `${base}.png`
      const { stdout } = await execFileAsync(tesseract, [png, 'stdout', '-l', 'eng', '--psm', '11', 'tsv'], {
        maxBuffer: 32 * 1024 * 1024
      })
      const image = fs.readFileSync(png)
      const size = pngSize(image)
      fs.rmSync(png, { force: true })
      const raw = parseTsv(stdout)
      const parsed = parsePage(raw, size.width, size.height)
      const topicId = `topic-${page}`
      const entries: Entry[] = parsed.entries.map((entry) => ({
        id: `p${page}-n${entry.number}-${slug(entry.word)}`,
        word: entry.word,
        number: entry.number,
        topic: parsed.title || `第 ${page} 页`,
        topicId,
        subtopic: entry.subtopic,
        pdfPage: page,
        bookPage: parsed.bookPage,
        y: entry.y
      }))
      const payload: PagePayload = {
        pdfPage: page,
        width: size.width,
        height: size.height,
        kind: parsed.kind,
        title: parsed.title,
        bookPage: parsed.bookPage,
        words: normalizeWords(raw, size.width, size.height),
        entries
      }
      fs.writeFileSync(pageFile(page), JSON.stringify(payload))
      pages.push(payload)
    }
    const catalog = assemble(pages)
    fs.writeFileSync(catalogPath(), JSON.stringify(catalog))
    emit({ type: 'done', entryCount: catalog.entries.length, topicCount: catalog.topics.length })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    emit({ type: 'error', message })
    throw error
  } finally {
    building = false
  }
}

function assemble(pages: PagePayload[]): Catalog {
  const offsets: number[] = []
  for (const page of pages) {
    if (page.kind === 'topic' && page.bookPage) offsets.push(page.pdfPage - page.bookPage)
  }
  offsets.sort((a, b) => a - b)
  const offset = offsets[Math.floor(offsets.length / 2)] ?? 0
  const bookToPdf: Record<string, number> = {}
  const topics: Topic[] = []
  const entries: Entry[] = []
  for (const page of pages) {
    if (page.kind !== 'topic') continue
    const topicId = page.entries[0]?.topicId || `topic-${page.pdfPage}`
    const title = (page.title || `第 ${page.pdfPage} 页`).replace(/^\d+\s+/, '')
    topics.push({
      id: topicId,
      title,
      pdfPage: page.pdfPage,
      bookPage: page.bookPage,
      entryCount: page.entries.length
    })
    if (page.bookPage) bookToPdf[String(page.bookPage)] = page.pdfPage
    for (const entry of page.entries) {
      entries.push({ ...entry, topic: title, topicId })
    }
  }
  void offset
  return { pageCount: pages.length, topics, entries, bookToPdf }
}

export function entriesByLetter(letter: string): Entry[] {
  const catalog = readCatalog()
  if (!catalog) return []
  const key = letter.toUpperCase()
  return catalog.entries
    .filter((entry) => entry.word.replace(/^[^A-Za-z]+/, '').toUpperCase().startsWith(key))
    .sort((a, b) => a.word.localeCompare(b.word))
}

export function suggestPrefix(prefix: string) {
  return suggestEntries(readCatalog()?.entries || [], prefix)
}

export function keywordHits(query: string): { entry: Entry; score: number; why: string }[] {
  const catalog = readCatalog()
  if (!catalog) return []
  const q = query.trim().toLowerCase()
  if (!q) return []
  const hits: { entry: Entry; score: number; why: string }[] = []
  for (const entry of catalog.entries) {
    const word = entry.word.toLowerCase()
    const topic = `${entry.topic} ${entry.subtopic || ''}`.toLowerCase()
    if (word === q) hits.push({ entry, score: 100, why: '单词完全匹配' })
    else if (word.startsWith(q)) hits.push({ entry, score: 88, why: '单词开头匹配' })
    else if (word.includes(q)) hits.push({ entry, score: 74, why: '单词包含关键字' })
    else if (topic.includes(q)) hits.push({ entry, score: 60, why: '主题匹配' })
  }
  for (const topic of catalog.topics) {
    if (!topic.title.toLowerCase().includes(q)) continue
    const sample = catalog.entries.find((entry) => entry.topicId === topic.id)
    if (!sample) continue
    if (hits.some((hit) => hit.entry.topicId === topic.id && hit.why === '主题匹配')) continue
    hits.push({ entry: sample, score: 56, why: `主题「${topic.title}」` })
  }
  hits.sort((a, b) => b.score - a.score || a.entry.word.localeCompare(b.entry.word))
  return hits.slice(0, 50)
}

export function getEntry(id: string): Entry | undefined {
  return readCatalog()?.entries.find((entry) => entry.id === id)
}

export function pageContext(pdfPage: number): string {
  const page = readPage(pdfPage)
  if (!page) return ''
  const lines = page.entries.map((entry) => `${entry.number ?? ''}. ${entry.word}${entry.subtopic ? ` (${entry.subtopic})` : ''}`)
  return [`主题：${page.title || ''}`, `PDF 页 ${page.pdfPage}`, ...lines].join('\n')
}

export function ragDocuments(): { id: string; entryId?: string; topicId?: string; pdfPage: number; text: string }[] {
  const catalog = readCatalog()
  if (!catalog) return []
  const docs: { id: string; entryId?: string; topicId?: string; pdfPage: number; text: string }[] = catalog.entries.map((entry) => ({
    id: entry.id,
    entryId: entry.id,
    topicId: entry.topicId,
    pdfPage: entry.pdfPage,
    text: `${entry.word}. Topic: ${entry.topic}. ${entry.subtopic ? `Section: ${entry.subtopic}. ` : ''}Picture number ${entry.number ?? ''}.`
  }))
  for (const topic of catalog.topics) {
    const words = catalog.entries.filter((entry) => entry.topicId === topic.id).map((entry) => entry.word)
    docs.push({
      id: topic.id,
      topicId: topic.id,
      pdfPage: topic.pdfPage,
      text: `Topic ${topic.title}. Vocabulary: ${words.join(', ')}`
    })
  }
  return docs
}
