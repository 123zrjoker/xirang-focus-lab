import type { ReactNode } from 'react'
import type { Page } from '../types'

interface AppShellProps {
  page: Page
  children: ReactNode
  onNavigate: (page: Page) => void
}

const navItems: { page: Page; label: string; icon: string }[] = [
  { page: 'today', label: '今日', icon: '◫' },
  { page: 'notes', label: '便签', icon: '✎' },
  { page: 'knowledge', label: '知识', icon: '⌕' },
  { page: 'training', label: '训练', icon: '◎' },
  { page: 'focus', label: '专注', icon: '◉' },
  { page: 'progress', label: '数据', icon: '↗' },
  { page: 'settings', label: '设置', icon: '⚙' },
]

export function AppShell({ page, children, onNavigate }: AppShellProps) {
  const appPage = page === 'assessment' ? 'home' : page === 'launch' ? 'notes' : page
  return (
    <div className="app-shell">
      <header className="site-header">
        <button className="brand" type="button" onClick={() => onNavigate('home')}>
          <span className="brand-mark"><i /><i /><i /></span>
          <span><strong>息壤</strong><small>FOCUS LAB</small></span>
        </button>
        <nav className="desktop-nav" aria-label="主要导航">
          {navItems.map((item) => (
            <button
              key={item.page}
              type="button"
              className={appPage === item.page ? 'active' : ''}
              onClick={() => onNavigate(item.page)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <button className="header-action" type="button" onClick={() => onNavigate('launch')}>
          启动一件事 <span>→</span>
        </button>
      </header>
      <main>{children}</main>
      <nav className="mobile-nav" aria-label="移动端导航">
        {navItems.map((item) => (
          <button
            key={item.page}
            type="button"
            className={appPage === item.page ? 'active' : ''}
            onClick={() => onNavigate(item.page)}
          >
            <span>{item.icon}</span>{item.label}
          </button>
        ))}
      </nav>
    </div>
  )
}
