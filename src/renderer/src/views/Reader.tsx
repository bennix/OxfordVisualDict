import { useEffect, useMemo, useState } from 'react'
import type { Entry, OcrWord, Topic } from '@shared/types'
import { ChatPane } from '../components/ChatPane'
import { PageView } from '../components/PageView'
import { speakText } from '../lib/audio'
import { explainPrompt } from '../lib/prompt'

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

type Props = {
  page: number
  setPage: (page: number) => void
  pageCount: number
  entry: Entry | null
  setEntry: (entry: Entry | null) => void
  conversationId: string | null
  setConversationId: (id: string | null) => void
}

export function Reader({ page, setPage, pageCount, entry, setEntry, conversationId, setConversationId }: Props) {
  const [topics, setTopics] = useState<Topic[]>([])
  const [letter, setLetter] = useState('A')
  const [letterEntries, setLetterEntries] = useState<Entry[]>([])
  const [words, setWords] = useState<OcrWord[]>([])
  const [pageEntries, setPageEntries] = useState<Entry[]>([])
  const [title, setTitle] = useState('')
  const [ask, setAsk] = useState<{ nonce: string; text: string; entryId?: string } | null>(null)
  const [voiceNote, setVoiceNote] = useState('')

  useEffect(() => {
    void window.dict.getTopics().then(setTopics)
  }, [pageCount])

  useEffect(() => {
    void window.dict.getEntriesByLetter(letter).then(setLetterEntries)
  }, [letter, pageCount])

  useEffect(() => {
    void window.dict.getPage(page).then((payload) => {
      setWords(payload?.words || [])
      setPageEntries(payload?.entries || [])
      setTitle(payload?.title || '')
    })
  }, [page, pageCount])

  const grouped = useMemo(() => {
    const map = new Map<string, Entry[]>()
    for (const item of pageEntries) {
      const key = item.subtopic || '本页词汇'
      map.set(key, [...(map.get(key) || []), item])
    }
    return [...map.entries()]
  }, [pageEntries])

  function choose(next: Entry): void {
    setEntry(next)
    setPage(next.pdfPage)
    setConversationId(null)
    void readAloud(next.word)
  }

  async function readAloud(text: string): Promise<void> {
    setVoiceNote('正在用 CosyVoice 合成，第一次要先加载模型')
    try {
      const spoken = await speakText(text)
      setVoiceNote(spoken.engine.startsWith('cosyvoice') ? '刚才是 CosyVoice 生成的声音' : spoken.engine)
    } catch (reason: unknown) {
      setVoiceNote(reason instanceof Error ? reason.message : String(reason))
    }
  }

  function focusSpot(spot: { text: string; entry?: Entry }): Entry | undefined {
    const chosen = spot.entry
    if (chosen) {
      setEntry(chosen)
      setPage(chosen.pdfPage)
    }
    return chosen
  }

  return (
    <div className="reader">
      <aside className="rail">
        <div className="letters">
          {LETTERS.map((item) => (
            <button key={item} className={item === letter ? 'on' : ''} onClick={() => setLetter(item)}>
              {item}
            </button>
          ))}
        </div>
        <div className="rail-scroll">
          <h3>{letter}</h3>
          <ul>
            {letterEntries.map((item) => (
              <li key={item.id}>
                <button className={entry?.id === item.id ? 'on' : ''} onClick={() => choose(item)}>
                  <b>{item.word}</b>
                  <small>{item.topic}</small>
                </button>
              </li>
            ))}
            {!letterEntries.length && <li className="muted">这一字母下还没有词。索引完成后会出现。</li>}
          </ul>
          <h3>主题</h3>
          <ul>
            {topics.map((topic) => (
              <li key={topic.id}>
                <button className={page === topic.pdfPage ? 'on' : ''} onClick={() => setPage(topic.pdfPage)}>
                  <b>{topic.title}</b>
                  <small>{topic.bookPage ? `书第 ${topic.bookPage} 页` : `PDF ${topic.pdfPage}`} · {topic.entryCount} 词</small>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </aside>
      <main className="stage">
        <div className="stage-bar">
          <button onClick={() => setPage(Math.max(1, page - 1))}>上一页</button>
          <label>
            PDF
            <input
              type="number"
              min={1}
              max={pageCount || 1}
              value={page}
              onChange={(event) => setPage(Math.min(pageCount || 1, Math.max(1, Number(event.target.value) || 1)))}
            />
            / {pageCount || '…'}
          </label>
          <button onClick={() => setPage(page + 1)}>下一页</button>
          <strong>{title}</strong>
          {voiceNote && <span className="voice-note">{voiceNote}</span>}
        </div>
        <PageView
          page={page}
          words={words}
          entries={pageEntries}
          selected={entry}
          onSpeak={(spot) => {
            focusSpot(spot)
            void readAloud(spot.entry?.word || spot.text)
          }}
          onAsk={(spot) => {
            const chosen = focusSpot(spot)
            setConversationId(null)
            setAsk({
              nonce: crypto.randomUUID(),
              entryId: chosen?.id,
              text: explainPrompt(chosen?.word || spot.text, chosen)
            })
          }}
        />
        {!!grouped.length && (
          <div className="entry-strip">
            {grouped.map(([name, items]) => (
              <div key={name}>
                <span>{name}</span>
                {items.map((item) => (
                  <button key={item.id} className={entry?.id === item.id ? 'on' : ''} onClick={() => choose(item)}>
                    {item.number}. {item.word}
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </main>
      <ChatPane entry={entry} conversationId={conversationId} onConversation={setConversationId} ask={ask} />
    </div>
  )
}
