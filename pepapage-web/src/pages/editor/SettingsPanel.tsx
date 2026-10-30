// 编辑器左侧设置栏：手风琴单开，默认展开「页面设置」。所有值经 normalizeAuxCode 归一（规格第 10 节）。
import { useEffect, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight, Circle, MousePointer2, RotateCcw, Square } from 'lucide-react'
import {
  AUX_CODE_DEFAULTS,
  BOX_PADDING_OPTIONS,
  normalizeAuxCode,
  type AuxCodeSettings,
} from '../../api/editorTypes'

export type Tool = 'select' | 'rect' | 'ellipse'

const PADDING_MM: Record<string, string> = {
  '0': '0', '6': '1', '12': '2', '24': '4', '36': '6', '48': '8', '60': '10', '72': '12', '96': '16', '120': '20',
}

interface Props {
  aux: AuxCodeSettings
  audioMode: string
  onChange: (a: AuxCodeSettings) => void
  tool: Tool
  onTool: (t: Tool) => void
}

function NumField({ value, onCommit, min, max, className }: { value: number; onCommit: (v: number) => void; min?: number; max?: number; className?: string }) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  const commit = () => {
    const n = Number(text)
    if (!Number.isFinite(n)) return setText(String(value))
    onCommit(n)
  }
  return (
    <input
      type="number"
      min={min}
      max={max}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
      className={`w-full rounded-md border border-slate-200 bg-white px-2 py-1 text-sm ${className ?? ''}`}
    />
  )
}

