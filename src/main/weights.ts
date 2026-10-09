import fs from 'node:fs'
import path from 'node:path'
import type { WeightEvent } from '../shared/types'
import { ensureDir, userModelDir, type VoiceVersion } from './paths'
import { getRuntimeConfig } from './store'
import { ttsStatus } from './tts'

const FILES: Record<VoiceVersion, { repo: string; files: string[] }> = {
  cosyvoice2: {
    repo: 'FunAudioLLM/CosyVoice2-0.5B',
    files: [
      'config.json',
      'configuration.json',
      'cosyvoice2.yaml',
      'llm.pt',
      'flow.pt',
      'hift.pt',
      'campplus.onnx',
      'speech_tokenizer_v2.onnx',
      'CosyVoice-BlankEN/config.json',
      'CosyVoice-BlankEN/generation_config.json',
      'CosyVoice-BlankEN/tokenizer_config.json',
      'CosyVoice-BlankEN/merges.txt',
      'CosyVoice-BlankEN/vocab.json',
      'CosyVoice-BlankEN/model.safetensors'
    ]
  },
  cosyvoice3: {
    repo: 'FunAudioLLM/Fun-CosyVoice3-0.5B-2512',
    files: [
      'config.json',
      'configuration.json',
      'cosyvoice3.yaml',
      'llm.pt',
      'flow.pt',
      'hift.pt',
      'campplus.onnx',
      'speech_tokenizer_v3.onnx',
      'CosyVoice-BlankEN/config.json',
      'CosyVoice-BlankEN/generation_config.json',
      'CosyVoice-BlankEN/tokenizer_config.json',
      'CosyVoice-BlankEN/merges.txt',
      'CosyVoice-BlankEN/vocab.json',
      'CosyVoice-BlankEN/model.safetensors'
    ]
  }
}

const listeners = new Set<(event: WeightEvent) => void>()
let job: Promise<void> | null = null

export function onWeights(listener: (event: WeightEvent) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function emit(event: WeightEvent): void {
  for (const listener of listeners) listener(event)
}

function fileUrls(repo: string, file: string): string[] {
  return [
    `https://huggingface.co/${repo}/resolve/main/${file}`,
    `https://hf-mirror.com/${repo}/resolve/main/${file}`
  ]
}

async function remoteSize(url: string): Promise<number> {
  const response = await fetch(url, { method: 'HEAD' })
  if (!response.ok) return 0
  return Number(response.headers.get('content-length') || 0)
}

async function downloadFile(urls: string[], dest: string, label: string, index: number, count: number): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  let lastError = '下载失败'
  for (const url of urls) {
    try {
      const size = await remoteSize(url).catch(() => 0)
      if (size > 0 && fs.existsSync(dest) && fs.statSync(dest).size === size) {
        emit({ type: 'progress', label: `${label} 已存在`, done: index, total: count })
        return
      }
      const partial = `${dest}.partial`
      let received = fs.existsSync(partial) ? fs.statSync(partial).size : 0
      const headers: Record<string, string> = {}
      if (received > 0) headers.Range = `bytes=${received}-`
      let response = await fetch(url, { headers })
      if (response.status === 416 || (received > 0 && response.status === 200)) {
        received = 0
        response = await fetch(url)
      }
      if (!response.ok || !response.body) throw new Error(`${response.status} ${label}`)
      const extra = Number(response.headers.get('content-length') || 0)
      const totalBytes = response.status === 206 ? received + extra : extra
      const stream = fs.createWriteStream(partial, { flags: received > 0 && response.status === 206 ? 'a' : 'w' })
      if (!(received > 0 && response.status === 206)) received = 0
      const reader = response.body.getReader()
      let lastEmit = 0
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        const bytes = Buffer.from(chunk.value)
        await new Promise<void>((resolve, reject) => stream.write(bytes, (error) => (error ? reject(error) : resolve())))
        received += bytes.length
        const now = Date.now()
        if (now - lastEmit > 700) {
          lastEmit = now
          const fraction = totalBytes ? Math.min(0.99, received / totalBytes) : 0
          emit({
            type: 'progress',
            label: `${label} ${formatBytes(received)}${totalBytes ? ` / ${formatBytes(totalBytes)}` : ''}`,
            done: index - 1 + fraction,
            total: count
          })
        }
      }
      await new Promise<void>((resolve) => stream.end(resolve))
      fs.renameSync(partial, dest)
      emit({ type: 'progress', label: `${label} 完成`, done: index, total: count })
      return
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
  }
  throw new Error(`${label}：${lastError}`)
}

function formatBytes(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)} GB`
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} MB`
  return `${Math.max(1, Math.round(value / 1000))} KB`
}

async function runDownload(): Promise<void> {
  const version = getRuntimeConfig().cosyvoiceVersion
  const pack = FILES[version]
  const root = ensureDir(userModelDir(version))
  for (let index = 0; index < pack.files.length; index += 1) {
    const file = pack.files[index]
    emit({ type: 'progress', label: `正在下载 ${file}`, done: index, total: pack.files.length })
    await downloadFile(fileUrls(pack.repo, file), path.join(root, file), file, index + 1, pack.files.length)
  }
  emit({ type: 'done' })
}

export function downloadWeights(): Promise<Awaited<ReturnType<typeof ttsStatus>>> {
  if (!job) {
    job = runDownload()
      .catch((error: unknown) => {
        emit({ type: 'error', message: error instanceof Error ? error.message : String(error) })
        throw error
      })
      .finally(() => {
        job = null
      })
  }
  return job.then(() => ttsStatus())
}
