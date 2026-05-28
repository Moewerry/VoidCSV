const express = require('express')
const multer = require('multer')
const fs = require('fs')
const path = require('path')
const { parse } = require('csv-parse')
const iconv = require('iconv-lite')
const { nanoid } = require('nanoid')

const app = express()
const PORT = process.env.PORT ? Number(process.env.PORT) : 8787
const HOST = process.env.HOST || '0.0.0.0'
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads')
const SESSION_MAX_AGE_MS = process.env.SESSION_MAX_AGE_MS ? Number(process.env.SESSION_MAX_AGE_MS) : 2 * 60 * 60 * 1000
const CLEANUP_INTERVAL_MS = process.env.CLEANUP_INTERVAL_MS
  ? Number(process.env.CLEANUP_INTERVAL_MS)
  : 10 * 60 * 1000
const FILE_MAX_AGE_MS = process.env.FILE_MAX_AGE_MS ? Number(process.env.FILE_MAX_AGE_MS) : 6 * 60 * 60 * 1000
const MAX_UPLOAD_DIR_BYTES = process.env.MAX_UPLOAD_DIR_BYTES ? Number(process.env.MAX_UPLOAD_DIR_BYTES) : 4 * 1024 * 1024 * 1024

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true })

const upload = multer({
  dest: UPLOAD_DIR,
  limits: {
    // MVP：不做强限制，避免你本地大文件无法上传
    // 但如果你希望更安全，可以在这里加 size 上限
  },
})

// uploadId => session
const sessions = new Map()

function safeUnlink(filePath) {
  if (!filePath) return
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  } catch {}
}

function cleanupSession(uploadId, reason = 'expired') {
  const s = sessions.get(uploadId)
  if (!s) return false
  safeUnlink(s.filePath)
  sessions.delete(uploadId)
  console.log(`[voidcsv-engine] cleanup session=${uploadId} reason=${reason}`)
  return true
}

function cleanupExpiredSessions() {
  const now = Date.now()
  let removed = 0
  for (const [uploadId, s] of sessions) {
    const age = now - (s.createdAt || now)
    if (age >= SESSION_MAX_AGE_MS || s.cancelled || s.stats?.state === 'cancelled') {
      if (cleanupSession(uploadId, s.cancelled ? 'cancelled' : 'expired')) removed += 1
    }
  }
  if (removed > 0) {
    console.log(`[voidcsv-engine] cleanup removed=${removed}, remain=${sessions.size}`)
  }
}

