import { useMemo, useRef, useState } from 'react'
import type { ActionSlip, FocusSession, PersonalNote } from '../types'

interface NotesPageProps {
  actionSlips: ActionSlip[]
  personalNotes: PersonalNote[]
  focusSessions: FocusSession[]
  onAdd: (title: string, startNow?: boolean) => void
  onStart: (slip: ActionSlip, assisted: boolean) => void
  onComplete: (id: string) => void
  onReopen: (id: string) => void
  onUpdate: (id: string, title: string) => void
  onRemove: (id: string) => void
  onAddNote: (title: string, content: string) => void
  onUpdateNote: (id: string, title: string, content: string) => void
  onRemoveNote: (id: string) => void
}

type NotesSection = 'notes' | 'todos'

function dateTimeLabel(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(value))
}

function noteDateLabel(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: new Date(value).getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date(value))
}

function NoteIcon() {
  return <span className="notes-section-icon" aria-hidden="true">▤</span>
}

function TodoIcon() {
  return <span className="notes-section-icon todo" aria-hidden="true">✓</span>
}

export function NotesPage({
  actionSlips,
  personalNotes,
  focusSessions,
  onAdd,
  onStart,
  onComplete,
  onReopen,
  onUpdate,
  onRemove,
  onAddNote,
  onUpdateNote,
  onRemoveNote,
}: NotesPageProps) {
  const [activeSection, setActiveSection] = useState<NotesSection>(() => personalNotes.length ? 'notes' : actionSlips.length ? 'todos' : 'notes')
  const [captureText, setCaptureText] = useState('')
  const [listMode, setListMode] = useState<'open' | 'completed'>('open')
  const [todoSearchText, setTodoSearchText] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingText, setEditingText] = useState('')
  const [noteSearchText, setNoteSearchText] = useState('')
  const [noteComposerOpen, setNoteComposerOpen] = useState(false)
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null)
  const [noteTitle, setNoteTitle] = useState('')
  const [noteContent, setNoteContent] = useState('')
  const captureInputRef = useRef<HTMLInputElement>(null)
  const noteTitleRef = useRef<HTMLInputElement>(null)

  const currentSlip = [...actionSlips].reverse().find((item) => item.status === 'current')
  const inboxCount = actionSlips.filter((item) => item.status === 'inbox').length
  const completedCount = actionSlips.filter((item) => item.status === 'completed').length
  const openCount = inboxCount + (currentSlip ? 1 : 0)
  const normalizedTodoSearch = todoSearchText.trim().toLocaleLowerCase()
  const visibleSlips = actionSlips
    .filter((item) => listMode === 'open' ? item.status === 'inbox' : item.status === 'completed')
    .filter((item) => !normalizedTodoSearch || `${item.title} ${item.nextStep ?? ''}`.toLocaleLowerCase().includes(normalizedTodoSearch))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))

  const normalizedNoteSearch = noteSearchText.trim().toLocaleLowerCase()
  const visibleNotes = personalNotes
    .filter((note) => !normalizedNoteSearch || `${note.title} ${note.content}`.toLocaleLowerCase().includes(normalizedNoteSearch))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))

  const activity = useMemo(() => {
    const linkedFocus = focusSessions.filter((session) => session.actionSlipId).map((session) => ({
      id: `focus-${session.id}`,
      at: session.completedAt,
      label: `专注 ${Math.max(1, Math.round(session.actualDurationSec / 60))} 分钟`,
      detail: session.nextStep ? `${session.taskName} · 下一步：${session.nextStep}` : session.taskName,
    }))
    const manualCompletions = actionSlips
      .filter((slip) => slip.status === 'completed' && slip.completedAt && slip.focusSessionIds.length === 0)
      .map((slip) => ({ id: `slip-${slip.id}`, at: slip.completedAt!, label: '标记完成', detail: slip.title }))
    return [...linkedFocus, ...manualCompletions]
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
      .slice(0, 8)
  }, [actionSlips, focusSessions])

  function capture(startNow: boolean) {
    const clean = captureText.trim()
    if (!clean) return
    onAdd(clean, startNow)
    setCaptureText('')
  }

  function beginEdit(slip: ActionSlip) {
    setEditingId(slip.id)
    setEditingText(slip.title)
  }

  function saveEdit() {
    const clean = editingText.trim()
    if (!editingId || !clean) return
    onUpdate(editingId, clean)
    setEditingId(null)
    setEditingText('')
  }

  function removeSlip(slip: ActionSlip) {
    if (window.confirm(`移除“${slip.title}”？`)) onRemove(slip.id)
  }

  function openNewNote() {
    setEditingNoteId(null)
    setNoteTitle('')
    setNoteContent('')
    setNoteComposerOpen(true)
    window.setTimeout(() => noteTitleRef.current?.focus(), 0)
  }

  function beginNoteEdit(note: PersonalNote) {
    setEditingNoteId(note.id)
    setNoteTitle(note.title)
    setNoteContent(note.content)
    setNoteComposerOpen(true)
    window.setTimeout(() => noteTitleRef.current?.focus(), 0)
  }

  function closeNoteComposer() {
    setNoteComposerOpen(false)
    setEditingNoteId(null)
    setNoteTitle('')
    setNoteContent('')
  }

  function saveNote() {
    if (!noteTitle.trim() && !noteContent.trim()) return
    if (editingNoteId) onUpdateNote(editingNoteId, noteTitle, noteContent)
    else onAddNote(noteTitle, noteContent)
    closeNoteComposer()
  }

  function removeNote(note: PersonalNote) {
    if (!window.confirm(`移除笔记“${note.title}”？`)) return
    onRemoveNote(note.id)
    if (editingNoteId === note.id) closeNoteComposer()
  }

  function focusTodoCapture() {
    setActiveSection('todos')
    window.setTimeout(() => captureInputRef.current?.focus(), 0)
  }

  return (
    <section className="page-width inner-page notes-page">
      <header className="notes-page-heading">
        <div>
          <p className="eyebrow">灵感与行动</p>
          <h1>便签</h1>
          <p>笔记留住想法，待办承接行动。只记录真正值得留下的内容，不让整理成为新的负担。</p>
        </div>
        <div className="notes-overview" aria-label="便签概览">
          <span><strong>{personalNotes.length}</strong><small>篇笔记</small></span>
          <span><strong>{openCount}</strong><small>项待办</small></span>
          <span><strong>{completedCount}</strong><small>项完成</small></span>
        </div>
      </header>

      <div className="notes-section-switch" role="tablist" aria-label="便签类型">
        <button
          type="button"
          role="tab"
          aria-selected={activeSection === 'notes'}
          className={activeSection === 'notes' ? 'active' : ''}
          onClick={() => setActiveSection('notes')}
        >
          <NoteIcon />
          <span><strong>笔记</strong><small>收好想法与片段</small></span>
          <b>{personalNotes.length}</b>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeSection === 'todos'}
          className={activeSection === 'todos' ? 'active' : ''}
          onClick={() => setActiveSection('todos')}
        >
          <TodoIcon />
          <span><strong>待办</strong><small>选一件，然后开始</small></span>
          <b>{openCount}</b>
        </button>
      </div>

      {activeSection === 'notes' ? (
        <div className="personal-notes-section" role="tabpanel">
          <div className="notes-content-toolbar">
            <div><h2>我的笔记</h2><p>按最近编辑排序，内容自动保存在本机。</p></div>
            <div>
              <label className="notes-search-field">
                <span aria-hidden="true">⌕</span>
                <input value={noteSearchText} onChange={(event) => setNoteSearchText(event.target.value)} placeholder="搜索标题或正文" aria-label="搜索笔记" />
              </label>
              <button type="button" className="button primary notes-new-button" onClick={openNewNote}><span>＋</span> 新建笔记</button>
            </div>
          </div>

          {noteComposerOpen && (
            <article className="note-composer card-surface">
              <div className="note-composer-heading">
                <div><p className="eyebrow">{editingNoteId ? '编辑笔记' : '新笔记'}</p><h2>{editingNoteId ? '继续整理这段想法' : '现在记下，不必写完整'}</h2></div>
                <button type="button" aria-label="关闭笔记编辑器" onClick={closeNoteComposer}>×</button>
              </div>
              <label>
                <span>标题</span>
                <input ref={noteTitleRef} value={noteTitle} maxLength={80} onChange={(event) => setNoteTitle(event.target.value)} placeholder="给这条笔记一个容易找到的名字" />
              </label>
              <label>
                <span>正文</span>
                <textarea value={noteContent} maxLength={6000} rows={8} onChange={(event) => setNoteContent(event.target.value)} placeholder="写下一段想法、观察或需要保留的信息……" />
              </label>
              <div className="note-composer-footer">
                <small>{noteContent.length} / 6000 · 标题留空时会使用正文第一行</small>
                <div><button type="button" className="button secondary" onClick={closeNoteComposer}>取消</button><button type="button" className="button primary" disabled={!noteTitle.trim() && !noteContent.trim()} onClick={saveNote}>保存笔记</button></div>
              </div>
            </article>
          )}

          {visibleNotes.length ? (
            <div className="personal-notes-grid">
              {visibleNotes.map((note, index) => (
                <article key={note.id} className={`personal-note-card card-surface tone-${index % 4}`}>
                  <div className="personal-note-card-heading">
                    <span aria-hidden="true">{index % 3 === 0 ? '✦' : index % 3 === 1 ? '·' : '○'}</span>
                    <div><button type="button" onClick={() => beginNoteEdit(note)}>编辑</button><button type="button" onClick={() => removeNote(note)}>移除</button></div>
                  </div>
                  <button type="button" className="personal-note-open" onClick={() => beginNoteEdit(note)}>
                    <h3>{note.title}</h3>
                    <p className={note.content ? '' : 'empty-copy'}>{note.content || '这是一条只有标题的简短笔记。'}</p>
                    <time>{noteDateLabel(note.updatedAt)}{note.updatedAt !== note.createdAt ? ' · 已编辑' : ''}</time>
                  </button>
                </article>
              ))}
            </div>
          ) : (
            <div className="notes-blank-state card-surface">
              <NoteIcon />
              <h2>{noteSearchText ? '没有找到相符的笔记' : '从一条轻松的笔记开始'}</h2>
              <p>{noteSearchText ? '换个关键词试试，或清空搜索查看全部内容。' : '记下一段想法、一次复盘，或者任何不想忘记的片段。没有分类和整理要求。'}</p>
              {noteSearchText ? <button type="button" className="button secondary" onClick={() => setNoteSearchText('')}>清空搜索</button> : <button type="button" className="button primary" onClick={openNewNote}>写第一篇笔记</button>}
            </div>
          )}
        </div>
      ) : (
        <div className="todo-section" role="tabpanel">
          <div className="action-capture card-surface todo-capture">
            <div className="todo-capture-copy"><span className="todo-capture-icon" aria-hidden="true">＋</span><span><strong>快速记下一件事</strong><small>按回车只保存，不必现在处理</small></span></div>
            <div>
              <input
                ref={captureInputRef}
                id="notes-capture-input"
                value={captureText}
                maxLength={240}
                onChange={(event) => setCaptureText(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') capture(false) }}
                placeholder="例如：整理明天会议需要的材料"
              />
              <button type="button" className="button secondary" disabled={!captureText.trim()} onClick={() => capture(false)}>加入待办</button>
              <button type="button" className="button primary" disabled={!captureText.trim()} onClick={() => capture(true)}>记下并开始</button>
            </div>
          </div>

          <div className="todo-workspace">
            <article className="todo-list-card card-surface">
              <div className="todo-list-toolbar">
                <div>
                  <button type="button" className={listMode === 'open' ? 'active' : ''} onClick={() => setListMode('open')}>待处理 <span>{inboxCount}</span></button>
                  <button type="button" className={listMode === 'completed' ? 'active' : ''} onClick={() => setListMode('completed')}>已完成 <span>{completedCount}</span></button>
                </div>
                <label className="notes-search-field compact"><span aria-hidden="true">⌕</span><input value={todoSearchText} onChange={(event) => setTodoSearchText(event.target.value)} placeholder="搜索待办" aria-label="搜索待办" /></label>
              </div>

              {visibleSlips.length ? (
                <div className="todo-list">
                  {visibleSlips.map((slip) => (
                    <div key={slip.id} className={`todo-row${slip.status === 'completed' ? ' completed' : ''}`}>
                      {editingId === slip.id ? (
                        <div className="notes-inline-edit">
                          <input value={editingText} maxLength={240} onChange={(event) => setEditingText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') saveEdit() }} autoFocus />
                          <button type="button" onClick={saveEdit}>保存</button>
                          <button type="button" onClick={() => setEditingId(null)}>取消</button>
                        </div>
                      ) : (
                        <>
                          <button type="button" className={`todo-check${slip.status === 'completed' ? ' checked' : ''}`} aria-label={slip.status === 'completed' ? `重新打开${slip.title}` : `完成${slip.title}`} onClick={() => slip.status === 'completed' ? onReopen(slip.id) : onComplete(slip.id)}>{slip.status === 'completed' ? '✓' : ''}</button>
                          <div className="todo-copy">
                            <strong>{slip.title}</strong>
                            {slip.nextStep && <small>下一步：{slip.nextStep}</small>}
                            <time>{slip.status === 'completed' && slip.completedAt ? `完成于 ${dateTimeLabel(slip.completedAt)}` : `记录于 ${dateTimeLabel(slip.createdAt)}`}</time>
                          </div>
                          <div className="todo-actions">
                            {slip.status === 'inbox' && <><button type="button" className="primary" onClick={() => onStart(slip, false)}>开始</button><button type="button" onClick={() => onStart(slip, true)}>拆一步</button></>}
                            <button type="button" onClick={() => beginEdit(slip)}>编辑</button>
                            <button type="button" onClick={() => removeSlip(slip)}>移除</button>
                          </div>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              ) : <p className="notes-empty">{todoSearchText ? '没有找到相符的待办。' : listMode === 'open' ? '待处理已经清空。想到新事项时，一句话记下就够了。' : '还没有已完成的待办。'}</p>}
            </article>

            <aside className="todo-side">
              <article className={`todo-current card-surface${currentSlip ? '' : ' empty'}`}>
                <div className="todo-card-heading"><div><span className="current-pulse" /><p className="eyebrow">现在做</p></div>{currentSlip && <small>一次只推进一件</small>}</div>
                {currentSlip ? editingId === currentSlip.id ? (
                  <div className="notes-inline-edit current-edit">
                    <input value={editingText} maxLength={240} onChange={(event) => setEditingText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') saveEdit() }} autoFocus />
                    <button type="button" onClick={saveEdit}>保存</button><button type="button" onClick={() => setEditingId(null)}>取消</button>
                  </div>
                ) : (
                  <>
                    <div className="todo-current-title"><button type="button" className="todo-check" aria-label={`完成${currentSlip.title}`} onClick={() => onComplete(currentSlip.id)} /><h2>{currentSlip.title}</h2></div>
                    {currentSlip.nextStep && <p className="current-next-step"><span>下次从这里继续</span>{currentSlip.nextStep}</p>}
                    <div className="todo-current-actions"><button type="button" className="button primary" onClick={() => onStart(currentSlip, false)}>继续专注</button><button type="button" className="button secondary" onClick={() => onStart(currentSlip, true)}>拆成第一步</button><button type="button" className="todo-text-action" onClick={() => beginEdit(currentSlip)}>编辑</button></div>
                  </>
                ) : <><h2>暂时没有正在做的事</h2><p>从左侧待办里开始一件，其他内容先安心留在这里。</p></>}
              </article>

              <article className="todo-activity-card card-surface">
                <div className="todo-card-heading"><p className="eyebrow">最近行动</p><small>自动记录</small></div>
                {activity.length ? <div className="notes-activity-list">{activity.map((item) => (
                  <div key={item.id}><time>{dateTimeLabel(item.at)}</time><span><strong>{item.label}</strong><small>{item.detail}</small></span></div>
                ))}</div> : <p className="notes-empty">从待办开始一次现实专注后，关联记录会出现在这里。</p>}
              </article>
            </aside>
          </div>
        </div>
      )}

      <button type="button" className="notes-fab" aria-label={activeSection === 'notes' ? '新建笔记' : '新增待办'} onClick={activeSection === 'notes' ? openNewNote : focusTodoCapture}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
      </button>
    </section>
  )
}
