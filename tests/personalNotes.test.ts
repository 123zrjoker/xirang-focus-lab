import { describe, expect, it } from 'vitest'
import { createPersonalNote, updatePersonalNote } from '../src/lib/personalNotes'

describe('personal notes', () => {
  it('uses the first content line when the title is empty', () => {
    const note = createPersonalNote('', '  一段临时想法\n后续内容  ', '2026-09-03T01:00:00.000Z')

    expect(note).toMatchObject({
      title: '一段临时想法',
      content: '一段临时想法\n后续内容',
      createdAt: '2026-09-03T01:00:00.000Z',
    })
  })

  it('updates title, content and edited time', () => {
    const note = createPersonalNote('原标题', '原内容', '2026-09-03T01:00:00.000Z')!
    const [updated] = updatePersonalNote([note], note.id, '  新   标题  ', '新内容', '2026-09-03T02:00:00.000Z')

    expect(updated).toMatchObject({ title: '新 标题', content: '新内容', updatedAt: '2026-09-03T02:00:00.000Z' })
  })
})
