import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { api, setUnauthorizedHandler, tokenStore } from '../api/client'
import type { LoginResponse, UserInfo } from '../api/types'

interface AuthState {
  user: UserInfo | null
  loading: boolean
  login: (email: string, password: string) => Promise<void>
  register: (email: string, password: string, nickname?: string) => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserInfo | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null))
    if (!tokenStore.get()) {
      setLoading(false)
      return
    }
    api<UserInfo>('/auth/me')
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false))
  }, [])

  const handleLogin = useCallback((res: LoginResponse) => {
    tokenStore.set(res.token)
    setUser(res.user)
  }, [])

  const login = useCallback(
    async (email: string, password: string) => {
      handleLogin(await api<LoginResponse>('/auth/login', { method: 'POST', body: { email, password } }))
    },
    [handleLogin],
  )

  const register = useCallback(
    async (email: string, password: string, nickname?: string) => {
      handleLogin(await api<LoginResponse>('/auth/register', { method: 'POST', body: { email, password, nickname } }))
    },
    [handleLogin],
  )

  const logout = useCallback(async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {})
    tokenStore.clear()
    setUser(null)
  }, [])

  return <AuthContext.Provider value={{ user, loading, login, register, logout }}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth 必须在 AuthProvider 内使用')
  return ctx
}
