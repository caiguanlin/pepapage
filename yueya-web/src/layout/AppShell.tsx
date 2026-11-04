import { NavLink, Outlet } from 'react-router'
import { BookOpen, Clapperboard, LogOut, Settings, Wrench, type LucideIcon } from 'lucide-react'
import { useAuth } from '../auth/AuthContext'

interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  activeText: string
}

// 主导航顺序与激活色：动画源 orange-600 / 绘本 indigo-600 / 工具箱 teal-600
const NAV: NavItem[] = [
  { to: '/animations', label: '动画源', icon: Clapperboard, activeText: 'text-orange-600' },
  { to: '/picture-books', label: '绘本', icon: BookOpen, activeText: 'text-indigo-600' },
  { to: '/toolbox', label: '工具箱', icon: Wrench, activeText: 'text-teal-600' },
]

const APP_VERSION = '0.1.0'

export default function AppShell() {
  const { user, logout } = useAuth()

  return (
    <div className="flex h-full">
      <aside className="flex w-[184px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar">
        <div className="flex h-[73px] items-center gap-3 px-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500 text-lg font-extrabold text-white">
            P
          </div>
          <span className="text-lg font-bold text-sidebar-text">阅芽</span>
        </div>

        <nav className="flex flex-col gap-1 px-2">
          {NAV.map(({ to, label, icon: Icon, activeText }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-xl px-3 py-5 text-[15px] font-bold transition-colors ${
                  isActive ? `bg-sidebar-active ${activeText}` : 'text-sidebar-muted hover:bg-black/5'
                }`
              }
            >
              {({ isActive }) => (
                <>
                  <Icon size={20} className={isActive ? '' : 'text-sidebar-icon'} />
                  {label}
                </>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="mt-auto space-y-1 px-2 pb-3">
          <div className="truncate px-3 py-2 text-xs text-sidebar-muted" title={user?.email}>
            {user?.nickname}
          </div>
          <button className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-sidebar-muted hover:bg-black/5">
            <Settings size={16} className="text-sidebar-icon" />
            设置
          </button>
          <button
            onClick={logout}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-sidebar-muted hover:bg-black/5"
          >
            <LogOut size={16} className="text-sidebar-icon" />
            退出登录
          </button>
          <div className="px-3 pt-2 text-[10px] text-sidebar-version">软件版本：v{APP_VERSION}</div>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col bg-slate-50">
        <Outlet />
      </main>
    </div>
  )
}
