import { useEffect, useState } from 'react'
import type { Conversation, ConversationSummary } from '@shared/types'
import { ChatPane } from '../components/ChatPane'

export function HistoryView() {
  const [rows, setRows] = useState<ConversationSummary[]>([])
  const [picked, setPicked] = useState<string[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const [open, setOpen] = useState<Conversation | null>(null)
  const [message, setMessage] = useState('')

  async function reload(): Promise<void> {
    setRows(await window.dict.listHistory())
  }

  useEffect(() => {
    void reload()
  }, [])

  useEffect(() => {
    if (!openId) {
      setOpen(null)
      return
    }
    void window.dict.getHistory(openId).then(setOpen)
  }, [openId])

  async function remove(): Promise<void> {
    if (!picked.length) return
    await window.dict.deleteHistory(picked)
    if (openId && picked.includes(openId)) setOpenId(null)
    setPicked([])
    await reload()
  }

  async function exportAs(format: 'md' | 'json'): Promise<void> {
    const file = await window.dict.exportHistory(picked.length ? picked : rows.map((row) => row.id), format)
    setMessage(file ? `已导出到 ${file}` : '已取消导出')
  }

  return (
    <section className="history-layout">
      <div className="panel">
        <header className="split">
          <div>
            <p className="eyebrow">历史</p>
            <h2>讲解与追问</h2>
          </div>
          <div className="row-actions">
            <button onClick={() => setPicked(picked.length === rows.length ? [] : rows.map((row) => row.id))}>
              {picked.length === rows.length && rows.length ? '取消全选' : '全选'}
            </button>
            <button onClick={() => void remove()} disabled={!picked.length}>
              删除所选
            </button>
            <button onClick={() => void exportAs('md')}>导出 Markdown</button>
            <button onClick={() => void exportAs('json')}>导出 JSON</button>
          </div>
        </header>
        {message && <p className="note">{message}</p>}
        <ul className="results">
          {rows.map((row) => (
            <li key={row.id} className="check-row">
              <input
                type="checkbox"
                checked={picked.includes(row.id)}
                onChange={(event) =>
                  setPicked((prev) => (event.target.checked ? [...prev, row.id] : prev.filter((id) => id !== row.id)))
                }
              />
              <button onClick={() => setOpenId(row.id)}>
                <b>{row.title}</b>
                <span>{row.preview}</span>
                <small>
                  {new Date(row.updatedAt).toLocaleString()} · {row.messageCount} 条{row.hasSpeech ? ' · 可重听' : ''}
                </small>
              </button>
            </li>
          ))}
          {!rows.length && <li className="muted">还没有讲解记录。</li>}
        </ul>
      </div>
      {openId && (
        <ChatPane
          entry={null}
          conversationId={openId}
          onConversation={(id) => {
            setOpenId(id)
            void reload()
          }}
        />
      )}
      {open && <span className="sr">{open.title}</span>}
    </section>
  )
}
