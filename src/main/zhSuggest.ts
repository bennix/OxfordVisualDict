import fs from 'node:fs'
import path from 'node:path'
import type { SearchHit, SuggestResult } from '../shared/types'
import { keywordHits } from './ocr'
import { userRoot } from './paths'
import { ZH_SEED, suggestChineseLexicon, type ZhGloss } from './zhLexicon'
import { getApiKey, getRuntimeConfig } from './store'

function lexiconPath(): string {
  return path.join(userRoot(), 'zh-lexicon.json')
}

function loadLearned(): ZhGloss[] {
  try {
    const raw = JSON.parse(fs.readFileSync(lexiconPath(), 'utf8')) as ZhGloss[]
    return Array.isArray(raw) ? raw.filter((item) => item.zh && item.en) : []
  } catch {
    return []
  }
}

function remember(extra: ZhGloss[]): void {
  if (!extra.length) return
  const merged = new Map<string, ZhGloss>()
  for (const item of [...loadLearned(), ...extra]) merged.set(`${item.zh}\t${item.en}`, item)
  fs.mkdirSync(userRoot(), { recursive: true })
  fs.writeFileSync(lexiconPath(), JSON.stringify([...merged.values()], null, 2))
}

function allGlosses(): ZhGloss[] {
  const merged = new Map<string, ZhGloss>()
  for (const item of [...ZH_SEED, ...loadLearned()]) merged.set(`${item.zh}\t${item.en}`, item)
  return [...merged.values()]
}

function toHits(pairs: { zh: string; en: string; why: string; score: number }[]): SearchHit[] {
  const merged = new Map<string, SearchHit>()
  for (const pair of pairs) {
    const found = keywordHits(pair.en)
    const strong = found.filter((hit) => hit.score >= 88)
    const rows = (strong.length ? strong : found).slice(0, 4)
    for (const hit of rows) {
      const key = hit.entry.id
      const why = `中文「${pair.zh}」→ ${pair.en} · ${pair.why}`
      const score = pair.score + hit.score / 100
      const prev = merged.get(key)
      if (prev && prev.score >= score) continue
      merged.set(key, {
        entryId: hit.entry.id,
        topicId: hit.entry.topicId,
        word: hit.entry.word,
        topic: hit.entry.topic,
        subtopic: hit.entry.subtopic,
        pdfPage: hit.entry.pdfPage,
        bookPage: hit.entry.bookPage,
        number: hit.entry.number,
        score: Math.round(score),
        why
      })
    }
  }
  return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, 24)
}

async function askModel(prefix: string): Promise<ZhGloss[]> {
  const apiKey = getApiKey()
  if (!apiKey) return []
  const { baseUrl, chatModel } = getRuntimeConfig()
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: chatModel,
      stream: false,
      messages: [
        {
          role: 'system',
          content:
            '用户在逐字查英语图解词典。根据当前中文，给出最可能的下一个汉字，以及当前输入对应的英文单词。只输出 JSON：{"next":[{"char":"巾","en":"towel"}],"keywords":["towel"]}。char 只能是一个汉字。en 用词典里常见的英文单词或短语。不要解释。'
        },
        { role: 'user', content: prefix }
      ]
    })
  })
  const json = (await response.json()) as { choices?: { message?: { content?: string } }[]; error?: { message?: string } }
  if (!response.ok) throw new Error(json.error?.message || `联想接口返回 ${response.status}`)
  const text = json.choices?.[0]?.message?.content || ''
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return []
  const parsed = JSON.parse(match[0]) as { next?: { char?: string; en?: string }[]; keywords?: string[] }
  const glosses: ZhGloss[] = []
  for (const item of parsed.next || []) {
    const char = (item.char || '').trim()
    const en = (item.en || '').trim()
    if (!/^[\u4e00-\u9fff]$/.test(char) || !en) continue
    glosses.push({ zh: `${prefix}${char}`, en })
  }
  for (const keyword of parsed.keywords || []) {
    const en = keyword.trim()
    if (en) glosses.push({ zh: prefix, en })
  }
  return glosses
}

export async function suggestChinese(rawPrefix: string): Promise<SuggestResult> {
  const prefix = rawPrefix.trim()
  let glosses = allGlosses()
  let local = suggestChineseLexicon(glosses, prefix)
  let note = ''
  if (!local.matches.length) {
    if (!getApiKey()) {
      note = '这个中文还没有本地联想。在设置中保存 API Key 后，会继续猜下一个字并记在本机。'
    } else {
      try {
        const learned = await askModel(prefix)
        remember(learned)
        glosses = allGlosses()
        local = suggestChineseLexicon(glosses, prefix)
        if (!local.matches.length) note = '没有联想到对应的英文词。可以换一个字，或直接点检索。'
      } catch (error) {
        note = error instanceof Error ? error.message : String(error)
      }
    }
  }
  return {
    next: local.next,
    exact: local.exact,
    hits: toHits(local.matches),
    note
  }
}
