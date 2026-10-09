import { execFile, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { TtsStatus } from '../shared/types'
import { bundledVoice, ensureDir, ttsScriptPath, userModelDir, userRoot, type VoiceVersion } from './paths'
import { getRuntimeConfig } from './store'

let child: ChildProcess | null = null
let boot: Promise<TtsStatus> | null = null
let loadedVersion: VoiceVersion | null = null
let phase: 'idle' | 'loading' | 'ready' = 'idle'

function voicePrompt(repo: string): { wav: string; text: string } {
  return {
    wav: path.join(repo, 'asset', 'zero_shot_prompt.wav'),
    text: '希望你以后能够做的比我还好呦。'
  }
}

function voiceConfig(): {
  python: string
  repo: string
  modelDir: string
  version: VoiceVersion
  serverUrl: string
  bundledReady: boolean
} {
  const settings = getRuntimeConfig()
  const bundled = bundledVoice(settings.cosyvoiceVersion)
  const python = settings.cosyvoicePython && fs.existsSync(settings.cosyvoicePython) ? settings.cosyvoicePython : bundled.python
  const repo = settings.cosyvoiceRepo && fs.existsSync(settings.cosyvoiceRepo) ? settings.cosyvoiceRepo : bundled.repo
  const modelDir = settings.cosyvoiceModelDir && fs.existsSync(settings.cosyvoiceModelDir) ? settings.cosyvoiceModelDir : bundled.modelDir
  return {
    python,
    repo,
    modelDir,
    version: settings.cosyvoiceVersion,
    serverUrl: settings.cosyvoiceServerUrl,
    bundledReady:
      fs.existsSync(bundled.python) &&
      fs.existsSync(bundled.repo) &&
      fs.existsSync(path.join(modelDir, 'llm.pt')) &&
      fs.existsSync(path.join(modelDir, 'flow.pt')) &&
      fs.existsSync(path.join(modelDir, 'hift.pt'))
  }
}

async function health(): Promise<{ ok: boolean; error?: string } | null> {
  const url = getRuntimeConfig().cosyvoiceServerUrl.replace(/\/$/, '') + '/health'
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) })
    if (!response.ok) return null
    return (await response.json()) as { ok: boolean; error?: string }
  } catch {
    return null
  }
}

export async function ttsStatus(): Promise<TtsStatus> {
  const voice = voiceConfig()
  const live = await health()
  const detail =
    phase === 'loading'
      ? '正在加载 CosyVoice，第一次大约要半分钟'
      : live?.ok
        ? `${voice.version} 已就绪，可以试听英文`
        : !voice.bundledReady
          ? fs.existsSync(voice.python)
            ? '权重需要自行下载。放到下方目录后，再点启动。'
            : '没有找到 CosyVoice 的 Python 环境'
          : `已内置 ${voice.version}。点「启动 CosyVoice」或「试听英文」开始加载`
  return {
    engine: live?.ok ? 'cosyvoice' : 'system',
    version: voice.version,
    serverUrl: voice.serverUrl,
    running: Boolean(live?.ok),
    detail,
    python: voice.python,
    repo: voice.repo,
    modelDir: voice.modelDir,
    weightsDir: userModelDir(voice.version),
    bundledReady: voice.bundledReady
  }
}

export function startTts(): Promise<TtsStatus> {
  if (boot) return boot
  phase = 'loading'
  boot = launchTts()
    .then((status) => {
      phase = status.running ? 'ready' : 'idle'
      return status
    })
    .catch((error: unknown) => {
      phase = 'idle'
      throw error
    })
    .finally(() => {
      boot = null
    })
  return boot
}

