import { createBrowserRouter, Navigate } from 'react-router'
import AppShell from './layout/AppShell'
import RequireAuth from './auth/RequireAuth'
import LoginPage from './pages/LoginPage'
import PictureBooksPage from './pages/picture-books/PictureBooksPage'
import PlaceholderPage from './pages/PlaceholderPage'
import ReviewPage from './pages/review/ReviewPage'
import EditorPage from './pages/editor/EditorPage'
import ReaderPage from './pages/reader/ReaderPage'

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
        element: <PlaceholderPage title="动画源" description="动画源功能待开放，当前版本请使用绘本。" />,
      },
      {
        path: '/toolbox',
        element: <PlaceholderPage title="工具箱" description="工具箱功能待开放。" />,
      },
      // web-editor：校对页与编辑器在 AppShell 内，页面自身 fixed 全屏覆盖（原版 z50/z210）
      { path: '/picture-books/:id/review', element: <ReviewPage /> },
      { path: '/picture-books/:id/editor', element: <EditorPage /> },
    ],
  },
  // web-editor：阅读器全屏不带侧栏，仍需登录
  {
    path: '/reader/:id',
    element: (
      <RequireAuth>
        <ReaderPage />
      </RequireAuth>
    ),
  },
  { path: '*', element: <Navigate to="/" replace /> },
])
