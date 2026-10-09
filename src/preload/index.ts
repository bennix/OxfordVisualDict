import { contextBridge, ipcRenderer } from 'electron'
import type { AiEvent, AiStartRequest, Attachment, DictApi, EmbedEvent, IndexEvent, PublicSettings, WeightEvent } from '../shared/types'

const api: DictApi = {
  getStatus: () => ipcRenderer.invoke('status'),
  buildIndex: (force) => ipcRenderer.invoke('build-index', force),
  onIndex: (cb) => {
    const listener = (_event: unknown, payload: IndexEvent) => cb(payload)
    ipcRenderer.on('index-event', listener)
    return () => ipcRenderer.removeListener('index-event', listener)
  },
  readPdf: () => ipcRenderer.invoke('read-pdf'),
  getTopics: () => ipcRenderer.invoke('topics'),
  getEntriesByLetter: (letter) => ipcRenderer.invoke('entries-by-letter', letter),
  getPage: (pdfPage) => ipcRenderer.invoke('page', pdfPage),
  search: (query, image) => ipcRenderer.invoke('search', query, image),
  suggest: (prefix) => ipcRenderer.invoke('suggest', prefix),
  getSettings: () => ipcRenderer.invoke('settings-get'),
  setApiKey: (apiKey) => ipcRenderer.invoke('settings-key', apiKey),
  verifyApiKey: (candidate) => ipcRenderer.invoke('settings-verify', candidate),
  updateSettings: (patch) => ipcRenderer.invoke('settings-update', patch),
  getEmbedStatus: () => ipcRenderer.invoke('embed-status'),
  buildEmbeddings: () => ipcRenderer.invoke('embed-build'),
  onEmbed: (cb) => {
    const listener = (_event: unknown, payload: EmbedEvent) => cb(payload)
    ipcRenderer.on('embed-event', listener)
    return () => ipcRenderer.removeListener('embed-event', listener)
  },
  getTtsStatus: () => ipcRenderer.invoke('tts-status'),
  startTts: () => ipcRenderer.invoke('tts-start'),
  stopTts: () => ipcRenderer.invoke('tts-stop'),
  speak: (text) => ipcRenderer.invoke('speak', text),
  startChat: (req: AiStartRequest) => ipcRenderer.invoke('chat-start', req),
  cancelChat: (requestId) => ipcRenderer.invoke('chat-cancel', requestId),
  onAi: (cb) => {
    const listener = (_event: unknown, payload: AiEvent) => cb(payload)
    ipcRenderer.on('ai-event', listener)
    return () => ipcRenderer.removeListener('ai-event', listener)
  },
  listHistory: () => ipcRenderer.invoke('history-list'),
  getHistory: (id) => ipcRenderer.invoke('history-get', id),
  deleteHistory: (ids) => ipcRenderer.invoke('history-delete', ids),
  saveSpeech: (conversationId, engine, clips) => ipcRenderer.invoke('speech-save', conversationId, engine, clips),
  savePointRead: (input) => ipcRenderer.invoke('point-read-save', input),
  getPointRead: (entryId) => ipcRenderer.invoke('point-read-get', entryId),
  downloadSpeech: (input) => ipcRenderer.invoke('speech-download', input),
  revealVoiceDir: () => ipcRenderer.invoke('voice-reveal'),
  importPdf: () => ipcRenderer.invoke('import-pdf'),
  downloadWeights: () => ipcRenderer.invoke('weights-download'),
  onWeights: (cb) => {
    const listener = (_event: unknown, payload: WeightEvent) => cb(payload)
    ipcRenderer.on('weight-event', listener)
    return () => ipcRenderer.removeListener('weight-event', listener)
  },
  exportHistory: (ids, format) => ipcRenderer.invoke('history-export', ids, format),
  openExternal: (url) => ipcRenderer.invoke('open-external', url)
}

contextBridge.exposeInMainWorld('dict', api)

export type { Attachment, PublicSettings }
