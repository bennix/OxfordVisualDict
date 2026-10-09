export type RawWord = {
  text: string
  conf: number
  left: number
  top: number
  width: number
  height: number
}

export type ParsedEntry = {
  number?: number
  word: string
  subtopic?: string
  y: number
}

export type ParsedPage = {
  kind: 'topic' | 'index' | 'toc' | 'other'
  title?: string
  bookPage?: number
  entries: ParsedEntry[]
  toc: { title: string; bookPage: number }[]
  indexWords: { word: string; bookPage?: number }[]
}

const NUM = /^(\d{1,3})\.?\s*(.*)$/

function clusterColumns(tokens: RawWord[], pageW: number): { toks: RawWord[] }[] {
  const gap = Math.max(36, Math.floor(pageW * 0.04))
  const cols: { left: number; right: number; toks: RawWord[] }[] = []
  for (const tok of [...tokens].sort((a, b) => a.left - b.left)) {
    const hit = cols.find(
      (col) => tok.left <= col.right + gap && tok.left + tok.width >= col.left - gap
    )
    if (!hit) {
      cols.push({ left: tok.left, right: tok.left + tok.width, toks: [tok] })
    } else {
      hit.left = Math.min(hit.left, tok.left)
      hit.right = Math.max(hit.right, tok.left + tok.width)
      hit.toks.push(tok)
    }
  }
  cols.sort((a, b) => a.left - b.left)
  const merged: { left: number; right: number; toks: RawWord[] }[] = []
  for (const col of cols) {
    const prev = merged[merged.length - 1]
    if (prev && col.left <= prev.right + gap) {
      prev.left = Math.min(prev.left, col.left)
      prev.right = Math.max(prev.right, col.right)
      prev.toks.push(...col.toks)
    } else {
      merged.push({ ...col, toks: [...col.toks] })
    }
  }
  return merged
}

