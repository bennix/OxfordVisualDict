import type { DictApi } from '../shared/types'

declare global {
  interface Window {
    dict: DictApi
  }
}

export {}
