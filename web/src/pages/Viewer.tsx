import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Papa from 'papaparse'
import { FixedSizeList as List, ListOnItemsRenderedProps } from 'react-window'
import * as XLSX from 'xlsx'
import './viewer.css'
import CustomSelect from '../components/CustomSelect'

type EngineMode = 'auto' | 'engine' | 'frontend'

const TABLE_HEADER_FALLBACK_PX = 42
const TABLE_SPLIT_MIN_HEIGHT_PX = 280
const TABLE_TOP_RESERVED_PX = 360

const ENCODING_OPTIONS = [
  { value: 'utf8', label: 'UTF-8' },
  { value: 'utf16le', label: 'UTF-16 LE' },
  { value: 'utf16be', label: 'UTF-16 BE' },
  { value: 'gb18030', label: 'GB18030' },
  { value: 'gbk', label: 'GBK' },
  { value: 'gb2312', label: 'GB2312' },
  { value: 'big5', label: 'Big5（繁体）' },
  { value: 'shift_jis', label: 'Shift_JIS（日文）' },
  { value: 'euc-jp', label: 'EUC-JP（日文）' },
  { value: 'euc-kr', label: 'EUC-KR（韩文）' },
  { value: 'windows-1252', label: 'Windows-1252（西欧）' },
  { value: 'iso-8859-1', label: 'ISO-8859-1（Latin-1）' },
  { value: 'windows-1251', label: 'Windows-1251（西里尔）' },
]

function measureTableBodyHeight(splitEl: HTMLElement | null) {
  if (!splitEl) return 360
  const splitH = splitEl.getBoundingClientRect().height
  if (splitH <= 0) return 360
  const headerEl = splitEl.querySelector<HTMLElement>('.table-header')
  const headerH = headerEl
    ? Math.ceil(headerEl.getBoundingClientRect().height)
    : TABLE_HEADER_FALLBACK_PX
  return Math.max(120, Math.floor(splitH - headerH))
}

function formatBytes(bytes: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = bytes
  let idx = 0
  while (v >= 1024 && idx < units.length - 1) {
    v /= 1024
    idx++
  }
  return `${v.toFixed(v >= 10 || idx === 0 ? 0 : 1)} ${units[idx]}`
}

function clampInt(v: number, min: number, max: number) {
  const n = Math.trunc(v)
  return Math.min(max, Math.max(min, n))
}

function formatEtaSeconds(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec)) return '计算中…'
  if (sec < 1) return '不到 1 秒'
  if (sec < 60) return `约 ${Math.ceil(sec)} 秒`
  const m = Math.floor(sec / 60)
  const s = Math.ceil(sec % 60)
  if (m >= 60) {
    const h = Math.floor(m / 60)
    const mm = m % 60
    return `约 ${h} 小时 ${mm} 分`
  }
  return `约 ${m} 分 ${s} 秒`
}

function formatSpeedBps(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return '—'
  return `${formatBytes(bps)}/s`
}

function formatDurationFromMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const sec = ms / 1000
  if (sec < 60) return sec < 10 ? `${sec.toFixed(1)} 秒` : `${Math.round(sec)} 秒`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  if (m < 60) return `${m} 分 ${s} 秒`
  const h = Math.floor(m / 60)
  const mm = m % 60
  return `${h} 小时 ${mm} 分`
}

type EngineUploadProgress = {
  loaded: number
  total: number
  percent: number
  speedBps: number
  etaSec: number | null
  elapsedMs: number
}

function engineUploadCsvWithProgress(
  file: File,
  opts: { hasHeader: boolean; delimiter: string; encoding: string },
  onProgress: (p: EngineUploadProgress) => void,
  xhrRef: { current: XMLHttpRequest | null },
  startMsRef: { current: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const fd = new FormData()
    fd.append('file', file, file.name)
    fd.append('hasHeader', String(opts.hasHeader))
    fd.append('delimiter', opts.delimiter)
    fd.append('encoding', opts.encoding)

    const xhr = new XMLHttpRequest()
    xhrRef.current = xhr
    startMsRef.current = performance.now()

    const emit = (e: ProgressEvent) => {
      const total = e.lengthComputable ? e.total : file.size
      const loaded = e.loaded
      const elapsedMs = performance.now() - startMsRef.current
      const elapsedSec = elapsedMs / 1000
      const speedBps = elapsedSec > 0.05 ? loaded / elapsedSec : 0
      const remaining = total - loaded
      const etaSec = speedBps > 0 && total > 0 ? remaining / speedBps : null
      const percent = total > 0 ? (loaded / total) * 100 : 0
      onProgress({ loaded, total, percent, speedBps, etaSec, elapsedMs })
    }

    xhr.upload.addEventListener('progress', emit)

    xhr.addEventListener('load', () => {
      xhrRef.current = null
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText) as { uploadId: string }
          resolve(data.uploadId)
        } catch (err) {
          reject(err)
        }
      } else {
        reject(new Error(`engine upload failed: ${xhr.status}`))
      }
    })
    xhr.addEventListener('error', () => {
      xhrRef.current = null
      reject(new Error('upload network error'))
    })
    xhr.addEventListener('abort', () => {
      xhrRef.current = null
      reject(new Error('cancelled'))
    })

    xhr.open('POST', '/api/upload')
    xhr.send(fd)
  })
}

const MAX_COLUMNS_RENDER = 50
const MAX_PREVIEW_ROWS_FRONTEND = 20000
const PAGE_SIZE = 200
const VIEW_AHEAD_PAGES = 2

const QUICK_PREVIEW_HEAD_BYTES = 32 * 1024 * 1024

async function fileSliceHeadToLastNewline(file: File, maxBytes: number): Promise<File> {
  const n = Math.min(file.size, maxBytes)
  if (n <= 0) {
    return new File([], file.name, { type: file.type, lastModified: file.lastModified })
  }
  const blob = file.slice(0, n)
  let text = await blob.text()
  const lastLf = text.lastIndexOf('\n')
  if (lastLf >= 0) {
    text = text.slice(0, lastLf + 1)
  }
  return new File([text], file.name, { type: file.type, lastModified: file.lastModified })
}

async function engineGetStatus(uploadId: string) {
  const resp = await fetch(`/api/status?uploadId=${encodeURIComponent(uploadId)}`)
  if (!resp.ok) throw new Error(`engine status failed: ${resp.status}`)
  return (await resp.json()) as {
    uploadId: string
    indexState: string
    indexedUntilRow: number
    totalRows: number | null
    columns: string[] | null
  }
}

