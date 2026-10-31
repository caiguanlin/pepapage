import type { CSSProperties } from 'react'
import { Volume2 } from 'lucide-react'

// 句框和波形段共用一个周期，每句占三分之一；同一套关键帧靠负延迟错开相位，二者始终同步
const CYCLE_S = 7.5

const CUES = [
  { text: 'The sun is up.', baseline: 66, width: 152, time: '0:00' },
  { text: 'Hello, green hills!', baseline: 112, width: 186, time: '0:02' },
  { text: 'Time to go and play.', baseline: 158, width: 222, time: '0:05' },
]

const CUE_H = 38
const CUE_R = 7
// 圆角矩形周长，用来让句框描边从起点一笔画出
const perimeter = (w: number) => 2 * (w + CUE_H) - 8 * CUE_R + 2 * Math.PI * CUE_R

const BARS_PER_CUE = 18
const SILENT_BARS = 3

// 固定种子生成波形高度（百分比），每段末尾几根是句间停顿
const WAVE = CUES.map((_, seed) =>
  Array.from({ length: BARS_PER_CUE }, (_, j) => {
    if (j >= BARS_PER_CUE - SILENT_BARS) return 10
    const voiced = BARS_PER_CUE - SILENT_BARS
    const envelope = 0.45 + 0.55 * Math.sin((Math.PI * (j + 0.5)) / voiced)
    const v = Math.abs(Math.sin((j + 1) * 1.7 + seed * 2.3)) * 0.65 + Math.abs(Math.sin((j + 1) * 0.45 + seed)) * 0.35
    return Math.round(14 + v * envelope * 86)
  }),
)

function phaseDelay(i: number) {
  return `${-((CUES.length - i) % CUES.length) * (CYCLE_S / CUES.length)}s`
}

/** 登录页左侧主视觉：一页绘本里的句子按朗读顺序点亮，下方音频对应的一段同步亮起。 */
export default function LoginHero() {
  return (
    <div aria-hidden className="w-full max-w-[440px]" style={{ '--login-cycle': `${CYCLE_S}s` } as CSSProperties}>
      <div className="login-rise" style={{ animationDelay: '80ms' }}>
        <div className="relative">
          <div className="login-fan absolute inset-0 rotate-[3.5deg] rounded-[10px] bg-[#d6c9af] shadow-[0_20px_40px_-20px_rgba(15,23,42,0.3)]" />
          <div className="relative -rotate-[1.5deg] overflow-hidden rounded-[10px] shadow-[0_30px_60px_-24px_rgba(15,23,42,0.4)]">
            <svg viewBox="0 0 440 330" className="block w-full">
              <rect width="440" height="330" fill="#f6eedd" />
              <circle cx="370" cy="76" r="32" fill="#f1b94c" />
              <g fill="#fffcf5">
                <rect x="314" y="102" width="70" height="16" rx="8" />
                <circle cx="334" cy="104" r="12" />
                <circle cx="354" cy="98" r="16" />
              </g>
              <path d="M0 232 C 80 182, 170 188, 250 222 S 400 204, 440 188 V330 H0 Z" fill="#d3ddb0" />
              <path d="M0 272 C 90 228, 200 236, 290 262 S 400 252, 440 240 V330 H0 Z" fill="#a9c58a" />
              <path d="M0 304 C 120 280, 260 294, 440 282 V330 H0 Z" fill="#84ab6c" />

              {CUES.map((cue, i) => (
                <g key={cue.text}>
                  <rect className="login-cue-dashed" x="20" y={cue.baseline - 27} width={cue.width} height={CUE_H} rx={CUE_R} />
                  <rect
                    className="login-cue-solid"
                    data-cue={i}
                    style={
                      {
                        animationDelay: phaseDelay(i),
                        strokeDasharray: `${perimeter(cue.width)}px`,
                        '--len': `${perimeter(cue.width)}px`,
                      } as CSSProperties
                    }
                    x="20"
                    y={cue.baseline - 27}
                    width={cue.width}
                    height={CUE_H}
                    rx={CUE_R}
                  />
                  <text x="32" y={cue.baseline} fontFamily="Georgia, 'Times New Roman', serif" fontSize="21" fill="#3b3229">
                    {cue.text}
                  </text>
                  <g transform={`translate(${20 + cue.width + 8} ${cue.baseline - 20})`}>
                    <g className="login-cue-capsule" data-cue={i} style={{ animationDelay: phaseDelay(i) }}>
                      <rect width="48" height="24" rx="12" fill="#059669" />
                      <text
                        x="24"
                        y="16.5"
                        textAnchor="middle"
                        fontFamily="ui-monospace, Consolas, monospace"
                        fontSize="13"
                        fontWeight="600"
                        fill="#fff"
                      >
                        {cue.time}
                      </text>
                    </g>
                  </g>
                </g>
              ))}
            </svg>
          </div>
        </div>
      </div>

      <div
        className="login-rise mt-9 flex items-center gap-3 rounded-xl border border-sidebar-border bg-white px-4 py-3"
        style={{ animationDelay: '160ms' }}
      >
        <Volume2 size={16} className="shrink-0 text-sidebar-icon" />
        <div className="relative flex h-9 flex-1">
          {WAVE.map((heights, i) => (
            <div
              key={i}
              className="login-cue-wave flex flex-1 items-center gap-[2px] px-px"
              data-cue={i}
              style={{ animationDelay: phaseDelay(i) }}
            >
              {heights.map((h, j) => (
                <span
                  key={j}
                  className="login-bar flex-1 rounded-full bg-current"
                  style={{ height: `${h}%`, animationDelay: `${320 + (i * BARS_PER_CUE + j) * 11}ms` }}
                />
              ))}
            </div>
          ))}
          <div className="login-playhead pointer-events-none absolute inset-0">
            <span className="absolute -top-1 -bottom-1 left-0 w-[2px] rounded-full bg-sidebar-text" />
          </div>
        </div>
      </div>
    </div>
  )
}
