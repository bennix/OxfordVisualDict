import type { Entry } from '@shared/types'

export function explainPrompt(word: string, entry?: Pick<Entry, 'topic' | 'subtopic'> | null): string {
  const place = entry?.topic
    ? `它出现在主题「${entry.topic}」${entry.subtopic ? `的「${entry.subtopic}」` : ''}。`
    : ''
  return [
    `请讲解「${word}」。${place}`,
    '请严格按这个模板回答，不要改标题。释义、例句、场景都要中英文对照，每条例句先写英文，下一行写对应中文。',
    '',
    '## 释义',
    '**中文：** ',
    '**English：** ',
    '',
    '## 例句',
    '1. EN: ',
    '   中文：',
    '2. EN: ',
    '   中文：',
    '3. EN: ',
    '   中文：',
    '',
    '## 使用场景',
    '**中文：** ',
    '**English：** ',
    '',
    '## 搭配与注意',
    '- '
  ].join('\n')
}
