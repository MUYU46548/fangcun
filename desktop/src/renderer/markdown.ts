/**
 * Markdown → 安全 HTML（渲染层**唯一**一份，2026-10-23 从 App.vue 抽出来）。
 *
 * 为什么要抽：回收站正文预览、任务详情、日志正文都要渲染 Markdown。
 * 抽成组件之后，回收站那一路在 `views/TrashView.vue` 里 —— 如果各写一套，
 * 迟早出现"同一段正文在两个地方渲染出不同的东西"（而且 XSS 白名单最容易漂）。
 *
 * ⚠ 白名单只放**必须的标签**：`input` 是为任务卡里的 `- [ ]` 复选框；
 *   `data-check` 是让复选框可点（marked 产出的是 disabled input，我们换成自己的）。
 */
import { marked } from 'marked'
import DOMPurify from 'dompurify'

export function renderBody(body: string): string {
  if (!body) return ''
  let html = marked.parse(body, { breaks: true, gfm: true }) as string
  // Sanitize HTML to prevent XSS — allow <input> for checkboxes, data-check attr
  html = DOMPurify.sanitize(html, {
    ADD_TAGS: ['input'],
    ADD_ATTR: ['data-check'],
    ALLOWED_TAGS: [
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'p', 'br', 'hr',
      'ul', 'ol', 'li',
      'strong', 'em', 'b', 'i',
      'code', 'pre',
      'blockquote',
      'a', 'img',
      'table', 'thead', 'tbody', 'tr', 'th', 'td',
      'input', 'del'
    ],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class', 'type', 'checked', 'disabled', 'data-check']
  })
  // Make checkboxes interactive (replace marked's disabled inputs with clickable ones)
  html = html.replace(
    /<input[^>]*disabled[^>]*type="checkbox"[^>]*>/g,
    (match) => {
      const isChecked = /checked/.test(match)
      return `<input type="checkbox" data-check="${isChecked ? 'checked' : 'unchecked'}" ${isChecked ? 'checked' : ''}>`
    }
  )
  // Add check-item class to li elements containing checkboxes
  html = html.replace(/<li>(<input type="checkbox")/g, '<li class="check-item">$1')
  return html
}
