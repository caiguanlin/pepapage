import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { ArrowDownUp, ChevronRight, FolderPlus, Plus, Trash2, Upload } from 'lucide-react'
import { folderApi, projectApi } from '../../api/books'
import type { BookFolder, BookProject } from '../../api/types'
import TopBar from '../../layout/TopBar'
import { FolderCard, ProjectCard } from './ProjectCard'
import CreateBookDialog from './CreateBookDialog'

type SortKey = 'createdAt' | 'title'

export default function PictureBooksPage() {
  const { folderId = null } = useParams()
  const navigate = useNavigate()
  const [folders, setFolders] = useState<BookFolder[]>([])
  const [projects, setProjects] = useState<BookProject[] | null>(null)
  const [keyword, setKeyword] = useState('')
  const [sort, setSort] = useState<SortKey>('createdAt')
  const [order, setOrder] = useState<'asc' | 'desc'>('desc')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [createOpen, setCreateOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [fs, ps] = await Promise.all([
        folderApi.list(),
        projectApi.list({ folderId, keyword: keyword.trim(), sort, order }),
      ])
      setFolders(fs)
      setProjects(ps)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
      setProjects((prev) => prev ?? [])
    }
  }, [folderId, keyword, sort, order])

  useEffect(() => {
    load()
  }, [load])

  // 切换文件夹或搜索时清除选中项
  useEffect(() => setSelected(new Set()), [folderId, keyword])

  // 有制作中的项目时每 3 秒刷新一次
  const hasRunning = projects?.some((p) => p.status === 'processing' || p.status === 'uploading')
  useEffect(() => {
    if (!hasRunning) return
    const t = setInterval(load, 3000)
    return () => clearInterval(t)
  }, [hasRunning, load])

  const searching = keyword.trim().length > 0
  const childFolders = useMemo(
    () =>
      searching
        ? folders.filter((f) => f.name.includes(keyword.trim()))
        : folders.filter((f) => (f.parentId ?? null) === folderId),
    [folders, folderId, searching, keyword],
  )

  const crumbs = useMemo(() => {
    const byId = new Map(folders.map((f) => [f.id, f]))
    const list: BookFolder[] = []
    for (let cur = folderId ? byId.get(folderId) : undefined; cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
      list.unshift(cur)
    }
    return list
  }, [folders, folderId])

  function toggleSort(key: SortKey) {
    if (sort === key) setOrder(order === 'asc' ? 'desc' : 'asc')
    else {
      setSort(key)
      setOrder(key === 'title' ? 'asc' : 'desc')
    }
  }

  async function createFolder() {
    const name = window.prompt('文件夹名称')?.trim()
    if (!name) return
    try {
      await folderApi.create(name, folderId)
      load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function deleteSelected() {
    if (!window.confirm(`确定永久删除选中的 ${selected.size} 个项目？关联的书籍和音频文件也会删除。`)) return
    try {
      await projectApi.batchDelete([...selected])
      setSelected(new Set())
      load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function retry(id: string) {
    if (!window.confirm('重新制作该项目？')) return
    try {
      await projectApi.retry(id)
      load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const allIds = projects?.map((p) => p.id) ?? []
  const allSelected = allIds.length > 0 && allIds.every((id) => selected.has(id))
  const isEmpty = projects !== null && projects.length === 0 && childFolders.length === 0

  const breadcrumb = (
    <>
      <Link to="/picture-books" className={crumbs.length ? 'hover:text-slate-800' : 'font-bold text-slate-800'}>
        绘本源
      </Link>
      {crumbs.map((f, i) => (
        <span key={f.id} className="flex items-center gap-2">
          <ChevronRight size={14} />
          <Link
            to={`/picture-books/folder/${f.id}`}
            className={i === crumbs.length - 1 ? 'font-bold text-slate-800' : 'hover:text-slate-800'}
          >
            {f.name}
          </Link>
        </span>
      ))}
    </>
  )

  const actionButtons = (
    <>
      <button
        disabled
        title="课件导入将在阶段 5 实现"
        className="flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm text-slate-600 disabled:opacity-50"
      >
        <Upload size={16} /> 导入课件
      </button>
      <button
        onClick={createFolder}
        className="flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm text-slate-600 hover:bg-slate-50"
      >
        <FolderPlus size={16} /> 新建文件夹
      </button>
      <button
        onClick={() => setCreateOpen(true)}
        className="flex items-center gap-1.5 rounded-full bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-700"
      >
        <Plus size={16} /> 制作项目
      </button>
    </>
  )

  return (
    <>
      <TopBar breadcrumb={breadcrumb} search={keyword} onSearchChange={setKeyword} />

      <div className="flex-1 overflow-y-auto px-8 py-6">
        <div className="mb-6 flex flex-wrap items-center gap-2">
          {actionButtons}
          <div className="ml-auto flex items-center gap-2 text-sm">
            {selected.size > 0 && (
              <button onClick={deleteSelected} className="flex items-center gap-1 rounded-full px-3 py-1.5 text-rose-600 hover:bg-rose-50">
                <Trash2 size={14} /> 删除（{selected.size}）
              </button>
            )}
            {(['createdAt', 'title'] as const).map((k) => (
              <button
                key={k}
                onClick={() => toggleSort(k)}
                className={`flex items-center gap-1 rounded-full px-3 py-1.5 ${
                  sort === k ? 'bg-slate-200 text-slate-800' : 'text-slate-500 hover:bg-slate-100'
                }`}
              >
                {k === 'createdAt' ? '创建日期' : '名称'}
                {sort === k && <ArrowDownUp size={12} className={order === 'asc' ? 'rotate-180' : ''} />}
              </button>
            ))}
            <button
              disabled={allIds.length === 0}
              onClick={() => setSelected(allSelected ? new Set() : new Set(allIds))}
              className="rounded-full px-3 py-1.5 text-slate-500 hover:bg-slate-100 disabled:opacity-40"
            >
              {allSelected ? '取消全选' : '全选'}
            </button>
          </div>
        </div>

        {error && <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-600">{error}</div>}

        {projects === null ? (
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="h-48 animate-pulse rounded-3xl bg-slate-200" />
            ))}
          </div>
        ) : isEmpty ? (
          <div className="flex flex-col items-center justify-center gap-3 py-24 text-slate-400">
            <p className="text-base font-bold text-slate-600">{searching ? '没有找到匹配的项目' : '工作空间还是空的'}</p>
            {!searching && <p className="text-sm">导入课件，或上传 PDF 制作第一本点读绘本</p>}
            {!searching && <div className="mt-2 flex gap-2">{actionButtons}</div>}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
            {childFolders.map((f) => (
              <FolderCard key={f.id} folder={f} onOpen={() => navigate(`/picture-books/folder/${f.id}`)} />
            ))}
            {projects.map((p) => (
              <ProjectCard
                key={p.id}
                project={p}
                selected={selected.has(p.id)}
                onToggleSelect={() =>
                  setSelected((prev) => {
                    const next = new Set(prev)
                    if (next.has(p.id)) next.delete(p.id)
                    else next.add(p.id)
                    return next
                  })
                }
                onRetry={() => retry(p.id)}
              />
            ))}
          </div>
        )}
      </div>

      <CreateBookDialog open={createOpen} folderId={folderId} onClose={() => setCreateOpen(false)} onCreated={load} />
    </>
  )
}
