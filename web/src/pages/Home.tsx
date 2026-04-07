import React from 'react'
import { useNavigate } from 'react-router-dom'

export default function Home() {
  const navigate = useNavigate()

  return (
    <div
      className="app-shell"
      style={{
        minHeight: '50vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        style={{
          width: 'min(980px, 100%)',
          display: 'flex',
          gap: 36,
          alignItems: 'center',
          justifyContent: 'center',
          flexWrap: 'wrap',
        }}
      >
        {/* 左侧：标题与介绍 */}
        <div style={{ minWidth: 420 ,display: 'flex', flexDirection: 'column', justifyContent: 'flex-start'}}>
          <div style={{ fontSize: 44, fontWeight: 900, letterSpacing: 0.2, lineHeight: 1 }}>
            VoidCSV
          </div>
          <div style={{ marginTop: 18, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <span
              className="tag"
              style={{ cursor: 'default', userSelect: 'none' }}
              title="告别 2GB+ CSV 卡顿，拒绝 VSCode 无响应。"
            >
              拒绝无响应
            </span>
            <span
              className="tag"
              style={{ cursor: 'default', userSelect: 'none' }}
              title="智能文件检测，小文件极速预览。"
            >
              极速预览
            </span>
            <span
              className="tag"
              style={{ cursor: 'default', userSelect: 'none' }}
              title="大文件专属本地引擎，流畅不崩。"
            >
              流畅不崩
            </span>
          </div>
        </div>

        {/* 右侧：参考图风格卡片（仍然只负责“进入”动作） */}
        <div
          className="panel"
          style={{
            width: 380,
            padding: 16,
            background: 'linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.015))',
          }}
        >
          <div style={{ fontSize: 16, fontWeight: 800 }}>开始浏览</div>
          <div style={{ marginTop: 8, color: 'var(--muted)', lineHeight: 1.6, fontSize: 13 }}>
           智能调度解析，大小 CSV 皆可流畅预览
          </div>

          <div style={{ marginTop: 14, padding: 14, borderRadius: 14, border: '1px solid var(--border)', background: 'rgba(0,0,0,0.20)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>文件类型</div>
                <div style={{ marginTop: 6, fontSize: 13 }}>CSV</div>
              </div>
              <div className="tag" style={{ padding: '6px 10px' }}>
                <span className="kbd">2GB+</span> 支持
              </div>
            </div>
            <div style={{ marginTop: 10 }}>
              <button
                className="btn btn-primary"
                style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
                onClick={() => navigate('/viewer')}
              >
                <span>进入体验</span>
                <span style={{ fontWeight: 900 }}>→</span>
              </button>
              {/* <div style={{ color: 'var(--muted)', fontSize: 12 }}>进入后再选择文件与模式</div> */}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

