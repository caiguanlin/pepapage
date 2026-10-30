import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { ArrowDown, ArrowLeft, ArrowUp, ChevronRight, Download, FolderInput, FolderPlus, Plus, Trash2, Upload } from 'lucide-react'
import { coursewareApi, folderApi, projectApi } from '../../api/books'
import type { BookFolder, BookProject } from '../../api/types'
import TopBar from '../../layout/TopBar'
import { FolderCard, ProjectCard, type CardAction } from './ProjectCard'
import CreateBookDialog from './CreateBookDialog'
import { MoveDialog, NameDialog, ProjectDetailDialog } from './WorkbenchDialogs'

type SortKey = 'createdAt' | 'title'

type Modal =
  | { kind: 'newFolder' }
  | { kind: 'renameFolder'; folder: BookFolder }
  | { kind: 'renameProject'; project: BookProject }
  | { kind: 'move'; projectIds: string[]; folderIds: string[] }
  | { kind: 'detail'; project: BookProject }
  | null

const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })

export default function PictureBooksPage() {
  const { folderId = null } = useParams()
  const navigate = useNavigate()
  const [folders, setFolders] = useState<BookFolder[]>([])
  const [projects, setProjects] = useState<BookProject[] | null>(null)
  const [keyword, setKeyword] = useState('')
  const [sort, setSort] = useState<SortKey>('createdAt')
  const [order, setOrder] = useState<'asc' | 'desc'>('desc')
  const [selectedProjects, setSelectedProjects] = useState<Set<string>>(new Set())
  const [selectedFolders, setSelectedFolders] = useState<Set<string>>(new Set())
  const [createOpen, setCreateOpen] = useState(false)
  const [modal, setModal] = useState<Modal>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const importInput = useRef<HTMLInputElement>(null)

  const kw = keyword.trim()
  const searching = kw.length > 0

  const load = useCallback(async () => {
    try {
      const [fs, ps] = await Promise.all([folderApi.list(), projectApi.list({ folderId, keyword: kw, sort, order })])
      setFolders(fs)
      setProjects(ps)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
      setProjects((prev) => prev ?? [])
    }
  }, [folderId, kw, sort, order])

  useEffect(() => {
    load()
  }, [load])

  // 切换文件夹或搜索时清除选中项
  useEffect(() => {
    setSelectedProjects(new Set())
    setSelectedFolders(new Set())
  }, [folderId, kw])

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 4000)
    return () => clearTimeout(t)
  }, [notice])

  // 有制作中的项目时每 3 秒刷新一次
  const hasRunning = projects?.some((p) => p.status === 'processing' || p.status === 'uploading')
  useEffect(() => {
    if (!hasRunning) return
    const t = setInterval(load, 3000)
    return () => clearInterval(t)
  }, [hasRunning, load])

  const currentFolder = folderId ? folders.find((f) => f.id === folderId) : undefined

  const childFolders = useMemo(() => {
    const list = searching
      ? folders.filter((f) => f.name.toLowerCase().includes(kw.toLowerCase()))
      : folders.filter((f) => (f.parentId ?? null) === folderId)
    const dir = order === 'asc' ? 1 : -1
    return [...list].sort((a, b) =>
      sort === 'title'
        ? dir * collator.compare(a.name, b.name)
        : dir * (new Date(a.updatedAt ?? a.createdAt).getTime() - new Date(b.updatedAt ?? b.createdAt).getTime()),
    )
  }, [folders, folderId, searching, kw, sort, order])

  const sortedProjects = useMemo(() => {
    if (!projects) return null
    const dir = order === 'asc' ? 1 : -1
    return [...projects].sort((a, b) =>
      sort === 'title'
        ? dir * collator.compare(a.title, b.title)
        : dir * (new Date(a.updatedAt ?? a.createdAt).getTime() - new Date(b.updatedAt ?? b.createdAt).getTime()),
    )
  }, [projects, sort, order])

  const folderItemCount = useMemo(() => {
    const m = new Map<string, number>()
    for (const f of folders) if (f.parentId) m.set(f.parentId, (m.get(f.parentId) ?? 0) + 1)
    return m
  }, [folders])

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

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const clearSelection = () => {
    setSelectedProjects(new Set())
    setSelectedFolders(new Set())
  }

  async function importCourseware(file: File | undefined) {
    if (!file) return
    await run('import', async () => {
      const list = await coursewareApi.import(file, folderId)
      setNotice(`已导入 ${list.length} 个项目`)
      await load()
    })
  }

  async function exportCourseware(projectIds: string[], folderIds: string[]) {
    if (projectIds.length === 0 && folderIds.length === 0) return
    await run('export', async () => {
      const r = await coursewareApi.export(projectIds, folderIds)
      const a = document.createElement('a')
      a.href = r.url
      a.download = r.fileName
      a.rel = 'noopener'
      document.body.appendChild(a)
      a.click()
      a.remove()
      setNotice(`已生成课件包：${r.fileName}`)
    })
  }

  async function deleteItems(projectIds: string[], folderIds: string[]) {
    const parts = []
    if (folderIds.length) parts.push(`${folderIds.length} 个文件夹（其中内容将移到上一级）`)
    if (projectIds.length) parts.push(`${projectIds.length} 个项目（关联的书籍和音频文件也会删除）`)
    if (!window.confirm(`确定永久删除 ${parts.join('、')}？`)) return
    await run('delete', async () => {
      for (const id of folderIds) await folderApi.remove(id)
      if (projectIds.length) await projectApi.batchDelete(projectIds)
      clearSelection()
      await load()
    })
  }

  async function moveItems(projectIds: string[], folderIds: string[], target: string | null) {
    for (const id of folderIds) await folderApi.move(id, target)
    if (projectIds.length) await projectApi.move(projectIds, target)
    clearSelection()
    await load()
  }

  function retry(id: string) {
    if (!window.confirm('重新制作该项目？')) return
    run('retry', async () => {
      await projectApi.retry(id)
      await load()
    })
  }

  function onProjectAction(p: BookProject, a: CardAction) {
    switch (a) {
      case 'detail':
        setModal({ kind: 'detail', project: p })
        break
      case 'editor':
        navigate(`/picture-books/${p.id}/editor`)
        break
      case 'realign':
        if (!window.confirm('使用校对后的文本重新对齐？已有对齐结果将被覆盖。')) return
        run('realign', async () => {
          await projectApi.realign(p.id)
          setNotice('已开始重新对齐')
          await load()
        })
        break
      case 'rename':
        setModal({ kind: 'renameProject', project: p })
        break
      case 'move':
        setModal({ kind: 'move', projectIds: [p.id], folderIds: [] })
        break
      case 'export':
        exportCourseware([p.id], [])
        break
      case 'delete':
        deleteItems([p.id], [])
        break
    }
  }

  function onFolderAction(f: BookFolder, a: 'rename' | 'move' | 'export' | 'delete') {
    if (a === 'rename') setModal({ kind: 'renameFolder', folder: f })
    else if (a === 'move') setModal({ kind: 'move', projectIds: [], folderIds: [f.id] })
    else if (a === 'export') exportCourseware([], [f.id])
    else deleteItems([], [f.id])
  }

  const toggle = (set: React.Dispatch<React.SetStateAction<Set<string>>>, id: string) =>
    set((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const allProjectIds = sortedProjects?.map((p) => p.id) ?? []
  const allFolderIds = childFolders.map((f) => f.id)
  const totalItems = allProjectIds.length + allFolderIds.length
  const selectedCount = selectedProjects.size + selectedFolders.size
  const allSelected = totalItems > 0 && selectedCount === totalItems
  const isEmpty = sortedProjects !== null && totalItems === 0
  const exportableSelected =
    [...selectedProjects].some((id) => projects?.find((p) => p.id === id)?.status === 'completed') || selectedFolders.size > 0

  const breadcrumb = (
    <>
      <Link to="/picture-books" className={crumbs.length || searching ? 'hover:text-slate-800' : 'font-bold text-slate-800'}>
        绘本源
      </Link>
      {crumbs.map((f, i) => (
        <span key={f.id} className="flex min-w-0 items-center gap-2">
          <ChevronRight size={14} className="shrink-0" />
          <Link
            to={`/picture-books/folder/${f.id}`}
            className={`truncate ${i === crumbs.length - 1 && !searching ? 'font-bold text-slate-800' : 'hover:text-slate-800'}`}
          >
            {f.name}
          </Link>
        </span>
      ))}
      {searching && (
        <span className="flex items-center gap-2">
          <ChevronRight size={14} />
          <span className="font-bold text-slate-800">搜索“{kw}”</span>
        </span>
      )}
    </>
  )

  const btn = 'flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50'
  const actionButtons = (
    <>
      <button disabled={busy === 'import'} onClick={() => importInput.current?.click()} className={btn}>
        <Upload size={16} /> {busy === 'import' ? '导入中…' : '导入课件'}
      </button>
      <button onClick={() => setModal({ kind: 'newFolder' })} className={btn}>
        <FolderPlus size={16} /> 新建文件夹
      </button>
      <button
        onClick={() => setCreateOpen(true)}
        className="flex items-center gap-1.5 rounded-full bg-indigo-600 px-4 py-2 text-sm font-bold text-white shadow-sm hover:bg-indigo-700"
      >
        <Plus size={16} /> 制作项目
      </button>
    </>
  )

  return (
    <>
      <TopBar breadcrumb={breadcrumb} search={keyword} onSearchChange={setKeyword} />
      <input
        ref={importInput}
        type="file"
        accept=".nexusbookpkg,.zip"
        hidden
        onChange={(e) => {
          importCourseware(e.target.files?.[0])
          e.target.value = ''
        }}
      />

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-7xl p-8 pb-20">
          <div className="mb-6 flex flex-wrap items-center gap-3">
            {folderId && !searching && (
              <button
                onClick={() =>
                  navigate(currentFolder?.parentId ? `/picture-books/folder/${currentFolder.parentId}` : '/picture-books')
                }
                className="flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                title="返回上一级"
              >
                <ArrowLeft size={16} />
              </button>
            )}
            <h1 className="mr-2 truncate text-xl font-bold text-slate-800">
              {searching ? '搜索结果' : (currentFolder?.name ?? '工作台')}
            </h1>
            <div className="flex flex-wrap items-center gap-2">{actionButtons}</div>
          </div>

          <div className="mb-5 flex flex-wrap items-center gap-2 text-sm">
            {(['createdAt', 'title'] as const).map((k) => (
              <button
                key={k}
                onClick={() => toggleSort(k)}
                className={`flex items-center gap-1 rounded-full px-3 py-1.5 ${
                  sort === k ? 'bg-slate-800 text-white' : 'text-slate-500 hover:bg-slate-100'
                }`}
              >
                {k === 'createdAt' ? '创建日期' : '名称'}
                {sort === k && (order === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
              </button>
            ))}
            <button
              disabled={totalItems === 0}
              onClick={() => {
                if (allSelected) clearSelection()
                else {
                  setSelectedProjects(new Set(allProjectIds))
                  setSelectedFolders(new Set(allFolderIds))
                }
              }}
              className="rounded-full px-3 py-1.5 text-slate-500 hover:bg-slate-100 disabled:opacity-40"
            >
              {allSelected ? '取消全选' : '全选'}
            </button>

            {selectedCount > 0 && (
              <div className="ml-auto flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-1 text-indigo-700">
                <span className="px-2 font-bold">已选 {selectedCount} 项</span>
                <button
                  disabled={!exportableSelected || busy === 'export'}
                  onClick={() => exportCourseware([...selectedProjects], [...selectedFolders])}
                  title={exportableSelected ? '导出为课件包' : '仅已完成的项目可导出'}
                  className="flex items-center gap-1 rounded-full px-3 py-1 hover:bg-indigo-100 disabled:opacity-40"
                >
                  <Download size={14} /> {busy === 'export' ? '导出中…' : '导出课件'}
                </button>
                <button
                  onClick={() => setModal({ kind: 'move', projectIds: [...selectedProjects], folderIds: [...selectedFolders] })}
                  className="flex items-center gap-1 rounded-full px-3 py-1 hover:bg-indigo-100"
                >
                  <FolderInput size={14} /> 移动
                </button>
                <button
                  disabled={busy === 'delete'}
                  onClick={() => deleteItems([...selectedProjects], [...selectedFolders])}
                  className="flex items-center gap-1 rounded-full px-3 py-1 text-rose-600 hover:bg-rose-50"
                >
                  <Trash2 size={14} /> 删除
                </button>
                <button onClick={clearSelection} className="rounded-full px-3 py-1 text-slate-500 hover:bg-indigo-100">
                  取消
                </button>
              </div>
            )}
          </div>

          {error && (
            <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-600">{error}</div>
          )}
          {notice && (
            <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</div>
          )}

          {sortedProjects === null ? (
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
              {Array.from({ length: 4 }, (_, i) => (
                <div key={i} className="h-48 animate-pulse rounded-3xl bg-slate-200" />
              ))}
            </div>
          ) : isEmpty ? (
            <div className="flex flex-col items-center justify-center gap-3 rounded-3xl border border-dashed border-slate-300 py-24 text-slate-400">
              <p className="text-base font-bold text-slate-600">{searching ? '没有找到匹配的项目' : '这里还是空的'}</p>
              <p className="text-sm">{searching ? '换个关键词试试' : '导入课包，或上传 PDF / 图片制作第一本点读绘本'}</p>
              {!searching && (
                <div className="mt-2 flex gap-2">
                  <button onClick={() => importInput.current?.click()} className={btn}>
                    <Upload size={16} /> 导入课包
                  </button>
                  <button onClick={() => setModal({ kind: 'newFolder' })} className={btn}>
                    <FolderPlus size={16} /> 新建文件夹
                  </button>
                  <button
                    onClick={() => setCreateOpen(true)}
                    className="flex items-center gap-1.5 rounded-full bg-indigo-600 px-4 py-2 text-sm font-bold text-white hover:bg-indigo-700"
                  >
                    <Plus size={16} /> 制作项目
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
              {childFolders.map((f) => (
                <FolderCard
                  key={f.id}
                  folder={f}
                  itemCount={folderItemCount.get(f.id)}
                  selected={selectedFolders.has(f.id)}
                  onOpen={() => {
                    setKeyword('')
                    navigate(`/picture-books/folder/${f.id}`)
                  }}
                  onToggleSelect={() => toggle(setSelectedFolders, f.id)}
                  onAction={(a) => onFolderAction(f, a)}
                />
              ))}
              {sortedProjects.map((p) => (
                <ProjectCard
                  key={p.id}
                  project={p}
                  selected={selectedProjects.has(p.id)}
                  onToggleSelect={() => toggle(setSelectedProjects, p.id)}
                  onOpen={() => navigate(`/reader/${p.id}`)}
                  onReview={() => navigate(`/picture-books/${p.id}/review`)}
                  onRetry={() => retry(p.id)}
                  onAction={(a) => onProjectAction(p, a)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <CreateBookDialog open={createOpen} folderId={folderId} onClose={() => setCreateOpen(false)} onCreated={load} />

      {modal?.kind === 'newFolder' && (
        <NameDialog
          title="新建文件夹"
          placeholder="文件夹名称"
          onClose={() => setModal(null)}
          onSubmit={async (name) => {
            await folderApi.create(name, folderId)
            await load()
          }}
        />
      )}
      {modal?.kind === 'renameFolder' && (
        <NameDialog
          title="重命名文件夹"
          initial={modal.folder.name}
          onClose={() => setModal(null)}
          onSubmit={async (name) => {
            await folderApi.rename(modal.folder.id, name)
            await load()
          }}
        />
      )}
      {modal?.kind === 'renameProject' && (
        <NameDialog
          title="重命名项目"
          initial={modal.project.title}
          onClose={() => setModal(null)}
          onSubmit={async (name) => {
            await projectApi.rename(modal.project.id, name)
            await load()
          }}
        />
      )}
      {modal?.kind === 'move' && (
        <MoveDialog
          folders={folders}
          excludeFolderIds={modal.folderIds}
          currentFolderId={searching ? undefined as unknown as null : folderId}
          count={modal.projectIds.length + modal.folderIds.length}
          onClose={() => setModal(null)}
          onSubmit={(target) => moveItems(modal.projectIds, modal.folderIds, target)}
        />
      )}
      {modal?.kind === 'detail' && <ProjectDetailDialog project={modal.project} onClose={() => setModal(null)} />}
    </>
  )
}