async function engineGetStats(uploadId: string) {
  const resp = await fetch(`/api/stats?uploadId=${encodeURIComponent(uploadId)}`)
  if (!resp.ok) throw new Error(`engine stats failed: ${resp.status}`)
  return (await resp.json()) as {
    uploadId: string
    state: string
    rowCount: number
    columns: string[]
  }
}

async function engineGetRows(uploadId: string, start: number, count: number) {
  const resp = await fetch(`/api/rows?uploadId=${encodeURIComponent(uploadId)}&start=${start}&count=${count}`)
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`engine rows failed: ${resp.status} ${text}`)
  }
  const data = (await resp.json()) as {
    start: number
    count: number
    rows: string[][]
    state?: string
    indexedUntilRow?: number
    totalRows?: number | null
  }
  return data
}

async function engineStartIndex(uploadId: string) {
  const resp = await fetch(`/api/index?uploadId=${encodeURIComponent(uploadId)}`, { method: 'POST' })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`engine start index failed: ${resp.status} ${text}`)
  }
  return (await resp.json()) as { ok: boolean; uploadId: string }
}

function fileExtLower(name: string) {
  const i = name.lastIndexOf('.')
  if (i < 0) return ''
  return name.slice(i + 1).toLowerCase()
}

function isXlsxFile(f: File) {
  return fileExtLower(f.name) === 'xlsx'
}

async function parseXlsxTo2D(file: File) {
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { type: 'array' })
  const sheetName = wb.SheetNames?.[0]
  if (!sheetName) return [] as any[][]
  const ws = wb.Sheets[sheetName]
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' }) as any[][]
}

function Modal(props: { title: string; children: React.ReactNode; actions: React.ReactNode }) {
  return (
    <div className="overlay" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="modal-title" style={{ fontSize: 24 }}>{props.title}</div>
        <div style={{ marginTop: 10, color: 'var(--muted)', lineHeight: 1.75, fontSize: 16 }}>{props.children}</div>
        <div className="modal-actions">{props.actions}</div>
      </div>
    </div>
  )
}

