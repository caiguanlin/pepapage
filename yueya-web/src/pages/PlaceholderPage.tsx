import { Construction } from 'lucide-react'
import TopBar from '../layout/TopBar'

/** 动画源、工具箱等后续范围的占位页。文案为本期产品决定，并非原版内容。 */
export default function PlaceholderPage({ title, description }: { title: string; description: string }) {
  return (
    <>
      <TopBar breadcrumb={<span className="font-bold text-slate-800">{title}</span>} />
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-slate-400">
        <Construction size={48} />
        <p className="text-base font-bold text-slate-600">{title} · 待开放</p>
        <p className="text-sm">{description}</p>
      </div>
    </>
  )
}