function listUploadFiles() {
  try {
    const names = fs.readdirSync(UPLOAD_DIR)
    return names
      .map((name) => {
        const fullPath = path.join(UPLOAD_DIR, name)
        let stat = null
        try {
          stat = fs.statSync(fullPath)
        } catch {
          return null
        }
        if (!stat.isFile()) return null
        return {
          name,
          fullPath,
          size: stat.size || 0,
          mtimeMs: stat.mtimeMs || 0,
        }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

function cleanupUploadDir() {
  const now = Date.now()
  const activePaths = new Set()
  for (const s of sessions.values()) {
    if (s?.filePath) activePaths.add(path.resolve(s.filePath))
  }

  const files = listUploadFiles()
  let removedByAge = 0
  let removedBySize = 0
  let totalBytes = 0

  for (const f of files) {
    const resolved = path.resolve(f.fullPath)
    const isActive = activePaths.has(resolved)
    const isExpired = now - f.mtimeMs >= FILE_MAX_AGE_MS
    if (!isActive && isExpired) {
      safeUnlink(f.fullPath)
      removedByAge += 1
      continue
    }
    totalBytes += f.size
  }

  if (totalBytes > MAX_UPLOAD_DIR_BYTES) {
    const remain = listUploadFiles()
      .filter((f) => !activePaths.has(path.resolve(f.fullPath)))
      .sort((a, b) => a.mtimeMs - b.mtimeMs)
    for (const f of remain) {
      if (totalBytes <= MAX_UPLOAD_DIR_BYTES) break
      safeUnlink(f.fullPath)
      totalBytes -= f.size
      removedBySize += 1
    }
  }

  if (removedByAge > 0 || removedBySize > 0) {
    console.log(
      `[voidcsv-engine] upload cleanup removedByAge=${removedByAge}, removedBySize=${removedBySize}, maxBytes=${MAX_UPLOAD_DIR_BYTES}`,
    )
  }
}

function getSession(uploadId) {
  const s = sessions.get(uploadId)
  if (!s) throw new Error('uploadId not found')
  return s
}

function toInt(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

function normalizeDelimiter(d) {
  if (!d) return ','
  if (d === '\\t') return '\t'
  return d
}

function decodeStreamMaybe(inputStream, encoding) {
  const enc = (encoding || 'utf8').toLowerCase()
  if (enc === 'utf8' || enc === 'utf-8') return inputStream
  // 需要把原始字节流解码为 UTF-8 字符串，csv-parse 才能正确识别引号与换行
  return inputStream.pipe(iconv.decodeStream(encoding))
}

function inferColumnsFromRecord(record, hasHeader) {
  if (hasHeader) {
    return record.map((v, i) => (v === undefined || v === null || v === '' ? `col${i + 1}` : String(v)))
  }
  const maxCols = record.length
  return Array.from({ length: maxCols }, (_, i) => `col${i + 1}`)
}

function syncSessionColumns(s, columns) {
  s.columns = columns
  if (!s.stats) s.stats = { state: 'idle' }
  s.stats.columns = columns
}

async function streamBuildIndex(s) {
  const { uploadId, filePath, hasHeader, delimiter, encoding } = s
  const delimiterResolved = normalizeDelimiter(delimiter)

  return new Promise((resolve, reject) => {
    const input = fs.createReadStream(filePath)
    const decoded = decodeStreamMaybe(input, encoding)

    const parser = parse({
      delimiter: delimiterResolved,
      relax_quotes: true,
      relax_column_count: true,
      from_line: 1,
    })

    let maxCols = 0
    let firstRowSeen = false
    let cancelled = false

    const isCancelled = () => {
      const live = sessions.get(uploadId)
      return !!live?.cancelled
    }

    const cancelNow = () => {
      if (cancelled) return
      cancelled = true
      try {
        input.destroy()
      } catch {}
      try {
        if (typeof parser.destroy === 'function') parser.destroy()
      } catch {}
    }

    const bumpIndexed = () => {
      s.indexedUntilRow = (s.indexedUntilRow || 0) + 1
    }

    parser.on('data', (record) => {
      if (isCancelled()) {
        cancelNow()
        return
      }

      if (!firstRowSeen) {
        firstRowSeen = true
        if (hasHeader) {
          syncSessionColumns(s, inferColumnsFromRecord(record, true))
          return
        }
        maxCols = record.length
        syncSessionColumns(s, inferColumnsFromRecord(record, false))
        bumpIndexed()
        return
      }

      if (hasHeader) {
        bumpIndexed()
        return
      }

      if (record.length > maxCols) {
        maxCols = record.length
        syncSessionColumns(
          s,
          Array.from({ length: maxCols }, (_, i) => s.columns[i] || `col${i + 1}`),
        )
      }
      bumpIndexed()
    })

    parser.on('error', (err) => {
      if (cancelled || isCancelled()) return reject(new Error('cancelled'))
      reject(err)
    })

    parser.on('end', () => {
      if (cancelled || isCancelled()) return reject(new Error('cancelled'))
      resolve()
    })

    decoded.pipe(parser)
    input.on('error', reject)
  })
}

async function runProgressiveIndex(uploadId) {
  const s = sessions.get(uploadId)
  if (!s || s.indexing || s.indexState === 'ready') return

  s.indexing = true
  s.indexState = 'indexing'
  s.indexedUntilRow = 0
  s.totalRows = null
  if (s.stats) s.stats.state = 'indexing'

  try {
    await streamBuildIndex(s)
    if (s.cancelled) {
      s.indexState = 'cancelled'
      if (s.stats) s.stats.state = 'cancelled'
      return
    }
    s.indexState = 'ready'
    s.totalRows = s.indexedUntilRow
    if (s.stats) {
      s.stats.state = 'ready'
      s.stats.rowCount = s.indexedUntilRow
      s.stats.columns = s.columns
    }
    console.log(`[voidcsv-engine] index ready uploadId=${uploadId} totalRows=${s.totalRows}`)
  } catch (e) {
    const msg = e?.message || String(e)
    if (s.cancelled || msg === 'cancelled') {
      s.indexState = 'cancelled'
      if (s.stats) s.stats.state = 'cancelled'
    } else {
      s.indexState = 'error'
      if (s.stats) s.stats.state = 'error'
      console.error(`[voidcsv-engine] index error uploadId=${uploadId}`, msg)
    }
  } finally {
    s.indexing = false
  }
}

async function countAndMaybeInferColumns({ uploadId, filePath, hasHeader, delimiter, encoding }) {
  const delimiterResolved = normalizeDelimiter(delimiter)

  return new Promise((resolve, reject) => {
    const input = fs.createReadStream(filePath)
    const decoded = decodeStreamMaybe(input, encoding)

    const parser = parse({
      delimiter: delimiterResolved,
      relax_quotes: true,
      relax_column_count: true,
      from_line: 1,
      // csv-parse 默认 quoteChar/double quote 能覆盖大多数场景
    })

    let rowCount = 0
    let columns = null
    let maxCols = 0
    let firstRowSeen = false
    let cancelled = false

    const isCancelled = () => {
      const s = sessions.get(uploadId)
      return !!s?.cancelled
    }

    const cancelNow = () => {
      if (cancelled) return
      cancelled = true
      try {
        input.destroy()
      } catch {}
      // csv-parse parser 通常会跟随 stream 停止；保留 destroy（如果存在）
      try {
        if (typeof parser.destroy === 'function') parser.destroy()
      } catch {}
    }

    parser.on('data', (record) => {
      if (isCancelled()) {
        cancelNow()
        return
      }
      // record 是 string[]
      if (!firstRowSeen) {
        firstRowSeen = true
        if (hasHeader) {
          columns = record.map((v, i) => (v === undefined || v === null || v === '' ? `col${i + 1}` : String(v)))
        } else {
          maxCols = record.length
          columns = record.map((_, i) => `col${i + 1}`)
        }
        if (!hasHeader) rowCount += 1
        return
      }

      if (hasHeader) {
        rowCount += 1
      } else {
        rowCount += 1
        if (record.length > maxCols) {
          maxCols = record.length
          columns = Array.from({ length: maxCols }, (_, i) => columns[i] || `col${i + 1}`)
        }
      }
    })

    parser.on('error', (err) => {
      if (cancelled || isCancelled()) return reject(new Error('cancelled'))
      reject(err)
    })

    parser.on('end', () => {
      if (cancelled || isCancelled()) return reject(new Error('cancelled'))
      resolve({ rowCount, columns })
    })

    decoded.pipe(parser)
    input.on('error', reject)
  })
}

function readRowsByRange({ uploadId, filePath, hasHeader, delimiter, encoding, start, count }) {
  // start/count 是 data rows 的 0-based 索引（不含表头）
  const delimiterResolved = normalizeDelimiter(delimiter)
  const startIndex = Math.max(0, start)
  const countResolved = Math.max(0, count)

  // 注意（MVP 限制）：
  // csv-parse 的 from_line/to_line 是基于“物理行号”的跳转。
  // 如果你的 CSV 存在“引号字段内包含换行”，可能导致范围定位不严格。
  // 后续可以在引擎侧实现真正的“记录级索引（byteOffset + record boundary 对齐）”。

  // csv-parse 的 from_line/to_line 是基于 1 的行号
  // 如果 hasHeader=true，则 header 行是 data rows 之前的一行
  const fromLine = hasHeader ? 2 + startIndex : 1 + startIndex
  const toLine = fromLine + countResolved - 1

  return new Promise((resolve, reject) => {
    const input = fs.createReadStream(filePath)
    const decoded = decodeStreamMaybe(input, encoding)

    const parser = parse({
      delimiter: delimiterResolved,
      relax_quotes: true,
      relax_column_count: true,
      from_line: fromLine,
      to_line: countResolved > 0 ? toLine : fromLine - 1,
    })

    const rows = []
    let cancelled = false

    const isCancelled = () => {
      const s = sessions.get(uploadId)
      return !!s?.cancelled
    }
    const cancelNow = () => {
      if (cancelled) return
      cancelled = true
      try {
        input.destroy()
      } catch {}
      try {
        if (typeof parser.destroy === 'function') parser.destroy()
      } catch {}
    }

    parser.on('data', (record) => {
      if (isCancelled()) {
        cancelNow()
        return
      }
      // record: string[]
      rows.push(record.map((v) => (v === undefined || v === null ? '' : String(v))))
      if (rows.length >= countResolved) {
        // 尽早终止（避免继续读）
        input.destroy()
      }
    })

    parser.on('error', (err) => {
      if (cancelled || isCancelled()) return reject(new Error('cancelled'))
      reject(err)
    })
    parser.on('end', () => {
      if (cancelled || isCancelled()) return reject(new Error('cancelled'))
      resolve(rows)
    })

    input.on('error', reject)
    decoded.pipe(parser)
  })
}

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'voidcsv-engine', api: '/api/*' })
})

app.post('/api/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file is required' })
    const uploadId = nanoid(12)

    const hasHeader = String(req.body.hasHeader || 'true').toLowerCase() !== 'false'
    const delimiter = req.body.delimiter || ','
    const encoding = req.body.encoding || 'utf8'

    sessions.set(uploadId, {
      uploadId,
      filePath: req.file.path,
      createdAt: Date.now(),
      hasHeader,
      delimiter,
      encoding,
      cancelled: false,
      indexState: 'idle',
      indexedUntilRow: 0,
      totalRows: null,
      columns: null,
      indexing: false,
      stats: { state: 'idle' }, // idle/counting/ready/error/cancelled
    })

    res.json({ uploadId })
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) })
  }
})

