import { BrowserWindow, app, dialog, ipcMain, nativeImage, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { AiEvent, AiStartRequest, Attachment, EmbedEvent, IndexEvent, SearchHit, WeightEvent } from '../shared/types'
import { runChat, translateKeywords } from './ai'
import { buildEmbeddings, embedStatus, onEmbed, vectorSearch } from './embeddings'
import { buildIndex, entriesByLetter, getStatus, keywordHits, onIndex, readCatalog, readPage, suggestPrefix } from './ocr'
import { activePdfPath, ensureDir, importedPdfPath, userModelDir } from './paths'
import {
  deleteHistory,
  buildSpeechWav,
  exportHistory,
  getHistory,
  getPublicSettings,
  getRuntimeConfig,
  listHistory,
  getPointRead,
  savePointRead,
  saveSpeech,
  setApiKey,
  verifyApiKey,
  updateSettings
} from './store'
import { speak, startTts, stopTts, ttsStatus } from './tts'
import { downloadWeights, onWeights } from './weights'
import { suggestChinese } from './zhSuggest'

const chatAborts = new Map<string, AbortController>()

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

function preloadPath(): string {
  const dir = path.join(__dirname, '../preload')
  for (const name of ['index.js', 'index.mjs']) {
    const file = path.join(dir, name)
    if (fs.existsSync(file)) return file
  }
  return path.join(dir, 'index.js')
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    title: '图解词典',
    backgroundColor: '#ebe4d6',
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      autoplayPolicy: 'no-user-gesture-required'
    }
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

function toHit(hit: { entry: { id: string; word: string; topic: string; subtopic?: string; pdfPage: number; bookPage?: number; number?: number; topicId: string }; score: number; why: string }): SearchHit {
  return {
    entryId: hit.entry.id,
    topicId: hit.entry.topicId,
    word: hit.entry.word,
    topic: hit.entry.topic,
    subtopic: hit.entry.subtopic,
    pdfPage: hit.entry.pdfPage,
    bookPage: hit.entry.bookPage,
    number: hit.entry.number,
    score: hit.score,
    why: hit.why
  }
}

function registerIpc(): void {
  onIndex((event: IndexEvent) => broadcast('index-event', event))
  onEmbed((event: EmbedEvent) => broadcast('embed-event', event))
  onWeights((event: WeightEvent) => broadcast('weight-event', event))

  ipcMain.handle('status', () => getStatus())
  ipcMain.handle('build-index', async (_event, force?: boolean) => {
    await buildIndex(Boolean(force))
  })
  ipcMain.handle('read-pdf', () => {
    const file = activePdfPath()
    if (!fs.existsSync(file)) throw new Error('请先导入词典 PDF')
    return fs.readFileSync(file)
  })
  ipcMain.handle('import-pdf', async () => {
    const result = await dialog.showOpenDialog({
      title: '导入词典 PDF',
      properties: ['openFile'],
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    })
    const source = result.filePaths[0]
    if (result.canceled || !source) return ''
    const dest = importedPdfPath()
    fs.copyFileSync(source, dest)
    return dest
  })
  ipcMain.handle('topics', () => readCatalog()?.topics || [])
  ipcMain.handle('entries-by-letter', (_event, letter: string) => entriesByLetter(letter))
  ipcMain.handle('page', (_event, pdfPage: number) => readPage(pdfPage))
  ipcMain.handle('suggest', async (_event, prefix: string) => {
    if (/[\u4e00-\u9fff]/.test(prefix)) return suggestChinese(prefix)
    const result = suggestPrefix(prefix)
    return {
      next: result.next,
      exact: result.exact,
      hits: result.hits.map((hit) => ({ ...toHit(hit), why: hit.why }))
    }
  })
  ipcMain.handle('search', async (_event, query: string, image?: Attachment | null) => {
    const notes: string[] = []
    const merged = new Map<string, SearchHit>()
    const add = (hit: SearchHit) => {
      const key = hit.entryId || `${hit.pdfPage}-${hit.word}`
      const prev = merged.get(key)
      if (!prev || hit.score > prev.score) merged.set(key, { ...hit, why: prev && prev.score === hit.score ? `${prev.why}；${hit.why}` : hit.why })
    }
    const text = query.trim()
    const cjk = /[\u4e00-\u9fff]/.test(text)
    if (text && !cjk) {
      for (const hit of keywordHits(text)) add(toHit(hit))
    }
    if (text && cjk) {
      try {
        const keywords = await translateKeywords(text)
        notes.push(keywords.length ? `中文已转写为：${keywords.join('、')}` : '没有得到英文关键字')
        for (const keyword of keywords) {
          for (const hit of keywordHits(keyword)) {
            add({ ...toHit(hit), score: Math.max(1, hit.score - 2), why: `中文转写「${keyword}」· ${hit.why}` })
          }
        }
      } catch (error) {
        notes.push(error instanceof Error ? error.message : String(error))
      }
    }
    if (text || image?.dataUrl) {
      try {
        const semantic = await vectorSearch(text || image?.name || '', image, 10)
        if (semantic.length) notes.push(image?.dataUrl ? '已用视觉嵌入比较图片和词条' : '已合并语义检索')
        for (const hit of semantic) add(hit)
      } catch (error) {
        notes.push(error instanceof Error ? error.message : String(error))
      }
    }
    const hits = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, 40)
    return { hits, note: notes.filter(Boolean).join(' · ') }
  })
  ipcMain.handle('settings-get', () => getPublicSettings())
  ipcMain.handle('settings-key', (_event, apiKey: string) => setApiKey(apiKey))
  ipcMain.handle('settings-verify', (_event, candidate?: string) => verifyApiKey(candidate))
  ipcMain.handle('settings-update', (_event, patch) => updateSettings(patch))
  ipcMain.handle('embed-status', () => embedStatus())
  ipcMain.handle('embed-build', () => buildEmbeddings())
  ipcMain.handle('tts-status', () => ttsStatus())
  ipcMain.handle('tts-start', () => startTts())
  ipcMain.handle('tts-stop', () => stopTts())
  ipcMain.handle('weights-download', () => downloadWeights())
  ipcMain.handle('voice-reveal', async () => {
    const dir = ensureDir(userModelDir(getRuntimeConfig().cosyvoiceVersion))
    await shell.openPath(dir)
    return dir
  })
  ipcMain.handle('speak', (_event, text: string) => speak(text))
  ipcMain.handle('history-list', () => listHistory())
  ipcMain.handle('history-get', (_event, id: string) => getHistory(id))
  ipcMain.handle('history-delete', (_event, ids: string[]) => {
    deleteHistory(ids)
  })
  ipcMain.handle('speech-save', (_event, conversationId: string, engine: string, clips: { line: string; audioBase64: string }[]) =>
    saveSpeech(conversationId, engine, clips)
  )
  ipcMain.handle('point-read-save', (_event, input) => savePointRead(input))
  ipcMain.handle('point-read-get', (_event, entryId: string) => getPointRead(entryId))
  ipcMain.handle('speech-download', async (_event, input) => {
    const speech = buildSpeechWav(input)
    const result = await dialog.showSaveDialog({
      defaultPath: `${speech.title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || '讲解'}.wav`,
      filters: [{ name: 'WAV', extensions: ['wav'] }]
    })
    if (result.canceled || !result.filePath) return ''
    fs.writeFileSync(result.filePath, speech.wav)
    return result.filePath
  })
  ipcMain.handle('history-export', async (_event, ids: string[], format: 'md' | 'json') => {
    const content = exportHistory(ids, format)
    const result = await dialog.showSaveDialog({
      defaultPath: format === 'json' ? 'dictionary-history.json' : 'dictionary-history.md',
      filters: format === 'json' ? [{ name: 'JSON', extensions: ['json'] }] : [{ name: 'Markdown', extensions: ['md'] }]
    })
    if (result.canceled || !result.filePath) return ''
    fs.writeFileSync(result.filePath, content)
    return result.filePath
  })
  ipcMain.handle('open-external', (_event, url: string) => {
    if (url.startsWith('https://')) return shell.openExternal(url)
    return Promise.resolve()
  })
  ipcMain.handle('chat-start', async (event, req: AiStartRequest) => {
    const requestId = crypto.randomUUID()
    const controller = new AbortController()
    chatAborts.set(requestId, controller)
    const conversationId = req.conversationId || crypto.randomUUID()
    void runChat({
      ...req,
      conversationId,
      attachments: (req.attachments || []).slice(0, 5),
      signal: controller.signal,
      onDelta: (text) => {
        const payload: AiEvent = { type: 'delta', requestId, text }
        event.sender.send('ai-event', payload)
      }
    })
      .then((result) => {
        const payload: AiEvent = { type: 'done', requestId, conversationId: result.conversationId }
        event.sender.send('ai-event', payload)
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          const payload: AiEvent = { type: 'done', requestId, conversationId }
          event.sender.send('ai-event', payload)
          return
        }
        const payload: AiEvent = {
          type: 'error',
          requestId,
          message: error instanceof Error ? error.message : String(error)
        }
        event.sender.send('ai-event', payload)
      })
      .finally(() => chatAborts.delete(requestId))
    return { requestId, conversationId }
  })
  ipcMain.handle('chat-cancel', (_event, requestId: string) => {
    chatAborts.get(requestId)?.abort()
    chatAborts.delete(requestId)
  })
}

function applyDockIcon(): void {
  if (process.platform !== 'darwin' || !app.dock) return
  const candidates = [
    path.join(process.resourcesPath, 'icon.png'),
    path.join(app.getAppPath(), 'resources', 'icon.png'),
    path.join(process.cwd(), 'resources', 'icon.png')
  ]
  const file = candidates.find((item) => fs.existsSync(item))
  if (!file) return
  const image = nativeImage.createFromPath(file)
  if (!image.isEmpty()) app.dock.setIcon(image)
}

app.whenReady().then(() => {
  applyDockIcon()
  registerIpc()
  createWindow()
  if (getRuntimeConfig().speechEngine !== 'edge') {
    void startTts().catch((error: unknown) => {
      console.error('CosyVoice', error instanceof Error ? error.message : error)
    })
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