function Seg<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map(([v, label]) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          className={`rounded-md border px-2 py-1 text-xs ${value === v ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

const Row = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="space-y-1">
    <div className="text-xs text-slate-500">{label}</div>
    {children}
  </div>
)

export default function SettingsPanel({ aux, audioMode, onChange, tool, onTool }: Props) {
  const [collapsed, setCollapsed] = useState(false)
  const [open, setOpen] = useState('page')
  const set = (patch: Partial<AuxCodeSettings>) => onChange(normalizeAuxCode({ ...aux, ...patch }))

  if (collapsed)
    return (
      <aside className="flex w-10 shrink-0 flex-col items-center border-r border-[#e8e4dc] bg-[#faf9f6] pt-3">
        <button onClick={() => setCollapsed(false)} title="展开设置" className="text-slate-500 hover:text-slate-800">
          <ChevronRight size={18} />
        </button>
      </aside>
    )

  const Section = ({ id, title, children }: { id: string; title: string; children: ReactNode }) => (
    <div className="border-b border-[#e8e4dc]">
      <button onClick={() => setOpen(open === id ? '' : id)} className="flex w-full items-center justify-between px-3 py-2.5 text-sm font-bold text-slate-700">
        {title}
        <ChevronDown size={15} className={`transition ${open === id ? 'rotate-180' : ''}`} />
      </button>
      {open === id && <div className="space-y-3 px-3 pb-3">{children}</div>}
    </div>
  )

  const tbtn = (t: Tool) =>
    `flex flex-1 items-center justify-center gap-1 rounded-md border px-2 py-1.5 text-xs ${tool === t ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-slate-200 bg-white text-slate-600'}`

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-[#e8e4dc] bg-[#faf9f6]">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs font-bold text-slate-500">辅码设置</span>
        <button onClick={() => setCollapsed(true)} title="收起" className="text-slate-500 hover:text-slate-800">
          <ChevronLeft size={16} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Section id="page" title="页面设置">
          <Row label="纸张">
            <Seg value={aux.paper} onChange={(paper) => set({ paper })} options={[['A4', 'A4'], ['A5', 'A5'], ['B5', 'B5'], ['custom', '自定义']]} />
          </Row>
          {aux.paper === 'custom' && (
            <div className="flex items-center gap-1 text-xs text-slate-500">
              <NumField value={aux.customPaperMm.w} min={30} max={600} onCommit={(w) => set({ customPaperMm: { ...aux.customPaperMm, w } })} />
              ×
              <NumField value={aux.customPaperMm.h} min={30} max={600} onCommit={(h) => set({ customPaperMm: { ...aux.customPaperMm, h } })} />
              mm
            </div>
          )}
          <Row label="方向">
            <Seg value={aux.orientation} onChange={(orientation) => set({ orientation })} options={[['portrait', '纵向'], ['landscape', '横向']]} />
          </Row>
        </Section>
        <Section id="code" title="编码设置">
          <Row label="入口码">
            <NumField value={aux.entryCode} onCommit={(entryCode) => set({ entryCode })} />
          </Row>
          <Row label="内容起始码">
            <NumField value={aux.contentStartCode} onCommit={(contentStartCode) => set({ contentStartCode })} />
          </Row>
          <Row label="赋码粒度">
            {audioMode === 'multi' ? (
              <div className="text-xs text-slate-500">多音频模式：一码一音</div>
            ) : (
              <Seg value={aux.level} onChange={(level) => set({ level })} options={[['page', '按页'], ['paragraph', '按段'], ['sentence', '按句']]} />
            )}
          </Row>
          <Row label="印刷方式">
            <Seg value={aux.printMode} onChange={(printMode) => set({ printMode })} options={[['integrated', '图码一体'], ['separate', '图码分离']]} />
          </Row>
          {aux.printMode === 'separate' && (
            <label className="flex items-center gap-2 text-xs text-slate-600">
              <input type="checkbox" checked={aux.bindingPageNumbers} onChange={(e) => set({ bindingPageNumbers: e.target.checked })} />
              打印装订页码
            </label>
          )}
        </Section>
        <Section id="entry" title="入口码">
          <Row label="放置页">
            <Seg value={aux.entryPlacement} onChange={(entryPlacement) => set({ entryPlacement })} options={[['first', '仅首页'], ['all', '每页']]} />
          </Row>
          <Row label="位置">
            <Seg value={aux.entryCorner} onChange={(entryCorner) => set({ entryCorner, entryRect: null })} options={[['tl', '左上'], ['tr', '右上'], ['bl', '左下'], ['br', '右下']]} />
          </Row>
          <Row label="样式">
            <Seg
              value={aux.entryStyle}
              onChange={(entryStyle) => set({ entryStyle })}
              options={[['flag', '旗帜标贴式'], ['ticket', '票券撕剪式'], ['focus', '角标聚焦式'], ['dotted', '点阵底纹式'], ['plain', '简洁']]}
            />
          </Row>
          <Row label="尺寸（12–40mm）">
            <NumField value={aux.entrySizeMm} min={12} max={40} onCommit={(entrySizeMm) => set({ entrySizeMm })} />
          </Row>
          {aux.entryBoxKey && <div className="text-xs text-amber-700">已指定入口区域：{aux.entryBoxKey}</div>}
        </Section>
        <Section id="print" title="打印精度">
          <Row label="DPI">
            <Seg value={aux.dpi} onChange={(dpi) => set({ dpi })} options={[['600', '600'], ['1200', '1200']]} />
          </Row>
          <Row label="点大小">
            <Seg
              value={aux.dotSize}
              onChange={(dotSize) => set({ dotSize })}
              options={aux.dpi === '600' ? [['1', '1'], ['2', '2'], ['3', '3']] : [['2', '2'], ['3', '3']]}
            />
          </Row>
        </Section>
        <Section id="manual" title="手动区域">
          <div className="flex gap-1">
            <button className={tbtn('select')} onClick={() => onTool('select')}><MousePointer2 size={13} />选择</button>
            <button className={tbtn('rect')} onClick={() => onTool('rect')}><Square size={13} />矩形</button>
            <button className={tbtn('ellipse')} onClick={() => onTool('ellipse')}><Circle size={13} />圆形</button>
          </div>
          <div className="text-[11px] leading-5 text-slate-400">
            选中形状后在页面上拖出区域，单击则放置默认尺寸（矩形 30×22mm、圆形 26×26mm）。选中区域按 Delete 删除。
          </div>
        </Section>
        <Section id="advanced" title="高级">
          <Row label="图片赋码">
            <Seg value={aux.imageCode} onChange={(imageCode) => set({ imageCode })} options={[['off', '关闭'], ['page', '整页'], ['caption', '图注']]} />
          </Row>
          <Row label="黑板处理">
            <Seg value={aux.removeBlack} onChange={(removeBlack) => set({ removeBlack })} options={[['keep', '不去黑'], ['remove', '去黑']]} />
          </Row>
          <Row label="合并行">
            <Seg value={aux.lineMerge} onChange={(lineMerge) => set({ lineMerge })} options={[['off', '关闭'], ['normal', '标准'], ['loose', '宽松']]} />
          </Row>
          <Row label="框外扩">
            <select value={aux.boxPadding} onChange={(e) => set({ boxPadding: e.target.value })} className="w-full rounded-md border border-slate-200 bg-white px-2 py-1 text-sm">
              {BOX_PADDING_OPTIONS.map((k) => (
                <option key={k} value={k}>{PADDING_MM[k]} mm</option>
              ))}
            </select>
          </Row>
        </Section>
      </div>
      <div className="border-t border-[#e8e4dc] p-3">
        <button
          onClick={() => onChange(normalizeAuxCode({ ...AUX_CODE_DEFAULTS, enabled: aux.enabled, entryBoxKey: aux.entryBoxKey, entryRect: aux.entryRect }))}
          className="flex w-full items-center justify-center gap-1 rounded-md border border-slate-200 bg-white py-1.5 text-xs text-slate-600 hover:bg-slate-50"
        >
          <RotateCcw size={13} /> 恢复默认
        </button>
      </div>
    </aside>
  )
}
