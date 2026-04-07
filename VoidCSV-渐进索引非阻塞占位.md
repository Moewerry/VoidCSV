# VoidCSV 引擎模式：渐进索引 + 非阻塞占位（方案 A）

## 目标
在大文件（引擎模式）下实现“像图表一样滑动到再处理”的体验：
- 用户滚动到某个区域时，立刻返回可用数据 + 对未索引到的部分显示“加载中...”
- 索引构建在后台持续推进，推进后前端自动补齐缓存/渲染
- 不覆盖纯前端小文件模式（小文件仍保持现有逻辑）

## 关键策略选择
1. 渐进索引 + 缓存区间（方案 A）
2. 非阻塞占位（推荐）：
   - `GET /api/rows` 请求到“还没索引到”的行区间时，不阻塞等待
   - 立即返回 `state:'indexing'`
   - 前端按“已索引覆盖范围”渲染数据；其余行显示加载占位
3. 锚点粒度：`N = 1000`（每 1000 行记录一次 anchor/索引锚点）
4. `indexedUntilRow` 语义：**不含该行边界**
   - `indexedUntilRow = k` 表示：已索引完成覆盖 **data row 索引范围 `[0, k)`**
   - 可用行索引：`0..k-1`
   - 不可用/未索引：`k..`

> 注意：这里的 row index 均为 **data rows 的 0-based 下标**，不包含表头行（当 `hasHeader=true` 时，表头不算 data row）。

---

## 引擎侧数据结构（按 uploadId 存 session）
对每个 `uploadId` 的 session 维护以下字段：

- `hasHeader: boolean`
- `delimiter: string`
- `encoding: string`
- `cancelled: boolean`

### 索引状态（Index/Progress）
- `indexState`: `'uploading' | 'indexing' | 'ready' | 'cancelled' | 'error'`
- `indexedUntilRow: number`  
  语义：**下一行开始前的边界（不含该行）**，已索引覆盖 `[0, indexedUntilRow)`
- `totalRows?: number`（仅当 `indexState='ready'` 后提供）
- `anchors: Array<{ rowIndex: number, byteOffset: number }>`  
  `rowIndex` 对应锚点所在数据行（用于重解析对齐）
  `byteOffset` 为该行附近的字节偏移（精确性依赖 parser 边界对齐，允许重解析微调）

---

## 引擎端渐进索引构建（Indexing）
### 触发
- `POST /api/upload` 接收文件后立刻启动后台索引任务（不要阻塞到完全统计结束）

### 流式解析 + 锚点记录
- 使用支持 CSV 引号规则的流式解析器
- 当 data row 解析到每 `N=1000` 行边界时，记录一个 anchor：
  - anchor 行号 `anchorRowIndex`
  - 当前输入流的“可用于重解析的偏移位置”`byteOffset`
- `indexedUntilRow` 随着解析进度推进而递增
  - 推荐策略：每解析到一个数据行结束就递增（或每小批量递增，减少 RPC/状态更新频率）

### 列名（columns）可尽早返回
- 当 `hasHeader=true` 时，第一行字段名解析完成即可确定 `columns`
- 尽快把 `columns` 写入 session，使前端无需等待全量

---

## API 规格（建议）
下面为“最小可落地的接口协议”，便于前端实现非阻塞占位。

### 1) `POST /api/upload`
**入参**：multipart/form-data
- `file`
- `hasHeader`（string/boolean）
- `delimiter`
- `encoding`

**返回**：
- `uploadId`

启动后台 indexing。

### 2) `GET /api/status?uploadId=...`
**返回**（字段示例）：
```json
{
  "uploadId": "string",
  "indexState": "indexing|ready|cancelled|error",
  "indexedUntilRow": 12345,
  "totalRows": 2000000,
  "columns": ["col1","col2"]
}