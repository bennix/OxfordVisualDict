import { useEffect, useState } from 'react'
import type { Entry, IndexStatus, PublicSettings, SearchHit } from '@shared/types'
import { Reader } from './views/Reader'
import { SearchView } from './views/SearchView'
import { HistoryView } from './views/HistoryView'
import { SettingsView } from './views/SettingsView'
import { resetDictionary } from './lib/pdf'

type View = 'read' | 'search' | 'history' | 'settings'

export function App() {
  const [view, setView] = useState<View>('read')
  const [status, setStatus] = useState<IndexStatus | null>(null)
  const [settings, setSettings] = useState<PublicSettings | null>(null)
  const [page, setPage] = useState(8)
  const [entry, setEntry] = useState<Entry | null>(null)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [progress, setProgress] = useState('')
  const [booted, setBooted] = useState(false)

  async function refresh(): Promise<IndexStatus> {
    const next = await window.dict.getStatus()
    setStatus(next)
    return next
  }

  useEffect(() => {
    const off = window.dict.onIndex((event) => {
      if (event.type === 'progress') setProgress(`${event.label}`)
      if (event.type === 'done') {
        setProgress(`识别完成，${event.entryCount} 个词，${event.topicCount} 个主题`)
        void refresh()
      }
      if (event.type === 'error') setProgress(event.message)
    })
    void refresh().then(async (next) => {
      setSettings(await window.dict.getSettings())
      if (!booted && next.entryCount === 0 && next.tools.tesseract && next.tools.pdftoppm && next.pdfReady) {
        setBooted(true)
        setProgress('正在识别扫描页…')
        void window.dict.buildIndex(false).catch((reason: unknown) => {
          setProgress(reason instanceof Error ? reason.message : String(reason))
        })
      } else {
        setBooted(true)
      }
    })
    return off
  }, [booted])

  async function importBook(): Promise<void> {
    const file = await window.dict.importPdf()
    if (!file) return
    resetDictionary()
    setProgress('已导入词典，开始识别')
    await window.dict.buildIndex(true)
    await refresh()
  }

  function openHit(hit: SearchHit): void {
    setPage(hit.pdfPage)
    setEntry(
      hit.entryId
        ? {
            id: hit.entryId,
            word: hit.word,
            number: hit.number,
            topic: hit.topic,
            topicId: hit.topicId || '',
            subtopic: hit.subtopic,
            pdfPage: hit.pdfPage,
            bookPage: hit.bookPage,
            y: 0.8
          }
        : null
    )
    setConversationId(null)
    setView('read')
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span>图解词典</span>
          <small>内置扫描本 · 点读</small>
        </div>
        <nav>
          {(
            [
              ['read', '阅读'],
              ['search', '检索'],
              ['history', '历史'],
              ['settings', '设置']
            ] as const
          ).map(([id, label]) => (
            <button key={id} className={view === id ? 'on' : ''} onClick={() => setView(id)}>
              {label}
            </button>
          ))}
        </nav>
        <div className="top-meta">
          {settings?.chatModel || '未选模型'}
          {settings && !settings.hasApiKey ? ' · 未设密钥' : ''}
        </div>
      </header>
      {status && !status.pdfReady && (
        <div className="progress">
          还没有词典。请导入你自己持有的 PDF。
          <button onClick={() => void importBook().catch((reason: unknown) => setProgress(reason instanceof Error ? reason.message : String(reason)))}>
            导入词典
          </button>
        </div>
      )}
      {progress && <div className="progress">{progress}</div>}
      {view === 'read' && (
        <Reader
          page={page}
          setPage={setPage}
          pageCount={status?.pageCount || 0}
          entry={entry}
          setEntry={setEntry}
          conversationId={conversationId}
          setConversationId={setConversationId}
        />
      )}
      {view === 'search' && <SearchView onOpen={openHit} />}
      {view === 'history' && <HistoryView />}
      {view === 'settings' && settings && (
        <SettingsView
          settings={settings}
          onChange={setSettings}
          onRebuildOcr={() => {
            setProgress('重新识别全部页面…')
            void window.dict.buildIndex(true)
          }}
        />
      )}
    </div>
  )
}
