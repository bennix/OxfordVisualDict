import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
const CHROMIUM = '143.0.3650.75'

function secMsGec(): string {
  const ticks = Math.floor((Date.now() / 1000 + 11644473600) * 1e7)
  const rounded = ticks - (ticks % 3_000_000_000)
  return crypto.createHash('sha256').update(`${rounded}${TOKEN}`).digest('hex').toUpperCase()
}

function timestamp(): string {
  const date = new Date()
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${days[date.getUTCDay()]} ${months[date.getUTCMonth()]} ${pad(date.getUTCDate())} ${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`
}

function voiceFor(text: string): { name: string; lang: string } {
  const han = (text.match(/[\u3400-\u9fff]/g) || []).length
  const latin = (text.match(/[A-Za-z]/g) || []).length
  if (han > latin) return { name: 'zh-CN-XiaoxiaoNeural', lang: 'zh-CN' }
  return { name: 'en-US-AriaNeural', lang: 'en-US' }
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

async function toBuffer(data: unknown): Promise<Buffer | null> {
  if (typeof data === 'string' || data == null) return null
  if (Buffer.isBuffer(data)) return data
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  if (typeof data === 'object' && 'arrayBuffer' in data && typeof data.arrayBuffer === 'function') {
    return Buffer.from(await data.arrayBuffer())
  }
  return null
}

function mp3ToWav(mp3: Buffer): Buffer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-tts-'))
  const source = path.join(dir, 'in.mp3')
  const dest = path.join(dir, 'out.wav')
  try {
    fs.writeFileSync(source, mp3)
    execFileSync('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@24000', source, dest], { stdio: 'pipe' })
    const wav = fs.readFileSync(dest)
    if (wav.length < 44 || wav.subarray(0, 4).toString() !== 'RIFF') throw new Error('微软 Edge 语音转成 WAV 失败')
    return wav
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

export async function speakEdge(text: string): Promise<Buffer> {
  const spoken = text.trim()
  if (!spoken) throw new Error('没有可朗读的文字')
  const voice = voiceFor(spoken)
  const stamp = timestamp()
  const major = CHROMIUM.split('.')[0]
  const url =
    'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1' +
    `?TrustedClientToken=${TOKEN}&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=1-${CHROMIUM}` +
    `&ConnectionId=${crypto.randomUUID().replace(/-/g, '')}`
  const ssml =
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${voice.lang}'>` +
    `<voice name='${voice.name}'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>${escapeXml(spoken)}</prosody></voice></speak>`
  const config =
    `X-Timestamp:${stamp}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
    '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":false,"wordBoundaryEnabled":false},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}'
  const request =
    `X-RequestId:${crypto.randomUUID().replace(/-/g, '')}\r\nContent-Type:application/ssml+xml\r\n` +
    `X-Timestamp:${stamp}\r\nPath:ssml\r\n\r\n${ssml}`

  const mp3 = await new Promise<Buffer>((resolve, reject) => {
    const Socket = WebSocket as unknown as new (
      address: string,
      options?: { headers?: Record<string, string> }
    ) => WebSocket
    const ws = new Socket(url, {
      headers: {
        'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36 Edg/${major}.0.0.0`,
        Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        Pragma: 'no-cache',
        'Cache-Control': 'no-cache'
      }
    })
    const chunks: Buffer[] = []
    let settled = false
    const finish = (error?: Error, audio?: Buffer) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ws.close()
      if (error) reject(error)
      else resolve(audio || Buffer.alloc(0))
    }
    const timer = setTimeout(() => finish(new Error('微软 Edge 语音没有在 20 秒内返回')), 20000)
    ws.addEventListener('open', () => {
      ws.send(config)
      ws.send(request)
    })
    ws.addEventListener('error', () => finish(new Error('连不上微软 Edge 语音，请检查网络')))
    ws.addEventListener('message', (event) => {
      void (async () => {
        if (typeof event.data === 'string') {
          if (event.data.includes('Path:turn.end')) {
            const audio = Buffer.concat(chunks)
            if (audio.length < 64) finish(new Error('微软 Edge 语音没有返回音频'))
            else finish(undefined, audio)
          }
          return
        }
        const buf = await toBuffer(event.data)
        if (!buf || buf.length < 2) return
        const headerLength = buf.readUInt16BE(0)
        if (headerLength <= 0 || headerLength + 2 > buf.length) return
        const header = buf.subarray(2, 2 + headerLength).toString('utf8')
        if (header.includes('Path:audio')) chunks.push(buf.subarray(2 + headerLength))
      })().catch((error: unknown) => finish(error instanceof Error ? error : new Error('微软 Edge 语音合成失败')))
    })
  })
  return mp3ToWav(mp3)
}
