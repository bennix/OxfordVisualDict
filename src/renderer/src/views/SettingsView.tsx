import { useEffect, useState } from 'react'
import { INVITE_URL } from '@shared/types'
import type { EmbedStatus, PublicSettings, TtsStatus } from '@shared/types'
import { speakText } from '../lib/audio'
import { resetDictionary } from '../lib/pdf'

type Props = {
  settings: PublicSettings
  onChange: (settings: PublicSettings) => void
  onRebuildOcr: () => void
}

export function SettingsView({ settings, onChange, onRebuildOcr }: Props) {
  const [keyDraft, setKeyDraft] = useState('')
  const [chatDraft, setChatDraft] = useState('')
  const [embedDraft, setEmbedDraft] = useState('')
  const [embed, setEmbed] = useState<EmbedStatus | null>(null)
  const [tts, setTts] = useState<TtsStatus | null>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<'save' | 'test' | ''>('')
  const [voiceBusy, setVoiceBusy] = useState<'start' | 'stop' | 'speak' | ''>('')
  const [voiceNote, setVoiceNote] = useState('')
  const [downloading, setDownloading] = useState(false)
  const [keyNote, setKeyNote] = useState<{ ok: boolean; text: string } | null>(null)

  async function refresh(): Promise<void> {
    setEmbed(await window.dict.getEmbedStatus())
    setTts(await window.dict.getTtsStatus())
  }

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => {
      void window.dict.getTtsStatus().then(setTts)
    }, 1500)
    const off = window.dict.onEmbed((event) => {
      if (event.type === 'progress') {
        setEmbed((prev) => (prev ? { ...prev, building: true, progress: event.done, total: event.total } : prev))
      }
      if (event.type === 'done') void refresh()
      if (event.type === 'error') setError(event.message)
    })
    const offWeights = window.dict.onWeights((event) => {
      if (event.type === 'progress') setVoiceNote(`${event.label}（${Math.min(event.total, event.done).toFixed(1)}/${event.total}）`)
      if (event.type === 'done') {
        setVoiceNote('权重已下载，可以启动 CosyVoice')
        void window.dict.getTtsStatus().then(setTts)
      }
      if (event.type === 'error') setError(event.message)
    })
    return () => {
      window.clearInterval(timer)
      off()
      offWeights()
    }
  }, [])

  async function startVoice(): Promise<void> {
    setError('')
    setVoiceBusy('start')
    setVoiceNote('正在加载 CosyVoice，第一次大约要半分钟')
    try {
      const status = await window.dict.startTts()
      setTts(status)
      if (!status.running) throw new Error('CosyVoice 没有就绪')
      setVoiceNote('CosyVoice 已就绪，可以试听')
    } catch (reason: unknown) {
      const text = reason instanceof Error ? reason.message : String(reason)
      setVoiceNote(text)
      setError(text)
    } finally {
      setVoiceBusy('')
    }
  }

  async function stopVoice(): Promise<void> {
    setError('')
    setVoiceBusy('stop')
    try {
      setTts(await window.dict.stopTts())
      setVoiceNote('朗读服务已停止')
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setVoiceBusy('')
    }
  }

  async function previewEnglish(): Promise<void> {
    setError('')
    setVoiceBusy('speak')
    setVoiceNote('正在合成英文，第一次会先加载模型')
    try {
      const spoken = await speakText('The bus stop is on the corner.')
      setVoiceNote(`正在播放试听 · ${spoken.engine}`)
      setTts(await window.dict.getTtsStatus())
    } catch (reason: unknown) {
      const text = reason instanceof Error ? reason.message : String(reason)
      setVoiceNote(text)
      setError(text)
    } finally {
      setVoiceBusy('')
    }
  }

  async function saveKey(): Promise<void> {
    setKeyNote(null)
    setBusy('save')
    try {
      const next = await window.dict.setApiKey(keyDraft)
      onChange(next)
      setKeyDraft('')
      setKeyNote({ ok: true, text: `已加密保存在本机，界面只显示 ${next.apiKeyMask}` })
    } catch (reason: unknown) {
      setKeyNote({ ok: false, text: reason instanceof Error ? reason.message : String(reason) })
    } finally {
      setBusy('')
    }
  }

  async function testKey(): Promise<void> {
    const draft = keyDraft.trim()
    setKeyNote(null)
    setBusy('test')
    try {
      const check = await window.dict.verifyApiKey(draft || undefined)
      const where = draft ? '输入框中的密钥' : '已保存的密钥'
      setKeyNote({ ok: check.ok, text: `${where}：${check.message}` })
    } catch (reason: unknown) {
      setKeyNote({ ok: false, text: reason instanceof Error ? reason.message : String(reason) })
    } finally {
      setBusy('')
    }
  }

  return (
    <section className="panel settings">
      <header>
        <p className="eyebrow">设置</p>
        <h2>ZenMux、嵌入与 CosyVoice</h2>
      </header>

      <div className="card">
        <h3>API Key</h3>
        {settings.hasApiKey ? (
          <p className="mask">{settings.apiKeyMask}</p>
        ) : (
          <div className="invite">
            <p>还没有密钥。可以用邀请链接申请，密钥只保存在这台电脑，界面上只显示掩码。</p>
            <button className="solid" onClick={() => void window.dict.openExternal(INVITE_URL)}>
              打开邀请链接
            </button>
          </div>
        )}
        <label>
          {settings.hasApiKey ? '更换密钥' : '填入 API Key'}
          <input type="password" value={keyDraft} autoComplete="off" onChange={(event) => setKeyDraft(event.target.value)} />
        </label>
        <div className="row-actions">
          <button className="solid" onClick={() => void saveKey()} disabled={busy !== '' || !keyDraft.trim()}>
            {busy === 'save' ? '正在保存…' : '保存'}
          </button>
          <button className="solid key-test" onClick={() => void testKey()} disabled={busy !== '' || (!keyDraft.trim() && !settings.hasApiKey)}>
            {busy === 'test' ? '正在测试…' : '测试 API'}
          </button>
          {settings.hasApiKey && (
            <button
              disabled={busy !== ''}
              onClick={() => {
                void window.dict.setApiKey('').then((next) => {
                  onChange(next)
                  setKeyNote({ ok: true, text: '已清除本机密钥' })
                })
              }}
            >
              清除
            </button>
          )}
        </div>
        {keyNote && <p className={keyNote.ok ? 'key-feedback ok' : 'key-feedback bad'}>{keyNote.text}</p>}
        <label>
          Base URL
          <input value={settings.baseUrl} onChange={(event) => onChange({ ...settings, baseUrl: event.target.value })} onBlur={() => void window.dict.updateSettings({ baseUrl: settings.baseUrl }).then(onChange)} />
        </label>
      </div>

      <ModelEditor
        title="对话模型"
        models={settings.chatModels}
        current={settings.chatModel}
        draft={chatDraft}
        setDraft={setChatDraft}
        onPick={(chatModel) => void window.dict.updateSettings({ chatModel }).then(onChange)}
        onChange={(chatModels, chatModel) => void window.dict.updateSettings({ chatModels, chatModel }).then(onChange)}
      />
      <ModelEditor
        title="嵌入模型"
        models={settings.embeddingModels}
        current={settings.embeddingModel}
        draft={embedDraft}
        setDraft={setEmbedDraft}
        onPick={(embeddingModel) => void window.dict.updateSettings({ embeddingModel }).then(onChange)}
        onChange={(embeddingModels, embeddingModel) =>
          void window.dict.updateSettings({ embeddingModels, embeddingModel }).then(onChange)
        }
      />

      <div className="card">
        <h3>语义索引</h3>
        <p>
          {embed?.ready ? `当前模型 ${embed.model}，${embed.vectors} 条向量。` : '还没有向量索引。中文和模糊检索需要它。'}
          {embed?.building ? ` 正在写入 ${embed.progress} / ${embed.total}` : ''}
        </p>
        <button
          className="solid"
          onClick={() => {
            setError('')
            void window.dict.buildEmbeddings().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
          }}
        >
          重建向量索引
        </button>
      </div>

      <div className="card">
        <h3>CosyVoice 点读</h3>
        <p>{tts?.detail}</p>
        <p>点「一键下载权重」会把当前版本下载到本机目录。已经下完的文件会跳过，中断后可以再点一次继续。</p>
        <p>
          <button type="button" className="texty" onClick={() => void window.dict.openExternal('https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512')}>CosyVoice 3 官方</button>
          <button type="button" className="texty" onClick={() => void window.dict.openExternal('https://hf-mirror.com/FunAudioLLM/Fun-CosyVoice3-0.5B-2512')}>镜像</button>
          <button type="button" className="texty" onClick={() => void window.dict.openExternal('https://huggingface.co/FunAudioLLM/CosyVoice2-0.5B')}>CosyVoice 2 官方</button>
          <button type="button" className="texty" onClick={() => void window.dict.openExternal('https://hf-mirror.com/FunAudioLLM/CosyVoice2-0.5B')}>镜像</button>
        </p>
        {tts?.weightsDir && <p>放到 {tts.weightsDir}</p>}
        <label>
          版本
          <select
            value={settings.cosyvoiceVersion}
            onChange={(event) =>
              void window.dict
                .updateSettings({ cosyvoiceVersion: event.target.value as PublicSettings['cosyvoiceVersion'] })
                .then(async (next) => {
                  onChange(next)
                  setTts(await window.dict.getTtsStatus())
                })
            }
          >
            <option value="cosyvoice3">CosyVoice 3</option>
            <option value="cosyvoice2">CosyVoice 2</option>
          </select>
        </label>
        {tts?.bundledReady && (
          <p>
            环境 {tts.python}
            <br />
            权重 {tts.modelDir}
          </p>
        )}
        <div className="row-actions voice-actions">
          <button
            className="solid"
            disabled={downloading}
            onClick={() => {
              setError('')
              setDownloading(true)
              setVoiceNote('开始下载权重')
              void window.dict
                .downloadWeights()
                .then(setTts)
                .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
                .finally(() => setDownloading(false))
            }}
          >
            {downloading ? '正在下载权重…' : '一键下载权重'}
          </button>
          <button className="line" onClick={() => void window.dict.revealVoiceDir().then((dir) => setVoiceNote(`权重目录 ${dir}`))}>
            打开权重目录
          </button>
          <button className="solid" disabled={voiceBusy !== ''} onClick={() => void startVoice()}>
            {voiceBusy === 'start' ? '正在启动…' : '启动 CosyVoice'}
          </button>
          <button className="line" disabled={voiceBusy !== ''} onClick={() => void stopVoice()}>
            {voiceBusy === 'stop' ? '正在停止…' : '停止服务'}
          </button>
          <button className="solid" disabled={voiceBusy !== ''} onClick={() => void previewEnglish()}>
            {voiceBusy === 'speak' ? '正在合成…' : '试听英文'}
          </button>
        </div>
        {voiceNote && <p className="voice-note">{voiceNote}</p>}
      </div>

      <div className="card">
        <h3>扫描识别</h3>
        <p>导入你自己持有的词典 PDF。导入后会重新识别，识别结果只留在本机。</p>
        <div className="row-actions">
          <button
            className="solid"
            onClick={() => {
              setError('')
              void window.dict
                .importPdf()
                .then((file) => {
                  if (!file) return
                  resetDictionary()
                  setMessage('已导入词典，开始识别')
                  onRebuildOcr()
                })
                .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
            }}
          >
            导入词典 PDF
          </button>
          <button onClick={onRebuildOcr}>重新识别全部页面</button>
        </div>
      </div>
      {message && <p className="note">{message}</p>}
      {error && <p className="error">{error}</p>}
    </section>
  )
}