async function launchTts(): Promise<TtsStatus> {
  const voice = voiceConfig()
  if (!fs.existsSync(voice.python) || !fs.existsSync(voice.repo) || !fs.existsSync(voice.modelDir)) {
    throw new Error('内置 CosyVoice 环境或权重不完整，无法在这台 Mac 上启动')
  }
  const port = new URL(voice.serverUrl).port || '8765'
  if (child && !child.killed && loadedVersion === voice.version) return ttsStatus()
  if (child && !child.killed) {
    child.kill('SIGKILL')
    child = null
    loadedVersion = null
  }
  if (loadedVersion === voice.version && (await health())?.ok) return ttsStatus()
  await reclaimPort(port)
  const prompt = voicePrompt(voice.repo)
  if (!fs.existsSync(prompt.wav)) throw new Error('找不到 CosyVoice 自带的参考录音')
  const script = ttsScriptPath()
  const env = { ...process.env }
  delete env.VIRTUAL_ENV
  delete env.PYTHONHOME
  env.PYTHONNOUSERSITE = '1'
  env.PYTHONDONTWRITEBYTECODE = '1'
  env.PYTORCH_ENABLE_MPS_FALLBACK = '1'
  env.PATH = `${path.dirname(voice.python)}:${env.PATH || ''}`
  const logPath = path.join(ensureDir(path.join(userRoot(), 'voice')), 'tts.log')
  fs.appendFileSync(logPath, `\n--- ${new Date().toISOString()} ${voice.version} ---\n`)
  const logFd = fs.openSync(logPath, 'a')
  child = spawn(
    voice.python,
    [
      script,
      '--port',
      port,
      '--repo',
      voice.repo,
      '--model-dir',
      voice.modelDir,
      '--version',
      voice.version,
      '--prompt-wav',
      prompt.wav,
      '--prompt-text',
      prompt.text
    ],
    { cwd: voice.repo, env, stdio: ['ignore', logFd, logFd] }
  )
  fs.closeSync(logFd)
  child.on('exit', () => {
    child = null
  })
  return waitForModel(logPath)
}

function listenerPids(port: string): Promise<number[]> {
  return new Promise((resolve) => {
    execFile('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], (error, stdout) => {
      if (error) {
        resolve([])
        return
      }
      resolve(
        String(stdout)
          .trim()
          .split(/\s+/)
          .map(Number)
          .filter((id) => id > 0 && id !== process.pid)
      )
    })
  })
}

async function reclaimPort(port: string): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < 5000) {
    const pids = await listenerPids(port)
    if (!pids.length) return
    for (const id of pids) {
      try {
        process.kill(id, 'SIGKILL')
      } catch {
        /* 旧进程已经退出 */
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`端口 ${port} 仍被占用。请完全退出应用后再打开。`)
}

function logTail(logPath: string): string {
  try {
    return fs.readFileSync(logPath, 'utf8').slice(-1500)
  } catch {
    return ''
  }
}

async function waitForModel(logPath: string): Promise<TtsStatus> {
  const started = Date.now()
  while (Date.now() - started < 180000) {
    if (!child) {
      const notes = logTail(logPath)
      console.error(notes)
      if (/Address already in use|Errno 48/.test(notes)) throw new Error('朗读端口仍被占用。请再点一次。')
      const line = notes.trim().split('\n').filter(Boolean).at(-1) || ''
      throw new Error(line ? `CosyVoice 没有启动起来：${line.slice(0, 180)}` : 'CosyVoice 没有启动起来')
    }
    const live = await health()
    if (live?.ok) {
      loadedVersion = voiceConfig().version
      phase = 'ready'
      return ttsStatus()
    }
    if (live?.error) throw new Error(live.error.slice(-800))
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('CosyVoice 加载超过 3 分钟，仍未就绪')
}

export async function stopTts(): Promise<TtsStatus> {
  phase = 'idle'
  loadedVersion = null
  if (child && !child.killed) child.kill('SIGKILL')
  child = null
  const port = new URL(getRuntimeConfig().cosyvoiceServerUrl).port || '8765'
  await reclaimPort(port).catch(() => undefined)
  return ttsStatus()
}

export async function speak(text: string): Promise<{ engine: string; audioBase64: string; mime: string }> {
  const spoken = text.trim().slice(0, 500)
  if (!spoken) throw new Error('没有可朗读的文字')
  const voice = voiceConfig()
  if (!voice.bundledReady) throw new Error('CosyVoice 权重不完整，已停止使用系统语音')
  if (loadedVersion !== voice.version || !(await health())?.ok) await startTts()
  const response = await fetch(voice.serverUrl.replace(/\/$/, '') + '/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: spoken })
  })
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(detail.slice(0, 400) || 'CosyVoice 没有合成出声音')
  }
  const audio = Buffer.from(await response.arrayBuffer())
  return { engine: voice.version, audioBase64: audio.toString('base64'), mime: 'audio/wav' }
}
