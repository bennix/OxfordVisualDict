import type { Entry } from '../shared/types'

export type NextChar = {
  label: string
  append: string
  count: number
}

export type SuggestMatch = {
  entry: Entry
  score: number
  why: string
  nextLabel: string
  append: string
}

function continuation(word: string, span: number): { label: string; append: string } | null {
  let index = span
  let append = ''
  if (word[index] === ' ') {
    append = ' '
    index += 1
  }
  const char = word[index]
  if (!char) return null
  append += char
  return { label: char, append }
}

function spanOf(word: string, prefix: string): number | null {
  if (word.startsWith(prefix)) return prefix.length
  let offset = 0
  for (const part of word.split(/\s+/)) {
    if (part.startsWith(prefix)) return offset + prefix.length
    offset += part.length + 1
  }
  return null
}

export function suggestEntries(entries: Entry[], rawPrefix: string): {
  next: NextChar[]
  exact: number
  hits: SuggestMatch[]
} {
  const prefix = rawPrefix.trim().toLowerCase()
  if (!prefix || /[\u4e00-\u9fff]/.test(prefix)) return { next: [], exact: 0, hits: [] }
  const counts = new Map<string, NextChar>()
  const seenWords = new Set<string>()
  const hits: SuggestMatch[] = []
  let exact = 0
  for (const entry of entries) {
    const word = entry.word.toLowerCase().replace(/\s+/g, ' ').trim()
    const span = spanOf(word, prefix)
    if (span == null) continue
    const next = continuation(word, span)
    const atStart = word.startsWith(prefix)
    const remaining = word.length - span
    const score = (word === prefix ? 100 : atStart ? 90 : 78) - Math.min(remaining, 24) * 0.15
    hits.push({
      entry,
      score,
      why: next ? `下一个字是「${next.label}」` : '已经是完整单词',
      nextLabel: next?.label || '',
      append: next?.append || ''
    })
    if (!seenWords.has(word)) {
      seenWords.add(word)
      if (!next) exact += 1
      else {
        const key = next.append
        const prev = counts.get(key)
        if (prev) prev.count += 1
        else counts.set(key, { label: next.label, append: next.append, count: 1 })
      }
    }
  }
  const next = [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)).slice(0, 14)
  const rank = new Map(next.map((item, index) => [item.append, index]))
  hits.sort((a, b) => {
    if (!a.append && b.append) return -1
    if (a.append && !b.append) return 1
    const ar = rank.get(a.append) ?? 99
    const br = rank.get(b.append) ?? 99
    return ar - br || b.score - a.score || a.entry.word.localeCompare(b.entry.word)
  })
  return { next, exact, hits: hits.slice(0, 24) }
}
