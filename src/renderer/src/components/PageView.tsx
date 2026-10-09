import { useEffect, useMemo, useRef, useState } from 'react'
import type { Entry, OcrWord } from '@shared/types'
import { loadDictionary } from '../lib/pdf'

type Hotspot = {
  id: string
  text: string
  x: number
  y: number
  w: number
  h: number
  entry?: Entry
}

type Props = {
  page: number
  words: OcrWord[]
  entries: Entry[]
  selected?: Entry | null
  onSpeak: (spot: Hotspot) => void
  onAsk: (spot: Hotspot) => void
}

function tokenOf(text: string): string {
  return text.toLowerCase().replace(/[^a-z'-]/g, '')
}

function hotspotsFor(words: OcrWord[], entries: Entry[]): Hotspot[] {
  const used = new Set<OcrWord>()
  const spots: Hotspot[] = []
  for (const entry of entries) {
    const tokens = new Set(entry.word.toLowerCase().split(/\s+/).map(tokenOf).filter(Boolean))
    const parts = words.filter((word) => tokens.has(tokenOf(word.text)) && Math.abs(word.y - entry.y) < 0.035)
    if (!parts.length) continue
    parts.forEach((part) => used.add(part))
    const x = Math.min(...parts.map((part) => part.x))
    const y = Math.min(...parts.map((part) => part.y))
    const right = Math.max(...parts.map((part) => part.x + part.w))
    const bottom = Math.max(...parts.map((part) => part.y + part.h))
    spots.push({ id: entry.id, text: entry.word, x, y, w: right - x, h: bottom - y, entry })
  }
  words.forEach((word, index) => {
    if (used.has(word)) return
    if (tokenOf(word.text).length < 2) return
    spots.push({ id: `ocr-${index}-${word.x}`, text: word.text, x: word.x, y: word.y, w: word.w, h: word.h })
  })
  return spots
}

export function PageView({ page, words, entries, selected, onSpeak, onAsk }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const spots = useMemo(() => hotspotsFor(words, entries), [words, entries])
  const open = spots.find((spot) => spot.id === openId) || null

  useEffect(() => {
    let cancel = false
    const canvas = canvasRef.current
    if (!canvas) return
    setError('')
    setOpenId(null)
    void loadDictionary()
      .then(async (pdf) => {
        const pdfPage = await pdf.getPage(page)
        if (cancel) return
        const viewport = pdfPage.getViewport({ scale: 1.35 })
        const context = canvas.getContext('2d')
        if (!context) return
        canvas.width = viewport.width
        canvas.height = viewport.height
        await pdfPage.render({ canvas, canvasContext: context, viewport }).promise
      })
      .catch((reason: unknown) => {
        if (!cancel) setError(reason instanceof Error ? reason.message : String(reason))
      })
    return () => {
      cancel = true
    }
  }, [page])

  return (
    <div className="page-stage">
      <div className="page-sheet">
        <canvas ref={canvasRef} />
        <div className="hotspots">
          {spots.map((spot) => (
            <button
              key={spot.id}
              type="button"
              className={spot.entry && selected?.id === spot.entry.id ? 'hotspot on' : 'hotspot'}
              title={spot.text}
              style={{ left: `${spot.x * 100}%`, top: `${spot.y * 100}%`, width: `${spot.w * 100}%`, height: `${spot.h * 100}%` }}
              onClick={() => setOpenId((current) => (current === spot.id ? null : spot.id))}
            />
          ))}
          {open && (
            <div
              className="hot-menu"
              style={
                open.y > 0.82
                  ? { left: `${open.x * 100}%`, top: `${open.y * 100}%`, transform: 'translateY(-110%)' }
                  : { left: `${open.x * 100}%`, top: `${(open.y + open.h) * 100}%` }
              }
            >
              <strong>{open.text}</strong>
              <button type="button" onClick={() => onSpeak(open)}>
                朗读
              </button>
              <button type="button" className="solid" onClick={() => onAsk(open)}>
                询问
              </button>
            </div>
          )}
        </div>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  )
}