function linesOf(toks: RawWord[]): { text: string; y: number }[] {
  const lines: { cy: number; n: number; toks: RawWord[] }[] = []
  for (const tok of [...toks].sort((a, b) => a.top + a.height / 2 - (b.top + b.height / 2))) {
    const cy = tok.top + tok.height / 2
    const last = lines[lines.length - 1]
    if (last && Math.abs(cy - last.cy) <= 16) {
      last.toks.push(tok)
      last.cy = (last.cy * last.n + cy) / (last.n + 1)
      last.n += 1
    } else {
      lines.push({ cy, n: 1, toks: [tok] })
    }
  }
  const out: { text: string; y: number }[] = []
  for (const line of lines) {
    const text = line.toks
      .sort((a, b) => a.left - b.left)
      .map((t) => t.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    const letters = text.replace(/[^A-Za-z]/g, '')
    if (letters.length < 2 && !/^\d{1,3}\.?$/.test(text)) continue
    out.push({ text, y: line.cy })
  }
  return out
}

function isSubhead(text: string): boolean {
  const words = text.match(/[A-Za-z][A-Za-z'’-]+/g) || []
  if (!words.length || words.length > 6) return false
  if (/\d/.test(text)) return false
  return words.every((w) => /[A-Z]/.test(w[0] || ''))
}

function parseColumn(lines: { text: string; y: number }[]): ParsedEntry[] {
  const entries: ParsedEntry[] = []
  let sub: string | undefined
  for (const line of lines) {
    const m = line.text.match(NUM)
    const rest = m?.[2]?.trim() || ''
    const restOk = !!m && (rest === '' || /^[A-Za-z(]/.test(rest))
    if (m && restOk && Number(m[1]) < 200) {
      const num = Number(m[1])
      const word = rest.replace(/^[\s.]+|[\s.]+$/g, '')
      if (word) entries.push({ number: num, word, subtopic: sub, y: line.y })
      continue
    }
    if (isSubhead(line.text)) {
      sub = line.text
      continue
    }
    const word = line.text.replace(/^[\s.]+|[\s.]+$/g, '')
    if (word.replace(/[^A-Za-z]/g, '').length < 2) continue
    entries.push({ word, subtopic: sub, y: line.y })
  }
  const nums = entries
    .map((e, i) => (e.number != null ? ([i, e.number] as const) : null))
    .filter((x): x is readonly [number, number] => !!x)
  if (nums.length) {
    for (let n = 0; n < nums.length - 1; n++) {
      const [i, a] = nums[n]
      const [j, b] = nums[n + 1]
      const between = j - i - 1
      const diff = b - a - 1
      if (between > 0 && between === diff) {
        for (let k = 0; k < between; k++) entries[i + 1 + k].number = a + 1 + k
      }
    }
    const [firstI, firstN] = nums[0]
    if (firstI > 0 && entries.slice(0, firstI).every((e) => e.number == null) && firstN - firstI >= 1) {
      for (let k = 0; k < firstI; k++) entries[k].number = firstN - firstI + k
    }
    let cursor = nums[nums.length - 1][1]
    for (let k = nums[nums.length - 1][0] + 1; k < entries.length; k++) {
      if (entries[k].number == null) {
        cursor += 1
        entries[k].number = cursor
      } else {
        cursor = entries[k].number ?? cursor
      }
    }
  } else {
    entries.forEach((e, i) => {
      e.number = i + 1
    })
  }
  return entries.filter((e) => e.number && e.word && e.word.length <= 48)
}

function parseTitle(words: RawWord[], height: number): { bookPage?: number; title?: string } {
  const head = words
    .filter((w) => w.top < height * 0.1 && w.conf >= 60)
    .sort((a, b) => a.left - b.left)
  const text = head
    .map((w) => w.text)
    .join(' ')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
  const m = text.match(/^(\d{1,3})\s+(.+)$/)
  if (!m) return { title: text || undefined }
  const title = m[2].replace(/\b\d\b/g, ' ').replace(/\s+/g, ' ').trim()
  return { bookPage: Number(m[1]), title }
}

function parseToc(words: RawWord[]): { title: string; bookPage: number }[] {
  const height = Math.max(...words.map((w) => w.top + w.height), 1)
  const lines = linesOf(words.filter((w) => w.top > height * 0.08 && w.conf >= 60))
  const items: { title: string; bookPage: number }[] = []
  for (const line of lines) {
    const m = line.text.match(/^([A-Za-z][A-Za-z0-9 ,:'’./&-]{2,60}?)\s+(\d{1,3})(?:\s*-\s*\d{1,3})?$/)
    if (!m) continue
    const title = m[1].replace(/\s+/g, ' ').trim()
    if (/^contents$/i.test(title)) continue
    items.push({ title, bookPage: Number(m[2]) })
  }
  return items
}

function parseIndex(words: RawWord[], width: number): { word: string; bookPage?: number }[] {
  const cols = clusterColumns(
    words.filter((w) => w.conf >= 72),
    width
  )
  const found: { word: string; bookPage?: number }[] = []
  const seen = new Set<string>()
  for (const col of cols) {
    for (const line of linesOf(col.toks)) {
      const m = line.text.match(/^([A-Za-z][A-Za-z'’\-]*(?:\s+[A-Za-z][A-Za-z'’\-]*){0,3})/)
      if (!m) continue
      const word = m[1].toLowerCase().replace(/\s+/g, ' ').trim()
      if (word.length < 3 || seen.has(word)) continue
      if (!/^[a-z][a-z'’\- ]+$/.test(word)) continue
      const refs = [...line.text.matchAll(/\b(\d{1,3})\b/g)]
        .map((x) => Number(x[1]))
        .filter((n) => n > 0 && n < 140)
      seen.add(word)
      found.push({ word, bookPage: refs[0] })
    }
  }
  return found.slice(0, 400)
}

export function parsePage(words: RawWord[], width: number, height: number): ParsedPage {
  const usable = words.filter((w) => w.conf >= 50 && w.text.trim())
  const titled = parseTitle(usable, height)
  const dense = usable.filter((w) => w.conf >= 55).length
  let kind: ParsedPage['kind'] = 'other'
  if (dense > 420) kind = 'index'
  else if (/contents/i.test(titled.title || '') || usable.some((w) => /^contents$/i.test(w.text))) kind = 'toc'
  else if (titled.bookPage && titled.title && titled.title.length > 2) kind = 'topic'

  if (kind === 'toc') {
    return { kind, title: titled.title, bookPage: titled.bookPage, entries: [], toc: parseToc(usable), indexWords: [] }
  }
  if (kind === 'index') {
    return {
      kind,
      title: titled.title,
      bookPage: titled.bookPage,
      entries: [],
      toc: [],
      indexWords: parseIndex(usable, width)
    }
  }
  if (kind !== 'topic') {
    return { kind, title: titled.title, bookPage: titled.bookPage, entries: [], toc: [], indexWords: [] }
  }

  const band = usable.filter((w) => w.conf >= 68 && w.top > height * 0.55)
  const cols = clusterColumns(band, width)
  const entries: ParsedEntry[] = []
  for (const col of cols) {
    const parsed = parseColumn(linesOf(col.toks))
    for (const entry of parsed) {
      entries.push({ ...entry, y: height ? entry.y / height : 0 })
    }
  }
  entries.sort((a, b) => (a.number || 0) - (b.number || 0))
  return { kind, title: titled.title, bookPage: titled.bookPage, entries, toc: [], indexWords: [] }
}

export function pngSize(buf: Buffer): { width: number; height: number } {
  if (buf.length < 24 || buf.toString('ascii', 1, 4) !== 'PNG') {
    throw new Error('不是 PNG')
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

export function parseTsv(tsv: string): RawWord[] {
  const lines = tsv.split(/\r?\n/)
  if (!lines.length) return []
  const header = lines[0].split('\t')
  const words: RawWord[] = []
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue
    const cells = lines[i].split('\t')
    if (cells.length < header.length) continue
    const row: Record<string, string> = {}
    header.forEach((key, idx) => {
      row[key] = cells[idx] || ''
    })
    if (row.level !== '5' || !row.text?.trim()) continue
    const conf = Number(row.conf)
    if (!Number.isFinite(conf) || conf < 0) continue
    words.push({
      text: row.text.trim(),
      conf,
      left: Number(row.left) || 0,
      top: Number(row.top) || 0,
      width: Number(row.width) || 0,
      height: Number(row.height) || 0
    })
  }
  return words
}
