import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Attachment, ChatMessage, Entry } from '@shared/types'
import { replayClips, speakLines, speakText, speechLines, type SpeechClip, type SpeechProgress } from '../lib/audio'

function audioPayload(clips: SpeechClip[]): { line: string; audioBase64: string }[] {
  return clips.flatMap((clip) => {
    const match = clip.src.match(/^data:[^;]+;base64,(.+)$/)
    return match ? [{ line: clip.line, audioBase64: match[1] }] : []
  })
}
import { explainPrompt } from '../lib/prompt'

const MAX_FILES = 5

type Props = {
  entry?: Entry | null
  conversationId: string | null
  onConversation: (id: string) => void
  ask?: { nonce: string; text: string; entryId?: string } | null
}

function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  )
}

function fileKind(file: File): Attachment['kind'] {
  if (file.type.startsWith('image/')) return 'image'
  if (file.type.startsWith('text/') || /\.(txt|md|json|csv|ts|tsx|js|py|html|css)$/i.test(file.name)) return 'text'
  return 'file'
}

async function readAttachment(file: File): Promise<Attachment> {
  const kind = fileKind(file)
  const id = crypto.randomUUID()
  if (kind === 'image') {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(file)
    })
    return { id, name: file.name || 'image', mime: file.type || 'image/png', kind, dataUrl }
  }
  const text = await file.text()
  return { id, name: file.name || 'file', mime: file.type || 'text/plain', kind, text: text.slice(0, 20000) }
}

