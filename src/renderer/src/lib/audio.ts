let generation = 0
let playlist: HTMLAudioElement[] = []

function stopPlayback(): void {
  generation += 1
  for (const audio of playlist) audio.pause()
  playlist = []
}

function playWhenReady(audio: HTMLAudioElement, previous: Promise<void>, token: number): Promise<void> {
  return previous.then(
    () =>
      new Promise((resolve) => {
        if (token !== generation) {
          resolve()
          return
        }
        audio.onended = () => resolve()
        audio.onerror = () => resolve()
        void audio.play().catch(() => resolve())
      })
  )
}

export async function speakText(text: string): Promise<{ engine: string; clip: SpeechClip }> {
  stopPlayback()
  const token = generation
  const result = await window.dict.speak(text)
  const src = `data:${result.mime};base64,${result.audioBase64}`
  const clip = { line: text, src }
  if (token !== generation) return { engine: result.engine, clip }
  const audio = new Audio(src)
  playlist = [audio]
  await playWhenReady(audio, Promise.resolve(), token)
  return { engine: result.engine, clip }
}

export type SpeechProgress = {
  index: number
  total: number
  line: string
}

export type SpeechClip = {
  line: string
  src: string
}

export async function replayClips(clips: SpeechClip[]): Promise<void> {
  stopPlayback()
  const token = generation
  let playback = Promise.resolve()
  for (const clip of clips) {
    if (token !== generation) return
    const audio = new Audio(clip.src)
    playlist.push(audio)
    playback = playWhenReady(audio, playback, token)
  }
  await playback
}

export async function speakLines(
  lines: string[],
  onProgress: (progress: SpeechProgress) => void
): Promise<{ engine: string; clips: SpeechClip[] }> {
  stopPlayback()
  const token = generation
  let engine = ''
  const clips: SpeechClip[] = []
  let playback = Promise.resolve()
  for (let index = 0; index < lines.length; index += 1) {
    if (token !== generation) return { engine, clips }
    const line = lines[index]
    onProgress({ index: index + 1, total: lines.length, line })
    const result = await window.dict.speak(line)
    if (token !== generation) return { engine: result.engine, clips }
    engine = result.engine
    const src = `data:${result.mime};base64,${result.audioBase64}`
    clips.push({ line, src })
    const audio = new Audio(src)
    playlist.push(audio)
    playback = playWhenReady(audio, playback, token)
  }
  await playback
  return { engine, clips }
}

export function speechLines(markdown: string): string[] {
  const lines: string[] = []
  for (const raw of markdown.split('\n')) {
    let line = raw.trim()
    if (!line || line.startsWith('```')) continue
    line = line.replace(/^#{1,6}\s*/, '')
    line = line.replace(/^[-*]\s+/, '')
    line = line.replace(/^\d+\.\s*/, '')
    line = line.replace(/\*\*/g, '').replace(/`/g, '')
    line = line.replace(/^(EN|English|中文)\s*[:：]\s*/i, '')
    line = line.trim()
    if (!line || /^(EN|English|中文)\s*[:：]?$/i.test(line)) continue
    if (!/[\u4e00-\u9fffA-Za-z]/.test(line)) continue
    lines.push(line.slice(0, 220))
  }
  return lines.slice(0, 16)
}
