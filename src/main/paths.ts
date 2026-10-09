import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

export function userRoot(): string {
  return path.join(app.getPath('userData'), 'picture-dictionary')
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function importedPdfPath(): string {
  return path.join(dictDir(), 'imported.pdf')
}

export function bundledPdfPath(): string {
  const candidates = [
    path.join(process.resourcesPath, 'dictionary.pdf'),
    path.join(app.getAppPath(), 'resources', 'dictionary.pdf'),
    path.join(process.cwd(), 'resources', 'dictionary.pdf')
  ]
  for (const file of candidates) {
    if (fs.existsSync(file)) return file
  }
  return candidates[1]
}

export function activePdfPath(): string {
  const imported = importedPdfPath()
  if (fs.existsSync(imported)) return imported
  return bundledPdfPath()
}

export type VoiceVersion = 'cosyvoice2' | 'cosyvoice3'

export function cosyvoiceRoot(): string {
  const candidates = [
    path.join(process.resourcesPath, 'cosyvoice'),
    path.join(app.getAppPath(), 'resources', 'cosyvoice'),
    path.join(process.cwd(), 'resources', 'cosyvoice')
  ]
  return candidates.find((dir) => fs.existsSync(path.join(dir, 'repo'))) || candidates[1]
}

export function userModelDir(version: VoiceVersion): string {
  const folder = version === 'cosyvoice2' ? 'CosyVoice2-0.5B' : 'Fun-CosyVoice3-0.5B'
  return path.join(userRoot(), 'cosyvoice', 'models', folder)
}

function weightsReady(dir: string): boolean {
  return ['llm.pt', 'flow.pt', 'hift.pt'].every((name) => fs.existsSync(path.join(dir, name)))
}

export function bundledVoice(version: VoiceVersion): {
  root: string
  python: string
  repo: string
  modelDir: string
} {
  const root = cosyvoiceRoot()
  const folder = version === 'cosyvoice2' ? 'CosyVoice2-0.5B' : 'Fun-CosyVoice3-0.5B'
  const bundledModel = path.join(root, 'models', folder)
  const downloaded = userModelDir(version)
  return {
    root,
    python: path.join(root, 'python', 'bin', 'python3'),
    repo: path.join(root, 'repo'),
    modelDir: weightsReady(downloaded) ? downloaded : weightsReady(bundledModel) ? bundledModel : downloaded
  }
}

export function ttsScriptPath(): string {
  const candidates = [
    path.join(process.resourcesPath, 'tts_server.py'),
    path.join(app.getAppPath(), 'resources', 'tts_server.py'),
    path.join(process.cwd(), 'resources', 'tts_server.py')
  ]
  for (const file of candidates) {
    if (fs.existsSync(file)) return file
  }
  return candidates[1]
}

export function findBinary(name: string): string | null {
  const dirs = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    ...(process.env.PATH || '').split(':')
  ]
  for (const dir of dirs) {
    if (!dir) continue
    const full = path.join(dir, name)
    if (fs.existsSync(full)) return full
  }
  return null
}

export function dictDir(): string {
  return ensureDir(path.join(userRoot(), 'dictionary'))
}

export function pageFile(pdfPage: number): string {
  return path.join(dictDir(), 'pages', `page-${String(pdfPage).padStart(3, '0')}.json`)
}

export function attachmentDir(): string {
  return ensureDir(path.join(userRoot(), 'attachments'))
}
