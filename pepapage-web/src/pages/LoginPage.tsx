import { useState, type FormEvent } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router'
import { ArrowRight, CircleAlert, Eye, EyeOff, Loader2, Lock, Mail } from 'lucide-react'
import { useAuth } from '../auth/AuthContext'
import LoginHero from './LoginHero'

type Mode = 'login' | 'register'

const MODES: { value: Mode; label: string }[] = [
  { value: 'login', label: '登录' },
  { value: 'register', label: '注册' },
]

const FIELD =
  'flex h-11 items-center gap-2.5 rounded-lg border border-sidebar-border bg-white px-3.5 transition-[border-color,box-shadow] focus-within:border-emerald-600 focus-within:shadow-[0_0_0_3px_rgba(5,150,105,0.14)]'
// 聚焦时标签变成和左侧“正在读的那句”同一种绿
const LABEL = 'mb-2 block text-[13px] font-medium text-sidebar-muted transition-colors group-focus-within:text-emerald-700'
const INPUT = 'login-input h-full min-w-0 flex-1 bg-transparent text-[15px] text-sidebar-text outline-none placeholder:text-[#9ca3af]'

export default function LoginPage() {
  const { user, login, register } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [mode, setMode] = useState<Mode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const from = (location.state as { from?: string } | null)?.from ?? '/picture-books'
  if (user) return <Navigate to={from} replace />

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      if (mode === 'login') await login(email, password)
      else await register(email, password)
      navigate(from, { replace: true })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  function switchMode(next: Mode) {
    if (next === mode) return
    setMode(next)
    setError(null)
  }

  return (
    <div className="grid h-full grid-cols-[minmax(440px,46%)_1fr]">
      <aside className="flex flex-col border-r border-sidebar-border bg-sidebar px-12 py-9">
        <div className="login-rise flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500 text-lg font-extrabold text-white">P</div>
          <span className="text-lg font-bold text-sidebar-text">PepaPage</span>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center py-10">
          <LoginHero />
          <p className="login-rise mt-8 w-full max-w-[440px] text-xl font-bold text-sidebar-text" style={{ animationDelay: '240ms' }}>
            让绘本里的每一句，都对上它的声音
          </p>
        </div>
      </aside>

      <main className="flex items-center justify-center bg-white px-12">
        <form onSubmit={onSubmit} className="w-full max-w-[360px]">
          <div className="login-rise relative mb-9 inline-grid grid-cols-2 gap-x-7" style={{ animationDelay: '60ms' }}>
            {MODES.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                aria-pressed={mode === value}
                onClick={() => switchMode(value)}
                className={`rounded-sm pb-2.5 text-left text-[28px] leading-tight font-bold transition-colors focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-600 ${
                  mode === value ? 'text-sidebar-text' : 'text-[#8b8f96] hover:text-sidebar-muted'
                }`}
              >
                {label}
              </button>
            ))}
            <span
              aria-hidden
              className="login-tab-indicator absolute bottom-0 left-0 w-[calc(50%-0.875rem)]"
              style={{ transform: mode === 'register' ? 'translateX(calc(100% + 1.75rem))' : undefined }}
            >
              <span className="block h-[3px] w-7 rounded-full bg-emerald-600" />
            </span>
          </div>

          <div className="space-y-5">
            <label className="login-rise group block" style={{ animationDelay: '120ms' }}>
              <span className={LABEL}>邮箱</span>
              <span className={FIELD}>
                <Mail size={17} className="shrink-0 text-[#9ca3af]" />
                <input
                  type="email"
                  required
                  autoComplete="email"
                  placeholder="name@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={INPUT}
                />
              </span>
            </label>

            <label className="login-rise group block" style={{ animationDelay: '170ms' }}>
              <span className={LABEL}>密码</span>
              <span className={FIELD}>
                <Lock size={17} className="shrink-0 text-[#9ca3af]" />
                <input
                  type={showPassword ? 'text' : 'password'}
                  required
                  minLength={mode === 'register' ? 8 : undefined}
                  autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                  placeholder={mode === 'register' ? '至少 8 位' : '输入密码'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={INPUT}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? '隐藏密码' : '显示密码'}
                  className="-mr-1.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[#9ca3af] transition-colors hover:bg-[#f0f1f3] hover:text-sidebar-muted focus-visible:outline-2 focus-visible:outline-emerald-600"
                >
                  {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </span>
            </label>
          </div>

          {error && (
            <div
              role="alert"
              className="login-pop mt-5 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-700"
            >
              <CircleAlert size={16} className="mt-px shrink-0" />
              {error}
            </div>
          )}

          <button
            disabled={busy}
            className="login-rise group mt-8 flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-emerald-700 text-[15px] font-bold text-white shadow-[0_1px_0_rgba(255,255,255,0.18)_inset,0_6px_16px_-8px_rgba(4,120,87,0.7)] transition-[background-color,transform] hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 active:scale-[0.98] disabled:cursor-wait disabled:bg-emerald-700/80"
            style={{ animationDelay: '220ms' }}
          >
            {busy ? (
              <>
                <Loader2 size={17} className="animate-spin" />
                {mode === 'login' ? '登录中…' : '注册中…'}
              </>
            ) : (
              <>
                {mode === 'login' ? '登录' : '注册并登录'}
                <ArrowRight size={17} className="transition-transform group-hover:translate-x-0.5" />
              </>
            )}
          </button>
        </form>
      </main>
    </div>
  )
}
