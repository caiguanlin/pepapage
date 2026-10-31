// 编辑器左侧设置栏：手风琴单开，默认展开「页面设置」。所有值经 normalizeAuxCode 归一（规格第 7.3、10 节）。
// 分组与文案对照截图 analysis/screenshots/09、13、14、15。
import { useEffect, useState, type ReactNode } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Circle,
  LayoutGrid,
  MapPin,
  PanelLeftClose,
  PanelLeftOpen,
  PenTool,
  Printer,
  QrCode,
  RotateCcw,
  SlidersHorizontal,
  Square,
} from 'lucide-react'
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
const STANDARD_PAPER_MM: [string, number, number][] = [['A4', 210, 297], ['A5', 148, 210], ['B5', 176, 250]]

interface Props {
  aux: AuxCodeSettings
  audioMode: string
  onChange: (a: AuxCodeSettings) => void
  tool: Tool
  onTool: (t: Tool) => void
  /** 原书第 1 页尺寸（mm = OCR 像素 × 25.4 / 144） */
  bookPageMm: { w: number; h: number } | null
  /** 「显示码值」只影响预览，不写入 AuxCodeSettings */
  showCodes: boolean
  onShowCodes: (v: boolean) => void
}

/** 文本数字框：输入时去掉非数字，失焦或 Enter 时解析、四舍五入并钳制到 [min, max] 后提交。 */
function NumField({ value, onCommit, min, max, title }: { value: number; onCommit: (v: number) => void; min: number; max: number; title?: string }) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  const commit = () => {
    const n = text === '' ? NaN : Number(text)
    if (!Number.isFinite(n)) return setText(String(value))
    const v = Math.min(max, Math.max(min, Math.round(n)))
    setText(String(v))
    if (v !== value) onCommit(v)
  }
  return (
    <input
      type="text"
      inputMode="numeric"
      title={title}
      value={text}
      onChange={(e) => setText(e.target.value.replace(/\D/g, ''))}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      className="w-full rounded-lg border border-[#e8e4dc] bg-white px-2 py-1.5 text-center text-sm font-bold text-slate-800 shadow-sm outline-none focus:border-indigo-400"
    />
  )
}