app.post('/api/cancel', (req, res) => {
  try {
    const uploadId = req.query.uploadId
    if (!uploadId) return res.status(400).json({ error: 'uploadId is required' })
    const s = getSession(uploadId)
    s.cancelled = true
    s.indexState = 'cancelled'
    if (s.stats) s.stats.state = 'cancelled'
    // 取消后立即清理上传文件，防止磁盘持续膨胀
    cleanupSession(uploadId, 'cancelled-by-user')
    return res.json({ ok: true, uploadId })
  } catch (e) {
    res.status(400).json({ error: e.message || String(e) })
  }
})

app.get('/api/status', (req, res) => {
  try {
    const uploadId = req.query.uploadId
    const s = getSession(uploadId)
    res.json({
      uploadId: s.uploadId,
      indexState: s.indexState || 'idle',
      indexedUntilRow: s.indexedUntilRow ?? 0,
      totalRows: s.totalRows ?? null,
      columns: s.columns ?? s.stats?.columns ?? null,
    })
  } catch (e) {
    res.status(400).json({ error: e.message || String(e) })
  }
})

app.post('/api/index', (req, res) => {
  try {
    const uploadId = req.query.uploadId
    if (!uploadId) return res.status(400).json({ error: 'uploadId is required' })
    const s = getSession(uploadId)

    if (s.cancelled || s.indexState === 'cancelled') {
      return res.status(499).json({ uploadId, state: 'cancelled' })
    }
    if (s.indexState === 'ready' || s.indexing) {
      return res.json({ ok: true, uploadId })
    }

    void runProgressiveIndex(uploadId)
    res.json({ ok: true, uploadId })
  } catch (e) {
    res.status(400).json({ error: e.message || String(e) })
  }
})

