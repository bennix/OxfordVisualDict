# 图解词典

给 Apple 芯片 Mac 的本地图解词典阅读器：翻扫描页、点读、中英讲解，并把读过的声音留在历史里。

下载页：[docs/index.html](docs/index.html)

## 开发

```bash
npm install
npm run dev
```

## 安装包

```bash
npm run dist
```

会用 Developer ID 签名并公证，产物在 `release/OxfordVisualDict-1.0.0-arm64.dmg`。

公证需要本机钥匙串里的 Developer ID Application 证书，以及环境变量 `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`。不要把专用密码写进仓库。

语音权重不放进安装包。CosyVoice 3：<https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512> ，镜像 <https://hf-mirror.com/FunAudioLLM/Fun-CosyVoice3-0.5B-2512> 。CosyVoice 2：<https://huggingface.co/FunAudioLLM/CosyVoice2-0.5B> ，镜像 <https://hf-mirror.com/FunAudioLLM/CosyVoice2-0.5B> 。解压到应用设置里打开的权重目录，使 `llm.pt`、`flow.pt`、`hift.pt` 就在该目录下。

公开发布的安装包不含词典扫描件。那是受版权保护的书，不能放进公开下载。
