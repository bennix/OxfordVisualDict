import { useEffect, useState } from 'react'
import type { Attachment, SearchHit, SuggestResult } from '@shared/types'

type Props = {
  onOpen: (hit: SearchHit) => void
}

const emptySuggest: SuggestResult = { next: [], exact: 0, hits: [] }

export function SearchView({ onOpen }: Props) {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [suggest, setSuggest] = useState<SuggestResult>(emptySuggest)
  const [pinned, setPinned] = useState(false)
  const [note, setNote] = useState('')
  const [image, setImage] = useState<Attachment | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [composing, setComposing] = useState(false)
  const [thinking, setThinking] = useState(false)

  useEffect(() => {
    if (composing) return
    if (!query.trim()) {
      setSuggest(emptySuggest)
      setThinking(false)
      return
    }
    const chinese = /[\u4e00-\u9fff]/.test(query)
    let cancel = false
    setThinking(chinese)
    const timer = setTimeout(() => {
      void window.dict.suggest(query).then((result) => {
        if (cancel) return
        setSuggest(result)
        setThinking(false)
      })
    }, chinese ? 280 : 40)
    return () => {
      cancel = true
      clearTimeout(timer)
    }
  }, [query, composing])

  async function run(event?: React.FormEvent): Promise<void> {
    event?.preventDefault()
    setBusy(true)
    setError('')
    try {
      const result = await window.dict.search(query, image)
      setHits(result.hits)
      setNote(result.note)
      setPinned(true)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="panel search-view">
      <header>
        <p className="eyebrow">检索</p>
        <h2>英文关键字、中文，或一张图</h2>
        <p>每输入一个英文字母或一个汉字，都会列出最接近的下一个字。点它继续收窄。</p>
      </header>
      <form onSubmit={(event) => void run(event)} className="search-bar">
        <input
          value={query}
          onChange={(event) => {
            setPinned(false)
            setQuery(event.target.value)
          }}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={(event) => {
            setComposing(false)
            setPinned(false)
            setQuery(event.currentTarget.value)
          }}
          placeholder="bathroom、毛巾、浴室里的垫子"
          onPaste={(event) => {
            const file = [...event.clipboardData.files].find((item) => item.type.startsWith('image/'))
            if (!file) return
            event.preventDefault()
            const reader = new FileReader()
            reader.onload = () => {
              setImage({
                id: crypto.randomUUID(),
                name: file.name || 'pasted.png',
                mime: file.type,
                kind: 'image',
                dataUrl: String(reader.result)
              })
            }
            reader.readAsDataURL(file)
          }}
        />
        <label className="ghost">
          图片
          <input
            hidden
            type="file"
            accept="image/*"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (!file) return
              const reader = new FileReader()
              reader.onload = () =>
                setImage({
                  id: crypto.randomUUID(),
                  name: file.name,
                  mime: file.type,
                  kind: 'image',
                  dataUrl: String(reader.result)
                })
              reader.readAsDataURL(file)
            }}
          />
        </label>
        <button className="solid" disabled={busy || (!query.trim() && !image)}>
          {busy ? '检索中' : '检索'}
        </button>
      </form>
      {image && (
        <div className="thumbs">
          <figure>
            <img src={image.dataUrl} alt={image.name} />
            <button type="button" onClick={() => setImage(null)}>
              ×
            </button>
          </figure>
        </div>
      )}
      {!!suggest.next.length && (
        <div className="next-chars">
          <span>下一个字</span>
          {suggest.next.map((item, index) => (
            <button
              type="button"
              key={`${item.append}-${item.label}`}
              className={index === 0 ? 'nearest' : ''}
              onClick={() => {
                setPinned(false)
                setQuery((current) => `${current.trimEnd()}${item.append}`)
              }}
            >
              {item.label}
              <small>{item.count}</small>
            </button>
          ))}
          {suggest.exact > 0 && <em>已有 {suggest.exact} 个完整词</em>}
        </div>
      )}
      {thinking && <p className="note">正在联想下一个字…</p>}
      {suggest.note && !pinned && <p className="note">{suggest.note}</p>}
      {note && pinned && <p className="note">{note}</p>}
      {error && <p className="error">{error}</p>}
      <ul className="results">
        {(pinned ? hits : suggest.hits).map((hit) => (
          <li key={`${hit.entryId || hit.word}-${hit.pdfPage}`}>
            <button onClick={() => onOpen(hit)}>
              <b>
                <WordMark word={hit.word} prefix={query} />
              </b>
              <span>
                {hit.topic}
                {hit.subtopic ? ` / ${hit.subtopic}` : ''} · PDF {hit.pdfPage}
                {hit.bookPage ? ` · 书第 ${hit.bookPage} 页` : ''}
              </span>
              <small>
                {hit.why} · {hit.score}
              </small>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

function WordMark({ word, prefix }: { word: string; prefix: string }) {
  const query = prefix.trim().toLowerCase()
  const lower = word.toLowerCase()
  if (!query || /[\u4e00-\u9fff]/.test(query)) return word
  let at = lower.startsWith(query) ? 0 : -1
  if (at < 0) {
    let offset = 0
    for (const part of lower.split(/\s+/)) {
      if (part.startsWith(query)) {
        at = offset
        break
      }
      offset += part.length + 1
    }
  }
  if (at < 0) return word
  const typed = word.slice(at, at + query.length)
  let rest = word.slice(at + query.length)
  const gap = rest.startsWith(' ')
  if (gap) rest = rest.slice(1)
  const next = rest.slice(0, 1)
  const tail = rest.slice(1)
  return (
    <>
      {word.slice(0, at)}
      <span className="typed">{typed}</span>
      {gap ? ' ' : ''}
      {next && <span className="nextc">{next}</span>}
      {tail}
    </>
  )
}