export function ChatPane({ entry, conversationId, onConversation, ask }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [files, setFiles] = useState<Attachment[]>([])
  const [streaming, setStreaming] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [engine, setEngine] = useState('')
  const [speech, setSpeech] = useState<SpeechProgress | null>(null)
  const [playing, setPlaying] = useState(false)
  const [take, setTake] = useState<{ key: string; clips: SpeechClip[] } | null>(null)
  const [audioNote, setAudioNote] = useState('')
  const [wordTake, setWordTake] = useState<{ word: string; engine: string; clip: SpeechClip } | null>(null)
  const [wordBusy, setWordBusy] = useState<'synth' | 'play' | ''>('')
  const requestRef = useRef('')
  const askedRef = useRef('')
  const readRef = useRef(0)
  const scroller = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const off = window.dict.onAi((event) => {
      if (event.requestId !== requestRef.current) return
      if (event.type === 'delta') setStreaming((prev) => prev + event.text)
      if (event.type === 'done') {
        onConversation(event.conversationId)
        setBusy(false)
        setStreaming('')
        void window.dict.getHistory(event.conversationId).then((row) => {
          if (row) setMessages(row.messages)
        })
      }
      if (event.type === 'error') {
        setBusy(false)
        setError(event.message)
      }
    })
    return off
  }, [onConversation])

  useEffect(() => {
    if (!conversationId) {
      setMessages([])
      return
    }
    void window.dict.getHistory(conversationId).then((row) => {
      if (row) setMessages(row.messages)
    })
  }, [conversationId])

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight })
  }, [messages, streaming])

  useEffect(() => {
    const current = entry
    if (!current) return
    void window.dict.getPointRead(current.id).then((row) => {
      const message = row?.messages.find((item) => item.speech?.clips[0]?.src)
      const clip = message?.speech?.clips[0]
      if (!clip?.src || !message?.speech) return
      setWordTake({ word: current.word, engine: message.speech.engine, clip: { line: clip.line, src: clip.src } })
    })
  }, [entry?.id])

  useEffect(() => {
    const last = messages.filter((message) => message.role === 'assistant').at(-1)
    if (!last?.speech?.clips.length) return
    const clips = last.speech.clips
      .filter((clip) => clip.src)
      .map((clip) => ({ line: clip.line, src: clip.src as string }))
    if (!clips.length) return
    setEngine(last.speech.engine)
    setTake({ key: speechLines(last.content).join('\n'), clips })
  }, [messages])

  const spoken = useMemo(
    () => speechLines(streaming || messages.filter((m) => m.role === 'assistant').at(-1)?.content || ''),
    [messages, streaming]
  )
  const spokenKey = spoken.join('\n')
  const ready = take?.key === spokenKey && take.clips.length === spoken.length

  async function readExplanation(): Promise<void> {
    const id = readRef.current + 1
    readRef.current = id
    setError('')
    if (ready && take) {
      setPlaying(true)
      try {
        await replayClips(take.clips)
      } catch (reason: unknown) {
        if (readRef.current === id) setError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        if (readRef.current === id) setPlaying(false)
      }
      return
    }
    setSpeech({ index: 1, total: spoken.length, line: spoken[0] || '' })
    try {
      const next = await speakLines(spoken, (progress) => {
        if (readRef.current === id) setSpeech(progress)
      })
      if (readRef.current === id && next.clips.length === spoken.length) {
        setEngine(next.engine)
        setTake({ key: spokenKey, clips: next.clips })
        if (conversationId) {
          const saved = await window.dict.saveSpeech(conversationId, next.engine, audioPayload(next.clips))
          if (readRef.current === id && saved) setMessages(saved.messages)
        }
      }
    } catch (reason: unknown) {
      if (readRef.current === id) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (readRef.current === id) setSpeech(null)
    }
  }

  async function readWord(): Promise<void> {
    if (!entry) return
    setError('')
    if (wordTake?.word === entry.word) {
      setWordBusy('play')
      try {
        await replayClips([wordTake.clip])
      } catch (reason: unknown) {
        setError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        setWordBusy('')
      }
      return
    }
    setWordBusy('synth')
    try {
      const spokenWord = await speakText(entry.word)
      setWordTake({ word: entry.word, engine: spokenWord.engine, clip: spokenWord.clip })
      const match = spokenWord.clip.src.match(/^data:[^;]+;base64,(.+)$/)
      if (match) {
        await window.dict.savePointRead({
          entryId: entry.id,
          word: entry.word,
          topic: entry.topic,
          engine: spokenWord.engine,
          audioBase64: match[1]
        })
      }
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setWordBusy('')
    }
  }

  async function addFiles(list: File[]): Promise<void> {
    const room = MAX_FILES - files.length
    const next: Attachment[] = []
    for (const file of list.slice(0, room)) {
      if (file.size > 8 * 1024 * 1024) {
        setError(`${file.name} 超过 8MB`)
        continue
      }
      next.push(await readAttachment(file))
    }
    setFiles((prev) => [...prev, ...next].slice(0, MAX_FILES))
  }

  async function send(prompt: string, purpose: 'explain' | 'followup', entryId?: string): Promise<void> {
    const text = prompt.trim()
    if (!text || busy) return
    setError('')
    setBusy(true)
    setStreaming('')
    const local: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      createdAt: new Date().toISOString(),
      attachments: files
    }
    setMessages((prev) => [...prev, local])
    setDraft('')
    const attachments = files
    setFiles([])
    const started = await window.dict.startChat({
      conversationId: conversationId || undefined,
      entryId,
      prompt: text,
      attachments,
      purpose
    })
    requestRef.current = started.requestId
    onConversation(started.conversationId)
  }

  useEffect(() => {
    if (!ask || askedRef.current === ask.nonce) return
    askedRef.current = ask.nonce
    void send(ask.text, 'explain', ask.entryId)
  }, [ask])

  return (
    <section className="chat">
      <header className="chat-head">
        <div>
          <p className="eyebrow">中英讲解</p>
          <h2>{entry ? entry.word : '向词典追问'}</h2>
        </div>
        {entry && (
          <button
            className="solid"
            disabled={busy}
            onClick={() =>
              void send(explainPrompt(entry.word, entry), 'explain', entry.id)
            }
          >
            生成讲解
          </button>
        )}
      </header>
      {entry && (
        <div className="word-card">
          <div>
            <strong>{entry.number ? `${entry.number}. ` : ''}{entry.word}</strong>
            <span>{entry.topic}{entry.subtopic ? ` / ${entry.subtopic}` : ''}</span>
          </div>
          <button className="ghost" onClick={() => void readWord()}>
            {wordBusy === 'synth' ? '正在合成' : wordBusy === 'play' ? '正在播放' : wordTake?.word === entry.word ? '再听' : '点读'}
          </button>
        </div>
      )}
      <div className="transcript" ref={scroller}>
        {messages.map((message) => (
          <article key={message.id} className={message.role}>
            <div className="who">{message.role === 'user' ? '你' : '讲解'}</div>
            {!!message.attachments?.length && (
              <div className="thumbs">
                {message.attachments.map((item) => (
                  <figure key={item.id}>
                    {item.dataUrl ? <img src={item.dataUrl} alt={item.name} /> : <span>{item.name}</span>}
                  </figure>
                ))}
              </div>
            )}
            <Markdown text={message.content} />
          </article>
        ))}
        {streaming && (
          <article className="assistant">
            <div className="who">讲解</div>
            <Markdown text={streaming} />
          </article>
        )}
      </div>
      {spoken.length > 0 && (
        <div className="speak-progress">
          <div className="speak-actions">
            <button className="texty" onClick={() => void readExplanation()}>
              {speech
                ? `正在合成 ${speech.index}/${speech.total}`
                : playing
                  ? '正在播放'
                  : ready
                    ? `再播一次${engine ? ` · ${engine}` : ''}`
                    : '朗读中英文'}
            </button>
            {ready && (
              <button
                className="texty"
                onClick={() => {
                  setError('')
                  setAudioNote('')
                  void window.dict
                    .downloadSpeech({
                      conversationId: conversationId || undefined,
                      title: entry?.word,
                      clips: audioPayload(take?.clips || [])
                    })
                    .then((file) => {
                      if (file) setAudioNote(`已下载到 ${file}`)
                    })
                    .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
                }}
              >
                下载音频
              </button>
            )}
          </div>
          {speech && (
            <>
              <div className="bar" aria-hidden="true">
                <span style={{ width: `${Math.round(((speech.index - 1) / speech.total) * 100)}%` }} />
              </div>
              <p>{speech.line}</p>
            </>
          )}
          {audioNote && <p>{audioNote}</p>}
        </div>
      )}
      {error && <p className="error">{error}</p>}
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault()
          void send(draft, 'followup', entry?.id)
        }}
        onPaste={(event) => {
          const images = [...event.clipboardData.files]
          if (images.length) {
            event.preventDefault()
            void addFiles(images)
          }
        }}
      >
        {!!files.length && (
          <div className="thumbs">
            {files.map((item) => (
              <figure key={item.id}>
                {item.dataUrl ? <img src={item.dataUrl} alt={item.name} /> : <span>{item.name}</span>}
                <button type="button" onClick={() => setFiles((prev) => prev.filter((file) => file.id !== item.id))}>
                  ×
                </button>
              </figure>
            ))}
          </div>
        )}
        <textarea
          value={draft}
          placeholder="继续追问。可粘贴图片，最多 5 个附件。"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void send(draft, 'followup', entry?.id)
            }
          }}
        />
        <div className="composer-bar">
          <label className="ghost">
            附件
            <input
              type="file"
              multiple
              hidden
              onChange={(event) => {
                void addFiles([...(event.target.files || [])])
                event.target.value = ''
              }}
            />
          </label>
          <span>{files.length}/{MAX_FILES}</span>
          {busy ? (
            <button type="button" className="solid" onClick={() => requestRef.current && void window.dict.cancelChat(requestRef.current)}>
              停止
            </button>
          ) : (
            <button className="solid" type="submit" disabled={!draft.trim()}>
              发送
            </button>
          )}
        </div>
      </form>
    </section>
  )
}
