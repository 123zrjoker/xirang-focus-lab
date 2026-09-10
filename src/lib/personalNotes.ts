import type { PersonalNote } from '../types'

export const MAX_PERSONAL_NOTES = 300

export function normalizeNoteTitle(value: string) {
  return value.trim().replace(/\s+/g, ' ').slice(0, 80)
}

export function normalizeNoteContent(value: string) {
  return value.replace(/\r\n?/g, '\n').trim().slice(0, 6000)
}

export function createPersonalNote(title: string, content: string, now = new Date().toISOString()): PersonalNote | null {
  const cleanContent = normalizeNoteContent(content)
  const cleanTitle = normalizeNoteTitle(title) || normalizeNoteTitle(cleanContent.split('\n')[0] ?? '')
  if (!cleanTitle && !cleanContent) return null
  return {
    id: crypto.randomUUID(),
    title: cleanTitle || '未命名笔记',
    content: cleanContent,
    createdAt: now,
    updatedAt: now,
  }
}

export function updatePersonalNote(
  items: PersonalNote[],
  id: string,
  title: string,
  content: string,
  now = new Date().toISOString(),
) {
  const cleanContent = normalizeNoteContent(content)
  const cleanTitle = normalizeNoteTitle(title) || normalizeNoteTitle(cleanContent.split('\n')[0] ?? '')
  if (!cleanTitle && !cleanContent) return items
  return items.map((item) => item.id === id
    ? { ...item, title: cleanTitle || '未命名笔记', content: cleanContent, updatedAt: now }
    : item)
}
