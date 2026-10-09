export type ZhGloss = { zh: string; en: string }

export type ZhNext = { label: string; append: string; count: number }

export type ZhCandidate = { zh: string; en: string; score: number; why: string }

const LINES = `
人 people
女人 woman
男人 man
丈夫 husband
妻子 wife
婴儿 baby
父母 parents
孩子 children
男孩 boy
女孩 girl
祖父母 grandparents
孙女 granddaughter
孙子 grandson
家庭 family
朋友 friend
邻居 neighbor
浴室 bathroom
浴缸 bathtub
浴帘 shower curtain
浴帽 shower cap
浴垫 bath mat
浴巾 bath towel
毛巾 towel
毛巾架 towel rack
手巾 hand towel
牙刷 toothbrush
牙膏 toothpaste
肥皂 soap
洗发水 shampoo
吹风机 hair dryer
马桶 toilet
卫生纸 toilet paper
水槽 sink
水龙头 faucet
厨房 kitchen
炉子 stove
冰箱 refrigerator
锅 pot
碗 bowl
盘子 plate
杯子 cup
叉子 fork
刀子 knife
勺子 spoon
桌子 table
椅子 chair
床 bed
枕头 pillow
毯子 blanket
灯 lamp
门 door
窗 window
房子 house
房间 room
客厅 living room
卧室 bedroom
屋顶 roof
楼梯 stairs
花园 garden
衣服 clothes
衬衫 shirt
裤子 pants
裙子 dress
外套 coat
鞋子 shoes
袜子 socks
帽子 hat
手套 glove
眼镜 glasses
手表 watch
食物 food
面包 bread
米饭 rice
肉 meat
鱼 fish
鸡蛋 egg
牛奶 milk
水果 fruit
苹果 apple
香蕉 banana
蔬菜 vegetable
水 water
咖啡 coffee
茶 tea
车 car
公共汽车 bus
自行车 bicycle
火车 train
飞机 airplane
船 boat
卡车 truck
马路 street
交通灯 traffic light
学校 school
老师 teacher
学生 student
书 book
笔 pen
纸 paper
图书馆 library
医院 hospital
医生 doctor
护士 nurse
药 medicine
病人 patient
头 head
头发 hair
脸 face
眼睛 eye
耳朵 ear
鼻子 nose
嘴 mouth
牙 tooth
手 hand
手指 finger
脚 foot
腿 leg
胳膊 arm
身体 body
心 heart
跑步 run
走 walk
跳 jump
游泳 swim
球 ball
网球 tennis
球拍 racket
篮球 basketball
足球 soccer
高尔夫球 golf
跑步者 runner
跑道 track
滑雪板 skis
音乐 music
钢琴 piano
吉他 guitar
鼓 drum
电话 telephone
电脑 computer
相机 camera
电视 television
钟 clock
钱 money
银行 bank
商店 store
邮局 post office
信 letter
警察 police
消防员 firefighter
树 tree
花 flower
草 grass
太阳 sun
月亮 moon
星 star
雨 rain
雪 snow
狗 dog
猫 cat
鸟 bird
马 horse
鱼缸 fish
颜色 color
红色 red
蓝色 blue
绿色 green
黄色 yellow
黑色 black
白色 white
大 big
小 small
热 hot
冷 cold
新 new
旧 old
`

export const ZH_SEED: ZhGloss[] = LINES.trim()
  .split('\n')
  .map((line) => {
    const split = line.trim().indexOf(' ')
    return { zh: line.trim().slice(0, split), en: line.trim().slice(split + 1) }
  })
  .filter((item) => item.zh && item.en)

export function suggestChineseLexicon(glosses: ZhGloss[], rawPrefix: string): {
  next: ZhNext[]
  exact: number
  matches: ZhCandidate[]
} {
  const prefix = rawPrefix.trim()
  if (!prefix) return { next: [], exact: 0, matches: [] }
  const counts = new Map<string, ZhNext>()
  const seen = new Set<string>()
  const matches: ZhCandidate[] = []
  let exact = 0
  for (const gloss of glosses) {
    if (!gloss.zh.startsWith(prefix)) continue
    const nextChar = gloss.zh[prefix.length] || ''
    const remaining = gloss.zh.length - prefix.length
    const score = (gloss.zh === prefix ? 100 : 90) - Math.min(remaining, 12)
    matches.push({
      ...gloss,
      score,
      why: nextChar ? `下一个字是「${nextChar}」` : '已经是完整的词'
    })
    if (seen.has(gloss.zh)) continue
    seen.add(gloss.zh)
    if (!nextChar) {
      exact += 1
      continue
    }
    const prev = counts.get(nextChar)
    if (prev) prev.count += 1
    else counts.set(nextChar, { label: nextChar, append: nextChar, count: 1 })
  }
  const next = [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh')).slice(0, 14)
  const rank = new Map(next.map((item, index) => [item.label, index]))
  matches.sort((a, b) => {
    const aNext = a.zh[prefix.length] || ''
    const bNext = b.zh[prefix.length] || ''
    if (!aNext && bNext) return -1
    if (aNext && !bNext) return 1
    return (rank.get(aNext) ?? 99) - (rank.get(bNext) ?? 99) || b.score - a.score || a.zh.localeCompare(b.zh, 'zh')
  })
  return { next, exact, matches }
}
