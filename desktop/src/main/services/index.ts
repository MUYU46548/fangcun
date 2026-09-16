import * as fs from 'fs'
import * as path from 'path'
import { exec, spawn } from 'child_process'
import { parseRegistry, getDataDir } from '../data'

export interface Service {
  project: string
  projectId: string
  name: string
  port: number | null
  url: string
  startCmd: string
  stopCmd: string
  repo: string
  running: boolean
}

export function scanServices(): Service[] {
  const projects = parseRegistry()
  const services: Service[] = []

  for (const p of projects) {
    const pid = p.id
    const pname = p.name || pid
    for (const svc of (p.services || [])) {
      let port: number | null = null
      let url = ''
      let startCmd = ''
      let stopCmd = ''
      let name = '未命名服务'

      if (typeof svc === 'object' && svc !== null) {
        port = (svc as any).port ? parseInt((svc as any).port) : null
        url = (svc as any).url || ''
        startCmd = (svc as any).start_cmd || ''
        stopCmd = (svc as any).stop_cmd || ''
        name = (svc as any).name || name
      }

      if (!url && port) url = `http://127.0.0.1:${port}`

      services.push({
        project: pname,
        projectId: pid,
        name,
        port,
        url,
        startCmd,
        stopCmd,
        repo: p.repo || '',
        running: false,
      })
    }
  }

  return services
}

export interface Note {
  id: string
  title: string
  content: string
  taskId?: string
  createdAt: string
  updatedAt: string
}

function getNotesDir(): string {
  const dataDir = getDataDir()
  const notesDir = path.join(dataDir, 'notes')
  fs.mkdirSync(notesDir, { recursive: true })
  return notesDir
}

function getNotesIndexPath(): string {
  return path.join(getNotesDir(), 'index.json')
}

function loadNotesIndex(): Note[] {
  const p = getNotesIndexPath()
  if (!fs.existsSync(p)) return []
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'))
  } catch {
    return []
  }
}

function saveNotesIndex(notes: Note[]): void {
  fs.writeFileSync(getNotesIndexPath(), JSON.stringify(notes, null, 2), 'utf-8')
}

export function createNote(title: string, content: string, taskId?: string): Note {
  const id = `note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const now = new Date().toISOString()
  const note: Note = { id, title, content, taskId, createdAt: now, updatedAt: now }
  const notes = loadNotesIndex()
  notes.push(note)
  saveNotesIndex(notes)
  return note
}

export function getNote(noteId: string): Note | null {
  const notes = loadNotesIndex()
  return notes.find(n => n.id === noteId) || null
}

export function updateNote(noteId: string, updates: Partial<Pick<Note, 'title' | 'content' | 'taskId'>>): Note | null {
  const notes = loadNotesIndex()
  const idx = notes.findIndex(n => n.id === noteId)
  if (idx < 0) return null
  const note = notes[idx]
  if (updates.title !== undefined) note.title = updates.title
  if (updates.content !== undefined) note.content = updates.content
  if (updates.taskId !== undefined) note.taskId = updates.taskId
  note.updatedAt = new Date().toISOString()
  saveNotesIndex(notes)
  return note
}

export function deleteNote(noteId: string): boolean {
  const notes = loadNotesIndex()
  const idx = notes.findIndex(n => n.id === noteId)
  if (idx < 0) return false
  notes.splice(idx, 1)
  saveNotesIndex(notes)
  return true
}

export function getNotesForTask(taskId: string): Note[] {
  const notes = loadNotesIndex()
  return notes.filter(n => n.taskId === taskId)
}

export function listNotes(): Note[] {
  return loadNotesIndex()
}