export default function Viewer() {
  const navigate = useNavigate()
  const [thresholdMB, setThresholdMB] = useState(200)
  const [engineMode, setEngineMode] = useState<EngineMode>('auto')

  const [file, setFile] = useState<File | null>(null)
  const [fileSizeText, setFileSizeText] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [hasHeader, setHasHeader] = useState(true)
  const [delimiter, setDelimiter] = useState(',')
  const [encoding, setEncoding] = useState('utf8')

  const [showEnginePrompt, setShowEnginePrompt] = useState(false)
  const [showReparseConfirm, setShowReparseConfirm] = useState(false)
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [activeParseMode, setActiveParseMode] = useState<'frontend' | 'engine' | null>(null)

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [frontendParsedRows, setFrontendParsedRows] = useState(0)
  const [enginePhase, setEnginePhase] = useState<
    'upload' | 'uploaded' | 'count' | 'firstLoad' | 'ready' | 'idle'
  >('idle')

  const frontendParserRef = useRef<any>(null)
  const parseTokenRef = useRef(0)
  const uploadXhrRef = useRef<XMLHttpRequest | null>(null)
  const uploadStartMsRef = useRef(0)
  const [uploadProgress, setUploadProgress] = useState<EngineUploadProgress | null>(null)
  const [headPreviewOnly, setHeadPreviewOnly] = useState(false)

  // Frontend parsed data
  const [columns, setColumns] = useState<string[]>([])
  const [rows, setRows] = useState<string[][]>([])
  const [totalRows, setTotalRows] = useState<number>(0)
  const [frontendTruncated, setFrontendTruncated] = useState(false)

  // Engine mode state
  const [uploadId, setUploadId] = useState<string | null>(null)
  const [engineColumns, setEngineColumns] = useState<string[] | null>(null)
  const [engineTotalRows, setEngineTotalRows] = useState<number>(0)
  const [engineBufferStart, setEngineBufferStart] = useState(0)
  const [engineBufferRows, setEngineBufferRows] = useState<string[][]>([])
  const [engineLoadingRange, setEngineLoadingRange] = useState(false)

  // 虚拟滚动列表：左侧行号 + 右侧数据，两套 List 联动
  const indexListRef = useRef<List>(null)
  const listRef = useRef<List>(null)
  const previewIndexListRef = useRef<List>(null)
  const previewListRef = useRef<List>(null)
  const previewCardRef = useRef<HTMLDivElement | null>(null)
  const mainTableSplitRef = useRef<HTMLDivElement | null>(null)
  const previewTableSplitRef = useRef<HTMLDivElement | null>(null)
  const [mainListHeight, setMainListHeight] = useState(360)
  const [previewListHeight, setPreviewListHeight] = useState(360)

  const [viewportH, setViewportH] = useState(() => (typeof window !== 'undefined' ? window.innerHeight : 900))
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewMode, setPreviewMode] = useState<'zoom' | 'fullscreen'>('zoom')

  const visibleColumns = useMemo(() => {
    if (columns.length === 0) return []
    return columns.slice(0, MAX_COLUMNS_RENDER)
  }, [columns])

  const effectiveColumns = useMemo(() => {
    if (activeParseMode === 'engine') {
      const cols = engineColumns ?? []
      return cols.slice(0, MAX_COLUMNS_RENDER)
    }
    return visibleColumns
  }, [activeParseMode, engineColumns, visibleColumns])

  const colWidth = 170
  const indexColWidth = 80
  const tableWidth = effectiveColumns.length * colWidth

  const currentTableColumnsCount = effectiveColumns.length

  function resetAll() {
    try {
      uploadXhrRef.current?.abort()
    } catch {
      // ignore
    }
    uploadXhrRef.current = null
    setUploadProgress(null)
    setHeadPreviewOnly(false)
    setFile(null)
    setFileSizeText('')
    setActiveParseMode(null)
    setError(null)
    setBusy(false)
    setShowEnginePrompt(false)
    setFrontendParsedRows(0)
    setEnginePhase('idle')
    parseTokenRef.current += 1
    frontendParserRef.current = null
    setColumns([])
    setRows([])
    setTotalRows(0)
    setFrontendTruncated(false)
    setUploadId(null)
    setEngineColumns(null)
    setEngineTotalRows(0)
    setEngineBufferStart(0)
    setEngineBufferRows([])
    setEngineLoadingRange(false)
    setPreviewOpen(false)
  }

  useEffect(() => {
    resetAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const onResize = () => setViewportH(window.innerHeight)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    const onFullscreenChange = () => {
      // 用户按 ESC 退出系统全屏时，同步关闭预览弹层
      if (!document.fullscreenElement) {
        setPreviewOpen(false)
      }
    }
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange)
  }, [])

  useEffect(() => {
    // 预览弹层打开时锁定背景页面滚动，避免“底层页面也在滚”
    const prevHtmlOverflow = document.documentElement.style.overflow
    const prevBodyOverflow = document.body.style.overflow
    if (previewOpen) {
      document.documentElement.style.overflow = 'hidden'
      document.body.style.overflow = 'hidden'
    } else {
      document.documentElement.style.overflow = prevHtmlOverflow
      document.body.style.overflow = prevBodyOverflow
    }
    return () => {
      document.documentElement.style.overflow = prevHtmlOverflow
      document.body.style.overflow = prevBodyOverflow
    }
  }, [previewOpen])

  const colWidthForRender = useMemo(() => {
    if (!previewOpen) return colWidth
    // 全屏与放大预览使用同一套表格尺度，避免体验割裂
    return Math.round(colWidth * 1.15)
  }, [previewOpen, colWidth])

  const itemSizeForRender = useMemo(() => {
    if (!previewOpen) return 32
    // 全屏与放大预览统一行高
    return 34
  }, [previewOpen])

  const tableSplitMaxHeight = useMemo(
    () => Math.max(TABLE_SPLIT_MIN_HEIGHT_PX, viewportH - TABLE_TOP_RESERVED_PX),
    [viewportH],
  )

  const listHeightForRender = previewOpen ? previewListHeight : mainListHeight

  async function parseFrontend(csvFile: File, options?: { headPreview?: boolean }) {
    const myToken = parseTokenRef.current
    setBusy(true)
    setError(null)
    setActiveParseMode('frontend')
    setHeadPreviewOnly(!!options?.headPreview)
    setFrontendParsedRows(0)
    setEnginePhase('idle')
    setColumns([])
    setRows([])
    setFrontendTruncated(false)
    setTotalRows(0)

    if (isXlsxFile(csvFile)) {
      try {
        const a2d = await parseXlsxTo2D(csvFile)
        if (parseTokenRef.current !== myToken) return

        const maxRows = MAX_PREVIEW_ROWS_FRONTEND
        const allRows = (a2d || []).map((r) => (Array.isArray(r) ? r : [r])) as any[][]
        const limited = allRows.slice(0, Math.min(allRows.length, maxRows + (hasHeader ? 1 : 0)))

        let dataRows = limited
        let maxCols = 0
        for (const r of limited) maxCols = Math.max(maxCols, (r as any[]).length)

        let cols: string[] = []
        if (hasHeader && limited.length > 0) {
          const headerRow = limited[0] as any[]
          cols = Array.from({ length: maxCols }, (_, i) => {
            const v = headerRow[i]
            return v === undefined || v === null || String(v) === '' ? `col${i + 1}` : String(v)
          })
          dataRows = limited.slice(1)
        } else {
          cols = Array.from({ length: maxCols }, () => '')
        }

        const normalized: string[][] = (dataRows as any[][]).map((arr) => {
          const rr = (arr || []).slice(0, cols.length)
          while (rr.length < cols.length) rr.push('')
          return rr.map((x) => String(x ?? ''))
        })

        setColumns(cols)
        setFrontendTruncated(normalized.length >= maxRows)
        setRows(normalized)
        setTotalRows(normalized.length)
        setFrontendParsedRows(normalized.length)
        setBusy(false)
        return
      } catch (e: any) {
        if (parseTokenRef.current !== myToken) return
        setError(e?.message || '解析 xlsx 失败')
        setBusy(false)
        return
      }
    }

    let fileToParse = csvFile
    if (options?.headPreview) {
      try {
        fileToParse = await fileSliceHeadToLastNewline(csvFile, QUICK_PREVIEW_HEAD_BYTES)
      } catch (e: any) {
        if (parseTokenRef.current !== myToken) return
        setError(e?.message || '读取文件片段失败')
        setBusy(false)
        return
      }
    }
    if (parseTokenRef.current !== myToken) return

    try {
      // 始终以「行数组」的形式解析，保证物理列顺序不受 header 配置影响
      const parsedRows: string[][] = []
      const maxRows = MAX_PREVIEW_ROWS_FRONTEND
      let columnsResolved: string[] | null = null
      let maxCols = 0

      frontendParserRef.current = Papa.parse(fileToParse, {
        // 不使用 Papa 的 header 模式，避免在「第一行当表头」配置错误时打乱原始列顺序
        header: false,
        delimiter,
        worker: false,
        skipEmptyLines: false,
        step: (results: any) => {
          if (parseTokenRef.current !== myToken) return
          if (parsedRows.length >= maxRows) {
            if (typeof results?.abort === 'function') results.abort()
            return
          }
          const data = results.data as string[]
          parsedRows.push(data)
          maxCols = Math.max(maxCols, data.length)
          if (parsedRows.length % 200 === 0 || parsedRows.length === maxRows) {
            setFrontendParsedRows(parsedRows.length)
          }
        },
        complete: (results: any) => {
          if (parseTokenRef.current !== myToken) return
          let dataRows = parsedRows

          // 根据 hasHeader 决定是否把第一行当作表头，但始终保持列物理顺序不变
          if (hasHeader && parsedRows.length > 0) {
            const headerRow = parsedRows[0]
            // 有表头模式：优先用第一行内容，空的才回退成 colN
            columnsResolved = headerRow.map((h, i) =>
              h === undefined || h === null || h === '' ? `col${i + 1}` : String(h),
            )
            dataRows = parsedRows.slice(1)
          } else {
            const colCount = maxCols || (parsedRows[0]?.length ?? 0)
            // 无表头模式：只需要占位列，不再渲染 "col1 / col2"，让表头显示为空白
            columnsResolved = Array.from({ length: colCount }, () => '')
          }

          const cols = columnsResolved || []
          setColumns(cols)

          const normalized: string[][] = dataRows.map((arr) => {
            const rr = arr.slice(0, cols.length)
            while (rr.length < cols.length) rr.push('')
            return rr.map((x) => String(x ?? ''))
          })

          const truncated = normalized.length >= maxRows
          setFrontendTruncated(truncated)
          setRows(normalized)
          setTotalRows(normalized.length)
          setFrontendParsedRows(normalized.length)
          setBusy(false)
          frontendParserRef.current = null
        },
        error: (err: any) => {
          if (parseTokenRef.current !== myToken) return
          setError(err?.message || 'parse frontend error')
          setBusy(false)
          frontendParserRef.current = null
        },
      })
    } catch (e: any) {
      if (parseTokenRef.current !== myToken) return
      setError(e?.message || String(e))
      setBusy(false)
      frontendParserRef.current = null
    }
  }

  async function uploadWithEngine(csvFile: File) {
    const myToken = parseTokenRef.current
    setHeadPreviewOnly(false)
    setBusy(true)
    setError(null)
    setActiveParseMode('engine')
    setEnginePhase('upload')
    setColumns([])
    setRows([])
    setTotalRows(0)
    setFrontendTruncated(false)
    setEngineColumns(null)
    setEngineTotalRows(0)
    setEngineBufferStart(0)
    setEngineBufferRows([])

    setUploadProgress({
      loaded: 0,
      total: csvFile.size,
      percent: 0,
      speedBps: 0,
      etaSec: null,
      elapsedMs: 0,
    })

    try {
      const uploadT0 = performance.now()
      const id = await engineUploadCsvWithProgress(
        csvFile,
        { hasHeader, delimiter, encoding },
        (p) => {
          if (parseTokenRef.current !== myToken) return
          setUploadProgress(p)
        },
        uploadXhrRef,
        uploadStartMsRef,
      )
      const uploadT1 = performance.now()
      console.log('[VoidCSV][engine] upload done', {
        uploadId: id,
        ms: Math.round(uploadT1 - uploadT0),
        file: csvFile.name,
        size: csvFile.size,
      })

      if (parseTokenRef.current !== myToken) return
      setUploadProgress(null)
      setUploadId(id)
      setEnginePhase('uploaded')
      setBusy(false)
    } catch (e: any) {
      if (parseTokenRef.current !== myToken) return
      setUploadProgress(null)
      const msg = e?.message || String(e)
      if (msg === 'cancelled') {
        setBusy(false)
        return
      }
      setError(msg)
      setBusy(false)
    }
  }

  async function startIndexWithEngine() {
    if (!uploadId) return
    const myToken = parseTokenRef.current
    const id = uploadId

    setBusy(true)
    setError(null)
    setEnginePhase('count')
    setEngineBufferStart(0)
    setEngineBufferRows([])
    setEngineTotalRows(0)

    try {
      // 手动触发后端渐进索引
      await engineStartIndex(id)

      let firstLoaded = false
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
      let lastStatusLogAt = 0

      while (parseTokenRef.current === myToken) {
        const st = await engineGetStatus(id)
        if (parseTokenRef.current !== myToken) return

        if (st.columns && st.columns.length > 0) {
          setEngineColumns(st.columns)
        }

        // indexedUntilRow 的语义：覆盖 data rows 索引范围 [0, indexedUntilRow)
        if (typeof st.indexedUntilRow === 'number') {
          setEngineTotalRows(st.indexedUntilRow)
        }

        const now = performance.now()
        if (now - lastStatusLogAt > 2000) {
          console.log('[VoidCSV][engine] status', {
            uploadId: id,
            indexState: st.indexState,
            indexedUntilRow: st.indexedUntilRow,
            columnsReady: !!st.columns?.length,
            totalRows: st.totalRows,
          })
          lastStatusLogAt = now
        }

        if (!firstLoaded && st.columns && st.columns.length > 0 && st.indexedUntilRow > 0) {
          setEnginePhase('firstLoad')
          const count = Math.min(PAGE_SIZE, st.indexedUntilRow)
          const loadT0 = performance.now()
          const first = await engineGetRows(id, 0, count)
          const loadT1 = performance.now()
          console.log('[VoidCSV][engine] first page loaded', {
            uploadId: id,
            ms: Math.round(loadT1 - loadT0),
            start: first.start,
            rowsReturned: first.rows.length,
            countRequested: count,
            indexedUntilRow: st.indexedUntilRow,
          })

          if (parseTokenRef.current !== myToken) return
          setEngineBufferStart(first.start)
          setEngineBufferRows(first.rows)
          setEnginePhase('ready')
          setBusy(false)
          firstLoaded = true
        }

        if (st.indexState === 'ready' && st.totalRows !== null) {
          setEngineTotalRows(st.totalRows)
          break
        }

        if (st.indexState === 'cancelled') throw new Error('cancelled')
        if (st.indexState === 'error') throw new Error('engine indexing error')

        await sleep(500)
      }
    } catch (e: any) {
      if (parseTokenRef.current !== myToken) return
      setError(e?.message || String(e))
      setBusy(false)
    }
  }

  // Virtual scroll fetch for engine mode
  async function onItemsRendered({ visibleStartIndex, visibleStopIndex }: ListOnItemsRenderedProps) {
    const myToken = parseTokenRef.current
    if (activeParseMode !== 'engine' || !uploadId) return
    if (!engineColumns) return
    // 当前 buffer 覆盖范围
    const bufEnd = engineBufferStart + engineBufferRows.length - 1
    const desiredStart = Math.floor(visibleStartIndex / PAGE_SIZE) * PAGE_SIZE
    const desiredEndNeeded = visibleStopIndex

    // 已覆盖则无需请求
    if (visibleStartIndex >= engineBufferStart && desiredEndNeeded <= bufEnd) return
    // 防抖：避免滚动抖动触发太多请求
    if (engineLoadingRange) return

    const start = clampInt(desiredStart, 0, Math.max(0, engineTotalRows - 1))
    const available = engineTotalRows - start
    const count = Math.min(PAGE_SIZE * VIEW_AHEAD_PAGES, Math.max(0, available))
    if (count <= 0) return
    setEngineLoadingRange(true)
    try {
      const res = await engineGetRows(uploadId, start, count)
      if (parseTokenRef.current !== myToken) return
      setEngineBufferStart(res.start)
      setEngineBufferRows(res.rows)
    } catch (e: any) {
      if (parseTokenRef.current !== myToken) return
      setError(e?.message || String(e))
    } finally {
      if (parseTokenRef.current === myToken) setEngineLoadingRange(false)
    }
  }

  function cancelParse() {
    if (!busy) return
    const mode = activeParseMode
    const id = uploadId

    if (mode === 'frontend') {
      try {
        if (typeof frontendParserRef.current?.abort === 'function') frontendParserRef.current.abort()
      } catch {
        // ignore
      }
    } else if (mode === 'engine') {
      if (enginePhase === 'upload') {
        try {
          uploadXhrRef.current?.abort()
        } catch {
          // ignore
        }
      } else if (id) {
        fetch(`/api/cancel?uploadId=${encodeURIComponent(id)}`, { method: 'POST' }).catch(() => {})
      }
    }
    resetAll()
  }

  const listCount = useMemo(() => {
    if (activeParseMode === 'engine') return engineTotalRows || 0
    return totalRows || 0
  }, [activeParseMode, engineTotalRows, totalRows])

  useEffect(() => {
    if (previewOpen) return
    const el = mainTableSplitRef.current
    if (!el) return

    const measure = () => setMainListHeight(measureTableBodyHeight(el))
    measure()

    const ro = new ResizeObserver(measure)
    ro.observe(el)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [previewOpen, activeParseMode, listCount, viewportH, busy, enginePhase])

  useEffect(() => {
    if (!previewOpen) return
    const el = previewTableSplitRef.current
    if (!el) return

    const measure = () => setPreviewListHeight(measureTableBodyHeight(el))
    measure()

    const ro = new ResizeObserver(measure)
    ro.observe(el)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [previewOpen, previewMode, activeParseMode, listCount, viewportH])

  const loadingTitle = useMemo(() => {
    if (!busy || !activeParseMode) return ''
    if (activeParseMode === 'frontend')
      return headPreviewOnly ? '快速预览（仅文件开头）' : '解析中（纯前端）'
    if (enginePhase === 'upload') return '上传文件到本地引擎'
    if (enginePhase === 'count') return '索引中（渐进）'
    if (enginePhase === 'firstLoad') return '加载首屏数据'
    if (enginePhase === 'ready') return '准备就绪'
    return '解析中'
  }, [busy, activeParseMode, enginePhase, headPreviewOnly])

  const loadingProgress = useMemo(() => {
    if (!busy || !activeParseMode) return 0
    if (activeParseMode === 'frontend') {
      const percent = (frontendParsedRows / MAX_PREVIEW_ROWS_FRONTEND) * 100
      return clampInt(percent, 0, 100)
    }
    if (activeParseMode === 'engine' && enginePhase === 'upload' && uploadProgress) {
      return clampInt(uploadProgress.percent, 0, 100)
    }
    if (enginePhase === 'upload') return 0
    if (enginePhase === 'count') return 45
    if (enginePhase === 'firstLoad') return 75
    if (enginePhase === 'ready') return 100
    return 30
  }, [busy, activeParseMode, frontendParsedRows, enginePhase, uploadProgress])

  const dataForRow = (rowIndex: number) => {
    if (activeParseMode === 'engine') {
      const local = rowIndex - engineBufferStart
      if (local < 0 || local >= engineBufferRows.length) return null
      return engineBufferRows[local]
    }
    return rows[rowIndex] ?? null
  }

  const renderRow = ({ index, style }: { index: number; style: React.CSSProperties }) => {
    const rowData = dataForRow(index)
    if (!rowData) {
      return (
        <div style={style} className="table-row">
          <div style={{ padding: '7px 10px', color: 'var(--muted)' }} />
        </div>
      )
    }

    const cols = effectiveColumns
    return (
      <div style={style} className="table-row">
        {cols.map((_, cIdx) => {
          const v = rowData[cIdx] ?? ''
          const display = v.length > 120 ? v.slice(0, 120) + '…' : v
          return (
            <div
              key={cIdx}
              className="table-cell"
              title={v}
              style={{ width: colWidthForRender, flex: `0 0 ${colWidthForRender}px` }}
            >
              {display}
            </div>
          )
        })}
      </div>
    )
  }

  const renderIndexRow = ({ index, style }: { index: number; style: React.CSSProperties }) => {
    return (
      <div style={style} className="table-row">
        <div
          className="table-cell index-cell"
          title={`第 ${index + 1} 行（当前视图行号，仅为本页面辅助列）`}
          style={{ width: indexColWidth, flex: `0 0 ${indexColWidth}px` }}
        >
          {index + 1}
        </div>
      </div>
    )
  }

  function openPreview(mode: 'zoom' | 'fullscreen') {
    setPreviewMode(mode)
    setPreviewOpen(true)
    // 等弹层渲染完成再处理滚动与全屏
    setTimeout(async () => {
      previewListRef.current?.scrollTo(0)
      if (mode === 'fullscreen') {
        try {
          const el = previewCardRef.current
          if (el && !document.fullscreenElement && el.requestFullscreen) {
            await el.requestFullscreen()
          }
        } catch {
          // 可能被浏览器策略拦截，保留浏览器内全屏样式即可
        }
      }
    }, 0)
  }

  async function closePreview() {
    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen()
      } catch {
        // ignore
      }
    }
    setPreviewOpen(false)
  }

  function handleFile(f: File) {
    if (busy) return
    resetAll()
    setFile(f)
    setFileSizeText(formatBytes(f.size))
    setError(null)

    // 选择策略
    const thresholdBytes = thresholdMB * 1024 * 1024
    if (isXlsxFile(f)) {
      setActiveParseMode('frontend')
      void parseFrontend(f)
      return
    }
    if (engineMode === 'auto') {
      if (f.size > thresholdBytes) setShowEnginePrompt(true)
      else {
        setActiveParseMode('frontend')
        parseFrontend(f)
      }
    } else if (engineMode === 'engine') {
      // 由用户点击「快速预览」或「完整上传」
    } else {
      parseFrontend(f)
    }
  }

  function isSameFile(a: File, b: File) {
    return a.name === b.name && a.size === b.size && a.lastModified === b.lastModified
  }

  function handleFileWithConfirm(f: File) {
    if (file && isSameFile(file, f)) {
      setPendingFile(f)
      setShowReparseConfirm(true)
      return
    }
    handleFile(f)
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] || null
    e.currentTarget.value = ''
    if (!f) return
    handleFileWithConfirm(f)
  }

  function confirmReparseSameFile() {
    const f = pendingFile
    setShowReparseConfirm(false)
    setPendingFile(null)
    if (!f) return
    handleFile(f)
  }

  function confirmEngine() {
    setShowEnginePrompt(false)
    if (!file) return
    uploadWithEngine(file)
  }

  function confirmFrontend() {
    setShowEnginePrompt(false)
    if (!file) return
    parseFrontend(file)
  }

  function quickPreviewHead() {
    if (!file || busy) return
    parseTokenRef.current += 1
    try {
      uploadXhrRef.current?.abort()
    } catch {
      // ignore
    }
    uploadXhrRef.current = null
    setUploadProgress(null)
    setUploadId(null)
    setEngineColumns(null)
    setEngineTotalRows(0)
    setEngineBufferStart(0)
    setEngineBufferRows([])
    setEnginePhase('idle')
    setShowEnginePrompt(false)
    setError(null)
    void parseFrontend(file, { headPreview: true })
  }

  function confirmQuickPreview() {
    setShowEnginePrompt(false)
    if (!file) return
    quickPreviewHead()
  }

  return (
    <div className="app-shell viewer-shell" style={{ fontSize: '150%' }}>
      <div className="viewer-page">
      <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 12 }}>
      <button type="button" className="btn" onClick={() => navigate('/')}>
        返回首页
      </button>
    </div>
    <div className="panel" style={{ padding: 20 }}>
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        gap: 12,
        alignItems: 'center',
        flexWrap: 'wrap',
      }}
    >
            <div>
              <div style={{ fontWeight: 900, fontSize: 18 }}>CSV / XLSX Viewer</div>
              <div style={{ color: 'var(--muted)', fontSize: 16, marginTop: 4 }}>
                自动检测文件大小，小文件纯前端，大文件提示启用本地引擎
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <button
                className="btn"
                onClick={() => {
                  resetAll()
                  listRef.current?.scrollTo(0)
                }}
              >
                重置
              </button>
            </div>
          </div>

          <div className="row" style={{ marginTop: 14 }}>
            <div className="controls">
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 260 }}>
                  {/* <div className="label">选择 CSV 文件</div> */}
                    <div
                      className={`dropzone ${dragOver ? 'drag' : ''}`}
                      onDragEnter={(e) => {
                        e.preventDefault()
                        if (busy) return
                        setDragOver(true)
                      }}
                      onDragOver={(e) => {
                        e.preventDefault()
                        if (busy) return
                        setDragOver(true)
                      }}
                      onDragLeave={() => setDragOver(false)}
                      onDrop={(e) => {
                        e.preventDefault()
                        setDragOver(false)
                        const f = e.dataTransfer.files?.[0]
                        if (!f) return
                        handleFileWithConfirm(f)
                      }}
                    >
                      <input
                        id="csv-file"
                        className="dropzone-input"
                        type="file"
                        accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                        onChange={onFileChange}
                      />
                      <label htmlFor="csv-file" className="dropzone-inner" aria-label="选择 CSV 文件">
                        <div className="dropzone-title">
                          {busy
                            ? '解析中...'
                            : activeParseMode === 'engine' && enginePhase === 'uploaded'
                              ? '上传完成：点击开始解析'
                              : '拖拽到这里，或点击选择'}
                        </div>
                        <div className="dropzone-sub">支持 .csv / .xlsx，自动检测小文件/大文件策略</div>
                      </label>
                    </div>
                </div>
                <div style={{ minWidth: 220 }}>
                  <div className="label">分隔符</div>
                  <CustomSelect
                    value={delimiter}
                    onChange={(v) => setDelimiter(v)}
                    options={[
                      { value: ',', label: ', 逗号' },
                      { value: ';', label: '; 分号' },
                      { value: '\\t', label: '<TAB>' },
                    ]}
                    ariaLabel="分隔符"
                  />
                </div>
                <div style={{ minWidth: 220 }}>
                  <div className="label">编码（引擎）</div>
                  <CustomSelect
                    value={encoding}
                    onChange={(v) => setEncoding(v)}
                    options={ENCODING_OPTIONS}
                    ariaLabel="编码"
                  />
                </div>
                <div style={{ minWidth: 190 }}>
                  <div className="label">第一行表头</div>
                  <CustomSelect
                    value={String(hasHeader)}
                    onChange={(v) => setHasHeader(v === 'true')}
                    options={[
                      { value: 'true', label: '是' },
                      { value: 'false', label: '否' },
                    ]}
                    ariaLabel="第一行表头"
                  />
                </div>
              </div>

              <div style={{ marginTop: 10, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <span className="label">解析模式</span>
                  <div style={{ minWidth: 240 }}>
                    <CustomSelect
                      value={engineMode}
                      onChange={(v) => setEngineMode(v as EngineMode)}
                      options={[
                        { value: 'auto', label: 'auto' },
                        { value: 'engine', label: '启用本地引擎' },
                        { value: 'frontend', label: '纯前端预览' },
                      ]}
                      ariaLabel="解析模式"
                    />
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <span className="label">阈值</span>
                  <input
                    className="input threshold-input"
                    style={{ width: 120, fontSize: 16 }}
                    type="number"
                    min={10}
                    step={10}
                    value={thresholdMB}
                    onChange={(e) => setThresholdMB(Number(e.target.value || 0))}
                  />
                  <span className="help">auto 模式下：文件大于阈值走引擎提示</span>
                </div>
              </div>

              {file ? (
                <div style={{ marginTop: 10, color: 'var(--muted)', fontSize: 16 }}>
                  <div className="file-meta-line">
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      文件：<span className="file-name-ellipsis" style={{ color: 'var(--text)' }}>{file.name}</span> · 大小：{fileSizeText}
                    </div>
                    <button className="btn btn-sm" onClick={() => resetAll()}>
                      清空
                    </button>
                  </div>
                  {engineMode === 'engine' ? (
                    <div style={{ marginTop: 12, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                      <span className="help" style={{ width: '100%', marginBottom: 2 }}>
                        大文件可先读「文件开头」一段，在浏览器里解析，无需等待整文件上传到引擎。
                      </span>
                      <button type="button" className="btn" disabled={busy} onClick={() => quickPreviewHead()}>
                        快速预览（前 {formatBytes(QUICK_PREVIEW_HEAD_BYTES)}）
                      </button>
                      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void uploadWithEngine(file)}>
                        完整上传至引擎
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="help" style={{ marginTop: 10,fontSize: 16 }}>
                  小文件用纯前端解析，大文件会弹出启用本地引擎的提示
                </div>
              )}
            </div>
          </div>
        </div>

        {error ? (
          <div className="panel" style={{ padding: 14, marginTop: 12, borderColor: 'rgba(251,113,133,0.45)' }}>
            <div style={{ fontWeight: 800, color: 'var(--danger)' }}>错误</div>
            <div style={{ marginTop: 6, color: 'var(--muted)', lineHeight: 1.6, fontSize: 16 }}>{error}</div>
          </div>
        ) : null}

        {headPreviewOnly ? (
          <div
            className="panel"
            style={{
              padding: 12,
              marginTop: 12,
              borderColor: 'rgba(16,185,129,0.28)',
              background: 'rgba(16,185,129,0.08)',
            }}
          >
            <div style={{ fontSize: 16, color: 'var(--muted)', lineHeight: 1.65 }}>
              当前为<strong style={{ color: 'var(--text)' }}> 文件开头预览 </strong>
              （约前 {formatBytes(QUICK_PREVIEW_HEAD_BYTES)}，不上传整文件）。若最后一行被截断，属正常现象。需要全文随机访问请使用
              {engineMode === 'engine' ? (
                <> 「完整上传至引擎」。</>
              ) : (
                <> 解析模式切换为「启用本地引擎」后上传整文件。</>
              )}
            </div>
          </div>
        ) : null}

        <div className="panel viewer-result-panel" style={{ marginTop: 12, padding: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className="tag">
                状态{' '}
                <span className="kbd">
                  {busy
                    ? '处理中...'
                    : activeParseMode
                      ? activeParseMode === 'engine' && enginePhase === 'uploaded'
                        ? '引擎已就绪：待开始解析'
                        : `模式：${activeParseMode}`
                      : '等待文件'}
                </span>
              </span>
              {headPreviewOnly ? (
                <span className="tag" style={{ borderColor: 'rgba(16,185,129,0.28)' }}>
                  开头片段预览（≈{formatBytes(QUICK_PREVIEW_HEAD_BYTES)}）
                </span>
              ) : null}
              {activeParseMode === 'frontend' && frontendTruncated ? (
                <span className="tag" style={{ borderColor: 'rgba(16,185,129,0.28)' }}>
                  仅预览前 {MAX_PREVIEW_ROWS_FRONTEND} 行
                </span>
              ) : null}
              {activeParseMode === 'engine' && engineLoadingRange ? (
                <span className="tag" style={{ borderColor: 'rgba(16,185,129,0.28)' }}>
                  正在拉取可视区数据...
                </span>
              ) : null}
            </div>
            <div style={{ color: 'var(--muted)', fontSize: 16 }}>
              列渲染限制：最多 {MAX_COLUMNS_RENDER} 列
              {activeParseMode === 'engine' && engineColumns && engineColumns.length > MAX_COLUMNS_RENDER ? (
                <span style={{ marginLeft: 10, color: 'var(--text)' }}>
                  （当前共 {engineColumns.length} 列，已截断显示）
                </span>
              ) : null}
            </div>
          </div>

          {!busy && activeParseMode === 'engine' && enginePhase === 'uploaded' && uploadId ? (
            <div style={{ marginTop: 10, display: 'flex', justifyContent: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
              <button className="btn btn-primary" onClick={() => startIndexWithEngine()}>
                开始解析
              </button>
            </div>
          ) : null}

          {!busy && activeParseMode && listCount > 0 ? (
            <div style={{ marginTop: 10, display: 'flex', justifyContent: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
              <button className="btn" onClick={() => openPreview('zoom')}>
                放大预览
              </button>
              <button className="btn btn-primary" onClick={() => openPreview('fullscreen')}>
                全屏
              </button>
            </div>
          ) : null}

          <div className="table-wrap" style={{ marginTop: 12 }}>
          <div
            ref={mainTableSplitRef}
            className="table-split"
            style={{
              maxHeight: tableSplitMaxHeight,
              minHeight:
                activeParseMode && listCount > 0
                  ? Math.min(400, tableSplitMaxHeight)
                  : 160,
            }}
          >
              {/* 左侧：固定行号列 */}
              <div className="index-pane">
                <div className="table-header" style={{ minWidth: indexColWidth }}>
                  <div
                    className="th index-cell"
                    title="行号（本页面默认辅助列，仅用于查看第几行）"
                    style={{ width: indexColWidth, flex: `0 0 ${indexColWidth}px` }}
                  >
                    #
                  </div>
                </div>
                {activeParseMode && listCount > 0 ? (
                  <List
                    className="index-list"
                    ref={indexListRef}
                    height={listHeightForRender}
                    itemCount={listCount}
                    itemSize={itemSizeForRender}
                    width={indexColWidth}
                  >
                    {renderIndexRow}
                  </List>
                ) : null}
              </div>

              {/* 右侧：可横向滚动的数据区（列头 + 数据） */}
              <div className="data-pane">
                {/* header */}
                <div
                  className="table-header"
                  style={{ minWidth: effectiveColumns.length * colWidthForRender }}
                >
                  {effectiveColumns.map((c, idx) => (
                    <div
                      key={idx}
                      className="th"
                      style={{ width: colWidthForRender, flex: `0 0 ${colWidthForRender}px` }}
                    >
                      {c}
                    </div>
                  ))}
                </div>

                {/* body */}
                {activeParseMode && listCount > 0 ? (

                  <List
                    className="data-list"
                    ref={listRef}
                    height={listHeightForRender}
                    itemCount={listCount}
                    itemSize={itemSizeForRender}
                    width={effectiveColumns.length * colWidthForRender}
                    overscanCount={10}
                    onItemsRendered={onItemsRendered}
                    onScroll={(props) => {
                      if (props.scrollOffset != null) {
                        indexListRef.current?.scrollTo(props.scrollOffset)
                      }
                    }}
                  >
                    {renderRow}
                  </List>
                ) : (
                  <div style={{ padding: 18, color: 'var(--muted)' }}>
                    {busy ? '解析中...' : ''}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {showEnginePrompt ? (
        <Modal
          title="文件较大：建议启用本地引擎"
          actions={
            <>
              <button className="btn btn-primary" onClick={confirmQuickPreview}>
                快速预览
              </button>
              <button className="btn" onClick={confirmEngine}>
                启用本地引擎
              </button>
              <button className="btn" onClick={confirmFrontend}>
                纯前端预览
              </button>
              <button className="btn btn-danger" onClick={() => setShowEnginePrompt(false)}>
                取消
              </button>
            </>
          }
        >
          <div style={{ textIndent: '2em', fontStyle: 'italic' }}>
            当前文件大小为 <strong style={{ color: 'var(--text)' }}>{fileSizeText}</strong>，已超过阈值{' '}
            <strong style={{ color: 'var(--text)' }}>{thresholdMB}MB</strong>；你可以先选择{' '}
            <strong style={{ color: 'var(--text)' }}>快速预览</strong>（仅读取文件开头片段，不上传）以尽快查看数据结构，如需浏览完整数据，请选择{' '}
            <strong style={{ color: 'var(--text)' }}>完整上传至本地引擎</strong> 后再继续。
          </div>
        </Modal>
      ) : null}

      {showReparseConfirm ? (
        <Modal
          title="检测到重复文件"
          actions={
            <>
              <button className="btn btn-primary" onClick={confirmReparseSameFile}>
                重新解析
              </button>
              <button
                className="btn"
                onClick={() => {
                  setShowReparseConfirm(false)
                  setPendingFile(null)
                }}
              >
                取消
              </button>
            </>
          }
        >
          你再次选择了同一个文件，是否确认重新解析？
        </Modal>
      ) : null}

      {busy ? (
        <div className="loading-overlay" aria-busy="true" role="status">
          <div className="loading-card">
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div className="spinner" />
              <div>
                <div className="loading-title">{loadingTitle}</div>
                <div className="loading-sub">
                  {activeParseMode === 'frontend' ? (
                    `已解析 ${frontendParsedRows} 行 / 最多预览 ${MAX_PREVIEW_ROWS_FRONTEND} 行`
                  ) : enginePhase === 'upload' && uploadProgress ? (
                    <>
                      已上传 {formatBytes(uploadProgress.loaded)} / {formatBytes(uploadProgress.total)} · 平均{' '}
                      {formatSpeedBps(uploadProgress.speedBps)} · 已用 {formatDurationFromMs(uploadProgress.elapsedMs)} ·
                      剩余 {formatEtaSeconds(uploadProgress.etaSec)}
                      {uploadProgress.etaSec !== null && Number.isFinite(uploadProgress.etaSec) ? (
                        <>
                          {' '}
                          · 预计总共 {formatDurationFromMs(uploadProgress.elapsedMs + uploadProgress.etaSec * 1000)}
                        </>
                      ) : null}
                    </>
                  ) : enginePhase === 'count' ? (
                    '可能需要一段时间（大文件统计行数）'
                  ) : (
                    '请稍候…'
                  )}
                </div>
              </div>
            </div>
            <div className="loading-progress-row">
              <div className="progress-outer" aria-label="解析进度">
                <div className="progress-inner" style={{ width: `${loadingProgress}%` }} />
              </div>
              <div className="loading-percent" aria-live="polite">
                {activeParseMode === 'engine' && enginePhase === 'upload' && uploadProgress
                  ? `${uploadProgress.percent.toFixed(1)}%`
                  : `${Math.round(loadingProgress)}%`}
              </div>
            </div>
            <div className="loading-hint">不要重复选择同一个大文件，直到解析完成。</div>
            <div className="loading-actions">
              <button className="btn btn-danger" onClick={cancelParse}>
                取消解析
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {previewOpen ? (
        <div
          className={`preview-overlay ${previewMode === 'fullscreen' ? 'fullscreen' : ''}`}
          role="dialog"
          aria-modal="true"
        >
          <div ref={previewCardRef} className={`preview-card ${previewMode === 'fullscreen' ? 'fullscreen' : ''}`}>
            <div className="preview-topbar">
              <div style={{ fontWeight: 900 }}>表格预览</div>
              <div style={{ color: 'var(--muted)', fontSize: 16 }}>
                模式：{previewMode === 'fullscreen' ? '全屏（占满电脑屏幕）' : '放大预览（占满浏览器）'}
              </div>
              <button className="btn btn-danger" onClick={() => void closePreview()}>
                退出
              </button>
            </div>
            <div className="preview-body">
              <div className="table-wrap" style={{ marginTop: 0 }}>
                <div ref={previewTableSplitRef} className="table-split table-split--fill">
                  {/* 左侧：固定行号列（预览） */}
                  <div className="index-pane">
                    <div className="table-header" style={{ minWidth: indexColWidth }}>
                      <div
                        className="th index-cell"
                        title="行号（本页面默认辅助列，仅用于查看第几行）"
                        style={{ width: indexColWidth, flex: `0 0 ${indexColWidth}px` }}
                      >
                        #
                      </div>
                    </div>
                    {activeParseMode && listCount > 0 ? (
                      <List
                        className="index-list"
                        ref={previewIndexListRef}
                        height={previewListHeight}
                        itemCount={listCount}
                        itemSize={itemSizeForRender}
                        width={indexColWidth}
                      >
                        {renderIndexRow}
                      </List>
                    ) : null}
                  </div>

                  {/* 右侧：可横向滚动的数据区（预览） */}
                  <div className="data-pane">
                    <div
                      className="table-header"
                      style={{ minWidth: effectiveColumns.length * colWidthForRender }}
                    >
                      {effectiveColumns.map((c, idx) => (
                        <div
                          key={idx}
                          className="th"
                          style={{ width: colWidthForRender, flex: `0 0 ${colWidthForRender}px` }}
                        >
                          {c}
                        </div>
                      ))}
                    </div>
                    {activeParseMode && listCount > 0 ? (
                      <List
                        className="data-list"
                        ref={previewListRef}
                        height={previewListHeight}
                        itemCount={listCount}
                        itemSize={itemSizeForRender}
                        width={effectiveColumns.length * colWidthForRender}
                        onItemsRendered={onItemsRendered}
                        onScroll={(props) => {
                          if (props.scrollOffset != null) {
                            previewIndexListRef.current?.scrollTo(props.scrollOffset)
                          }
                        }}
                      >
                        {renderRow}
                      </List>
                    ) : (
                      <div style={{ padding: 18, color: 'var(--muted)' }}>{busy ? '解析中...' : '暂无数据'}</div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