function ModelEditor({
  title,
  models,
  current,
  draft,
  setDraft,
  onPick,
  onChange
}: {
  title: string
  models: string[]
  current: string
  draft: string
  setDraft: (value: string) => void
  onPick: (model: string) => void
  onChange: (models: string[], current: string) => void
}) {
  return (
    <div className="card">
      <h3>{title}</h3>
      <ul className="model-list">
        {models.map((model) => (
          <li key={model} className={model === current ? 'on' : ''}>
            <button type="button" className="model-pick" onClick={() => onPick(model)}>
              <span className="model-mark" />
              <span>{model}</span>
            </button>
            <button
              type="button"
              className="model-remove"
              onClick={() => {
                const next = models.filter((item) => item !== model)
                onChange(next, model === current ? next[0] || current : current)
              }}
            >
              移除
            </button>
          </li>
        ))}
      </ul>
      <form
        className="model-add"
        onSubmit={(event) => {
          event.preventDefault()
          const name = draft.trim()
          if (!name || models.includes(name)) return
          onChange([...models, name], name)
          setDraft('')
        }}
      >
        <input value={draft} placeholder="添加模型名称" onChange={(event) => setDraft(event.target.value)} />
        <button className="solid" type="submit" disabled={!draft.trim()}>
          添加
        </button>
      </form>
    </div>
  )
}
