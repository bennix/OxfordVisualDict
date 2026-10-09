import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist'
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

GlobalWorkerOptions.workerSrc = workerSrc

let loading: Promise<PDFDocumentProxy> | null = null

export function resetDictionary(): void {
  loading = null
}

export function loadDictionary(): Promise<PDFDocumentProxy> {
  if (!loading) {
    loading = window.dict.readPdf().then((bytes) => {
      const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
      return getDocument({ data }).promise
    })
  }
  return loading
}
