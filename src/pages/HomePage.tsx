import type { Page } from '../types'

interface HomePageProps {
  hasProfile: boolean
  onNavigate: (page: Page) => void
  onQuickTask: () => void
}

export function HomePage({ hasProfile, onNavigate, onQuickTask }: HomePageProps) {
  return (
    <>
      <section className="hero page-width">
        <div className="hero-copy">
          <span className="hero-kicker"><i /> 为分心时代设计的注意力练习</span>
          <h1>把注意力，<br /><em>慢慢带回来。</em></h1>
          <p>
            先选出现在值得做的一件事，把它缩小成可以立即执行的动作，再进入一段真实专注。
            认知训练与长期记录，会帮助你逐渐理解自己的注意节奏。
          </p>
          <div className="hero-actions">
            <button className="button primary large" type="button" onClick={() => onNavigate('launch')}>
              我现在就要开始 <span>→</span>
            </button>
            <button className="button text-button" type="button" onClick={() => onNavigate(hasProfile ? 'today' : 'assessment')}>{hasProfile ? '查看今日计划' : '做一次 5 分钟基线'}</button>
            <button className="button text-button" type="button" onClick={onQuickTask}>先体验 30 秒</button>
          </div>
          <div className="trust-line">
            <span><i>✓</i> 无需注册</span>
            <span><i>✓</i> 数据保存在本机</span>
            <span><i>✓</i> 非医疗诊断</span>
          </div>
        </div>
        <div className="hero-visual" aria-label="注意力训练界面预览">
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />
          <div className="preview-card">
            <div className="preview-top"><span>视觉搜索</span><strong>01:42</strong></div>
            <div className="preview-grid">
              {[8, 3, 12, 1, 15, 6, 10, 4, 13, 2, 9, 16, 5, 14, 7, 11].map((number) => (
                <span key={number} className={number === 1 ? 'active' : ''}>{number}</span>
              ))}
            </div>
            <div className="preview-bottom"><span>保持准确</span><i><b /></i><strong>82%</strong></div>
          </div>
          <div className="floating-note note-one"><i />今日已专注<strong>42 分钟</strong></div>
          <div className="floating-note note-two"><span>↗</span><div>稳定性<strong>+ 12%</strong></div></div>
        </div>
      </section>

      <section className="method-section page-width">
        <div className="section-heading split">
          <div><p className="eyebrow">训练闭环</p><h2>游戏里练习，现实中专注</h2></div>
          <p>认知任务负责练习具体技能，专注室帮助你把这些技能带回真正要完成的事情。</p>
        </div>
        <div className="method-grid">
          <article><span>01</span><i className="method-icon grid-icon" /><h3>先测量</h3><p>用三项短任务建立个人基线，不与陌生人比较。</p></article>
          <article><span>02</span><i className="method-icon pulse-icon" /><h3>再训练</h3><p>每天十分钟，练习搜索、稳定、抑制和抗干扰。</p></article>
          <article><span>03</span><i className="method-icon focus-icon" /><h3>去完成</h3><p>关掉干扰，进入一个有明确目标的真实专注时段。</p></article>
          <article><span>04</span><i className="method-icon chart-icon" /><h3>看变化</h3><p>按阶段复测，区分偶然的快、练习熟悉和长期变化。</p></article>
        </div>
      </section>

      <section className="science-banner page-width">
        <div><p className="eyebrow light">诚实的科学边界</p><h2>练得更好，不等于生活自动变好。</h2></div>
        <p>所以我们同时记录训练成绩与真实任务完成情况，并明确告诉你哪些变化只是熟练效应。</p>
        <button type="button" onClick={() => onNavigate('progress')}>了解评估方式 →</button>
      </section>
    </>
  )
}
