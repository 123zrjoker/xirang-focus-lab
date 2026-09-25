import { KnowledgeBaseManager } from '../components/KnowledgeBaseManager'
import type { PersonalNote } from '../types'

interface KnowledgePageProps {
  notes: PersonalNote[]
}

export function KnowledgePage({ notes }: KnowledgePageProps) {
  return (
    <section className="page-width inner-page knowledge-page">
      <div className="page-title-row knowledge-page-heading">
        <div>
          <p className="eyebrow">本地知识工作区</p>
          <h1>检索、验证，再回到原文</h1>
          <p>在授权的个人笔记和文档中检索，查看命中依据与引用位置，并在同一处管理知识来源。</p>
        </div>
        <span className="local-only-badge">本地优先</span>
      </div>

      <KnowledgeBaseManager notes={notes} />
    </section>
  )
}