app.get('/api/stats', async (req, res) => {
  try {
    const uploadId = req.query.uploadId
    const s = getSession(uploadId)

    if (s.cancelled || s.stats.state === 'cancelled') {
      return res.status(499).json({ uploadId: s.uploadId, state: 'cancelled' })
    }

    if (s.stats.state === 'ready') {
      return res.json({
        uploadId: s.uploadId,
        state: 'ready',
        rowCount: s.stats.rowCount,
        columns: s.stats.columns,
      })
    }

    if (s.stats.state === 'counting') {
      return res.json({
        uploadId: s.uploadId,
        state: 'counting',
        rowCount: s.stats.rowCount ?? null,
        columns: s.stats.columns ?? null,
      })
    }

    s.stats.state = 'counting'

    const { rowCount, columns } = await countAndMaybeInferColumns({
      uploadId,
      filePath: s.filePath,
      hasHeader: s.hasHeader,
      delimiter: s.delimiter,
      encoding: s.encoding,
    })

    s.stats.state = 'ready'
    s.stats.rowCount = rowCount
    s.stats.columns = columns

    res.json({
      uploadId: s.uploadId,
      state: 'ready',
      rowCount,
      columns,
    })
  } catch (e) {
    const msg = e?.message || String(e)
    if (msg === 'cancelled') {
      const uploadId = req.query.uploadId
      const s = sessions.get(uploadId)
      if (s) {
        s.stats.state = 'cancelled'
      }
      return res.status(499).json({ uploadId, state: 'cancelled' })
    }
    res.status(500).json({ error: msg })
  }
})

