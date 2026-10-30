import type { ReactNode } from 'react'
import { Search } from 'lucide-react'

interface Props {
  breadcrumb: ReactNode
  search?: string
  onSearchChange?: (v: string) => void
}

/** 顶栏：px-8 py-4、白色 80% 不透明 + 模糊、slate-200 下边框；搜索框 w-48 仅 md 及以上显示。 */
export default function TopBar({ breadcrumb, search, onSearchChange }: Props) {
  return (
    <header className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white/80 px-8 py-4 backdrop-blur">
      <div className="flex min-w-0 items-center gap-2 text-sm text-slate-500">{breadcrumb}</div>
      {onSearchChange && (
        <label className="hidden w-48 items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5 md:flex">
          <Search size={14} className="text-slate-400" />
          <input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="搜索工作空间"
            className="w-full bg-transparent text-sm outline-none"
          />
        </label>
      )}
    </header>
  )
}
