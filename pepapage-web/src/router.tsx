import { createBrowserRouter, Navigate } from 'react-router'
import AppShell from './layout/AppShell'
import RequireAuth from './auth/RequireAuth'
import LoginPage from './pages/LoginPage'
import PictureBooksPage from './pages/picture-books/PictureBooksPage'
import PlaceholderPage from './pages/PlaceholderPage'

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    element: (
      <RequireAuth>
        <AppShell />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <Navigate to="/picture-books" replace /> },
      { path: '/picture-books', element: <PictureBooksPage /> },
      { path: '/picture-books/folder/:folderId', element: <PictureBooksPage /> },
      {
        path: '/animations',
        element: <PlaceholderPage title="动画源" description="动画源功能待开放，当前版本请使用绘本源。" />,
      },
      {
        path: '/toolbox',
        element: <PlaceholderPage title="工具箱" description="工具箱功能待开放。" />,
      },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
])
