---
name: voidcsv-ui-interactions
description: >-
  Adjusts VoidCSV's UI and interactive behaviors for CSV viewing. Use when the user asks
  to beautify controls (e.g., dropdown/select), add/modify parsing overlays (progress + cancel),
  implement "zoom preview" vs "fullscreen" viewing, or ensure Jupyter-like table alignment for
  column names/cells. Focus on keeping large-file performance stable and avoiding UI regressions.
---

# VoidCSV UI & 交互改造（Skill）

## 适用触发信号（常见关键词）
- `VoidCSV` / `CSV Viewer`
- `下拉框` / `select` 样式异常 / 统一组件
- `进度遮罩` / `解析进度` / `加载窗口` / `取消解析`
- `放大预览` / `全屏`（区分：占满浏览器 vs 占满电脑屏幕）
- `表格对齐` / `列名` / `像 jupyter` / `虚拟滚动` 对齐

## 覆盖的目标能力（Agent 必须检查）
1. 下拉框样式一致性：避免原生 `<select>` 导致跨平台样式不一致，优先使用项目内自定义下拉组件。
2. 解析/加载遮罩：
   - 遮罩展示当前阶段（纯前端解析进度，或本地引擎分阶段状态）
   - 遮罩提供 `取消解析` 按钮
   - 取消后立即关闭遮罩并停止进行中的解析/读取（前端 abort / 后端 cancel）
   - 忽略已取消请求的后续回调，避免数据/状态“闪回”
3. 放大预览与全屏：
   - `放大预览`：仅占满浏览器视口内部（不触发系统全屏）
   - `全屏`：调用浏览器 Fullscreen API，使内容占满电脑屏幕，并能退出
4. 表格对齐（Jupyter 风格）：
   - 列宽固定并在表头/单元格一致
   - 表头/行在水平滚动下不出现错位
   - 单元格与表头使用一致的字体（推荐等宽字体）

## 推荐优先修改的文件（按需）
- `web/src/pages/Home.tsx`：首页文本/控件间距、CTA 按交互预期触发
- `web/src/pages/Viewer.tsx`：进度遮罩、取消解析、放大预览与全屏、表格渲染/对齐
- `web/src/pages/viewer.css`：下拉样式（自定义组件）、遮罩、预览弹层、表格 UI
- `web/src/components/CustomSelect.tsx`：下拉组件交互与样式一致性（如需）
- `engine/src/index.js`：`/api/cancel` 接口、读取/统计阶段取消逻辑（如需）

## 工作流（执行顺序）
1. 先做快速扫描（只读）：
   - 找到用户提出问题对应的组件位置（如 `Viewer` 的解析/下拉/预览区）
   - 确认当前是否已使用自定义下拉（`CustomSelect`）与遮罩机制
2. 需求落点映射：
   - “下拉框样式怪异” -> 替换原生 `<select>` 为 `CustomSelect`（或完善 `CustomSelect`）
   - “进度遮罩加取消” -> 前端遮罩 UI + 取消逻辑（abort / reset / 忽略回调）
   - “放大预览 vs 全屏” -> `previewOpen/previewMode` 与 Fullscreen API 区分
   - “Jupyter 对齐” -> 固定列宽：表头/单元格同时设置宽度与 flex basis；必要时调整容器宽度策略
3. 实现并保持兼容：
   - 不改变 CSV 解析核心逻辑的语义（仅插入进度/遮罩/取消/渲染参数）
   - 大文件模式尽量减少额外内存与渲染次数
4. 验收检查（必须）：
   - 取消解析后遮罩立即消失，且不会在解析结束后又弹回
   - `放大预览` 不调用 `requestFullscreen`
   - `全屏` 调用 Fullscreen API，退出后恢复页面
   - 表格列宽在 header/body 都严格一致
5. 代码质量：
   - 修复因改动引入的 TypeScript/TSLint/ESLint 报错（如涉及 TS）
   - 保持语义化命名与简洁注释（只在非显然逻辑处）

## 验收输出格式（Agent 回复时建议）
- 变更点摘要（1-3 条）
- 涉及文件列表
- 针对每项能力列出“已满足/注意事项”

## 示例（用户可能怎么说）
- “下拉框怎么这个样子？”
- “解析的时候加进度遮罩和取消解析按钮”
- “放大预览占满浏览器， 全屏占满电脑屏幕”
- “表格要像 jupyter 一样列名单元格严格对齐”