app.get('/api/rows', async (req, res) => {
  try {
    const uploadId = req.query.uploadId
    const s = getSession(uploadId)
    const start = toInt(req.query.start, 0)
    const count = toInt(req.query.count, 200)

    if (s.cancelled || s.indexState === 'cancelled' || s.stats?.state === 'cancelled') {
      return res.status(499).json({ uploadId: s.uploadId, state: 'cancelled' })
    }

    const columns = s.columns ?? s.stats?.columns
    if (!columns) {
      return res.status(409).json({ error: 'columns not ready. call POST /api/index first.' })
    }
    if (s.indexState !== 'indexing' && s.indexState !== 'ready') {
      return res.status(409).json({ error: 'index not started. call POST /api/index first.' })
    }

    let countResolved = count
    if (s.indexState === 'indexing') {
      const available = Math.max(0, (s.indexedUntilRow ?? 0) - start)
      countResolved = Math.min(count, available)
      if (countResolved <= 0) {
        return res.json({
          start,
          count: 0,
          rows: [],
          state: 'indexing',
          indexedUntilRow: s.indexedUntilRow ?? 0,
        })
      }
    }

    const rows = await readRowsByRange({
      uploadId,
      filePath: s.filePath,
      hasHeader: s.hasHeader,
      delimiter: s.delimiter,
      encoding: s.encoding,
      start,
      count: countResolved,
    })

    // 行长不足时补齐（前端表格对齐）
    const width = columns.length
    const normalized = rows.map((r) => {
      const rr = r.slice(0, width)
      while (rr.length < width) rr.push('')
      return rr
    })

    const payload = { start, count: normalized.length, rows: normalized }
    if (s.indexState === 'indexing') {
      payload.state = 'indexing'
      payload.indexedUntilRow = s.indexedUntilRow ?? 0
      payload.totalRows = null
    } else if (s.indexState === 'ready') {
      payload.totalRows = s.totalRows ?? s.indexedUntilRow ?? null
    }
    res.json(payload)
  } catch (e) {
    const msg = e?.message || String(e)
    if (msg === 'cancelled') {
      return res.status(499).json({ uploadId: req.query.uploadId, state: 'cancelled' })
    }
    res.status(400).json({ error: msg })
  }
})

app.listen(PORT, HOST, () => {
  console.log(`[voidcsv-engine] listening on http://${HOST}:${PORT}`)
})

cleanupUploadDir()
setInterval(() => {
  cleanupExpiredSessions()
  cleanupUploadDir()
}, CLEANUP_INTERVAL_MS)
console.log(
  `[voidcsv-engine] cleanup enabled: sessionMaxAgeMs=${SESSION_MAX_AGE_MS}, fileMaxAgeMs=${FILE_MAX_AGE_MS}, intervalMs=${CLEANUP_INTERVAL_MS}, maxUploadDirBytes=${MAX_UPLOAD_DIR_BYTES}`,
)