/** value 为 null 时（如入口码已拖到自定义位置）各项都不高亮。 */
function Seg<T extends string>({ value, options, onChange, cols }: { value: T | null; options: [T, string][]; onChange: (v: T) => void; cols?: number }) {
  return (
    <div
      className={`rounded-lg bg-[#efede8] p-0.5 ${cols ? 'grid gap-0.5' : 'flex'}`}
      style={cols ? { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` } : undefined}
    >
      {options.map(([v, label]) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          className={`flex-1 rounded-md px-1.5 py-1 text-xs whitespace-nowrap ${value === v ? 'bg-white font-bold text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

const Row = ({ label, help, children }: { label: string; help?: ReactNode; children: ReactNode }) => (
  <div className="space-y-1.5">
    <div className="text-xs font-bold text-slate-700">{label}</div>
    {children}
    {help && <div className="text-[11px] leading-4 text-slate-400">{help}</div>}
  </div>
)

function Section({ id, title, icon, open, onOpen, children }: { id: string; title: string; icon: ReactNode; open: string; onOpen: (id: string) => void; children: ReactNode }) {
  const isOpen = open === id
  return (
    <div className="px-2">
      <button
        onClick={() => onOpen(isOpen ? '' : id)}
        className={`flex w-full items-center gap-2 rounded-lg px-2 py-2.5 text-sm font-bold text-slate-800 ${isOpen ? 'bg-[#f0ede6]' : 'hover:bg-[#f3f1ec]'}`}
      >
        {icon}
        <span className="flex-1 text-left">{title}</span>
        {isOpen ? <ChevronDown size={15} className="text-slate-400" /> : <ChevronRight size={15} className="text-slate-400" />}
      </button>
      {isOpen && <div className="space-y-4 px-2 pt-3 pb-4">{children}</div>}
    </div>
  )
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition ${checked ? 'bg-indigo-600' : 'bg-slate-300'}`}
    >
      <span className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-4' : ''}`} />
    </button>
  )
}

export default function SettingsPanel({ aux, audioMode, onChange, tool, onTool, bookPageMm, showCodes, onShowCodes }: Props) {
  const [collapsed, setCollapsed] = useState(false)
  const [open, setOpen] = useState('page')
  const set = (patch: Partial<AuxCodeSettings>) => onChange(normalizeAuxCode({ ...aux, ...patch }))

  if (collapsed)
    return (
      <aside className="flex w-10 shrink-0 flex-col items-center border-r border-[#e8e4dc] bg-[#faf9f6] pt-3">
        <button onClick={() => setCollapsed(false)} title="展开设置" className="text-slate-400 hover:text-slate-700">
          <PanelLeftOpen size={16} />
        </button>
      </aside>
    )

  const entryMax = aux.dotSize === '3' ? 56310 : 56494
  const contentMax = aux.dpi === '600' ? 26000 : 25310
  const standardPaper =
    bookPageMm &&
    STANDARD_PAPER_MM.find(
      ([, w, h]) =>
        (Math.abs(bookPageMm.w - w) <= 2 && Math.abs(bookPageMm.h - h) <= 2) || (Math.abs(bookPageMm.w - h) <= 2 && Math.abs(bookPageMm.h - w) <= 2),
    )
  const toolBtn = (t: Tool) =>
    `flex h-11 flex-1 items-center justify-center rounded-xl border bg-white shadow-sm ${tool === t ? 'border-indigo-500 text-indigo-600 ring-2 ring-indigo-100' : 'border-[#ebe8e1] text-slate-500 hover:border-slate-300'}`

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-[#e8e4dc] bg-[#faf9f6]">
      <div className="flex items-center justify-between px-4 py-3">
        <span className="text-xs font-bold text-slate-400">设置</span>
        <button onClick={() => setCollapsed(true)} title="收起" className="text-slate-400 hover:text-slate-700">
          <PanelLeftClose size={16} />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pb-3">
        <Section id="page" title="页面设置" icon={<LayoutGrid size={14} className="text-emerald-600" />} open={open} onOpen={setOpen}>
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
            <Seg value={aux.orientation} onChange={(orientation) => set({ orientation })} options={[['portrait', '竖版'], ['landscape', '横版']]} />
          </Row>
          {bookPageMm && (
            <div className="rounded-lg border border-[#e8e4dc] bg-white px-3 py-2 text-[11px] text-slate-500">
              原书页面：<b className="text-slate-700">{bookPageMm.w}×{bookPageMm.h}mm</b>
              {standardPaper ? '' : '（非标准尺寸）'}
            </div>
          )}
        </Section>

        <Section id="code" title="常用设置" icon={<QrCode size={14} className="text-indigo-500" />} open={open} onOpen={setOpen}>
          <Row label="入口码" help={`每本书一个，${aux.dotSize}x${aux.dotSize} 可用 56001–${entryMax}；点读笔点「点读入口」方块时播放本书名称音频`}>
            <NumField value={aux.entryCode} min={56001} max={entryMax} title="书籍入口编号" onCommit={(entryCode) => set({ entryCode })} />
          </Row>
          <Row label="内容码" help={`可用范围 25001–${contentMax}（${aux.dpi}dpi 素材覆盖范围）；结束码按内容量自动推算`}>
            <NumField value={aux.contentStartCode} min={25001} max={contentMax} title="内容起始码" onCommit={(contentStartCode) => set({ contentStartCode })} />
          </Row>
          <Row label="辅码粒度">
            {audioMode === 'multi' ? (
              <div className="text-xs text-slate-500">多音频模式：一码一音</div>
            ) : (
              <Seg value={aux.level} onChange={(level) => set({ level })} options={[['page', '一页一码'], ['paragraph', '一段一码'], ['sentence', '一句一码']]} />
            )}
          </Row>
          <Row label="图码模式">
            <Seg value={aux.printMode} onChange={(printMode) => set({ printMode })} options={[['integrated', '图码一体'], ['separate', '图码分离']]} />
          </Row>
          {aux.printMode === 'separate' && (
            <label className="flex items-center gap-2 text-xs text-slate-600">
              <input type="checkbox" checked={aux.bindingPageNumbers} onChange={(e) => set({ bindingPageNumbers: e.target.checked })} />
              加装订页码
            </label>
          )}
        </Section>

        <Section id="entry" title="入口码设置" icon={<MapPin size={14} className="text-rose-500" />} open={open} onOpen={setOpen}>
          <Row label="放置页">
            <Seg value={aux.entryPlacement} onChange={(entryPlacement) => set({ entryPlacement })} options={[['first', '仅首页'], ['all', '每页都铺']]} />
          </Row>
          <Row label="位置" help={aux.entryRect ? '已拖动到自定义位置，点选任一角可复位' : undefined}>
            <Seg value={aux.entryRect ? null : aux.entryCorner} onChange={(entryCorner) => set({ entryCorner, entryRect: null })} options={[['tl', '左上'], ['tr', '右上'], ['bl', '左下'], ['br', '右下']]} />
          </Row>
          <Row label="样式">
            <Seg
              cols={2}
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

        <Section id="print" title="码点设置" icon={<Printer size={14} className="text-indigo-500" />} open={open} onOpen={setOpen}>
          <Row label="打印精度">
            <Seg value={aux.dpi} onChange={(dpi) => set({ dpi })} options={[['600', '600dpi'], ['1200', '1200dpi']]} />
          </Row>
          <Row label="码点大小">
            <Seg
              value={aux.dotSize}
              onChange={(dotSize) => set({ dotSize })}
              options={aux.dpi === '600' ? [['1', '1×1'], ['2', '2×2'], ['3', '3×3']] : [['2', '2×2'], ['3', '3×3']]}
            />
          </Row>
        </Section>

        <Section id="manual" title="手动铺码" icon={<PenTool size={14} className="text-teal-600" />} open={open} onOpen={setOpen}>
          <div className="text-[11px] leading-4 text-slate-400">给无文字的位置（图画、封面）铺码；选中区域后可在下方音轨面板微调音频区间。</div>
          <div className="flex gap-2">
            <button className={toolBtn('rect')} title="矩形" onClick={() => onTool(tool === 'rect' ? 'select' : 'rect')}>
              <Square size={18} />
            </button>
            <button className={toolBtn('ellipse')} title="圆形" onClick={() => onTool(tool === 'ellipse' ? 'select' : 'ellipse')}>
              <Circle size={18} />
            </button>
          </div>
          <div className="text-[11px] leading-4 text-slate-400">
            点选形状后在页面上按住拖出大小，单击则放置默认尺寸（矩形 30×22mm、圆形 26×26mm）；Esc 取消。选中区域按 Delete 删除。
          </div>
        </Section>

        <Section id="advanced" title="高级设置" icon={<SlidersHorizontal size={14} className="text-indigo-500" />} open={open} onOpen={setOpen}>
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="text-xs font-bold text-slate-700">显示码值</div>
              <div className="text-[11px] text-slate-400">仅用于编辑预览</div>
            </div>
            <Switch checked={showCodes} onChange={onShowCodes} label="显示码值" />
          </div>
          {audioMode === 'single' && (
            <Row label="插图辅码">
              <Seg value={aux.imageCode} onChange={(imageCode) => set({ imageCode })} options={[['off', '关闭'], ['page', '整页'], ['caption', '图注']]} />
            </Row>
          )}
          <Row label="黑板处理">
            <Seg value={aux.removeBlack} onChange={(removeBlack) => set({ removeBlack })} options={[['keep', '不去黑'], ['remove', '去黑']]} />
          </Row>
          <Row label="文字行合并">
            <Seg value={aux.lineMerge} onChange={(lineMerge) => set({ lineMerge })} options={[['off', '关闭'], ['normal', '标准'], ['loose', '宽松']]} />
          </Row>
          <Row label="点读面积">
            <select value={aux.boxPadding} onChange={(e) => set({ boxPadding: e.target.value })} className="w-full rounded-lg border border-[#e8e4dc] bg-white px-2 py-1.5 text-sm">
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
          className="flex w-full items-center justify-center gap-1 rounded-md py-1.5 text-xs font-bold text-slate-500 hover:bg-[#f0ede6]"
        >
          <RotateCcw size={13} /> 恢复默认
        </button>
      </div>
    </aside>
  )
}
