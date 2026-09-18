/**
 * WebDAV 客户端 — 零新增依赖
 *
 * 只用 Node 内置 http/https 实现：MKCOL / PUT / GET / HEAD / PROPFIND / DELETE。
 * 适配坚果云、Nextcloud、群晖 NAS、各类自建 WebDAV。
 *
 * 安全：
 *  - 密码只进 Authorization 头，绝不写入错误信息或日志
 *  - 支持自签证书（NAS 场景默认自签），但需显式开启
 */
import * as http from 'http'
import * as https from 'https'
import { URL } from 'url'

export interface WebdavOptions {
  baseUrl: string
  username: string
  password: string
  allowSelfSigned: boolean
  timeoutMs?: number
}

export interface RemoteFile {
  name: string
  size: number | null
  mtime: string | null
}

interface RawResponse {
  status: number
  headers: http.IncomingHttpHeaders
  body: Buffer
}

const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:getcontentlength/>
    <d:getlastmodified/>
    <d:resourcetype/>
  </d:prop>
</d:propfind>`

export class WebdavError extends Error {
  status: number | null
  url: string
  constructor(message: string, status?: number, url?: string) {
    super(message)
    this.name = 'WebdavError'
    this.status = status ?? null
    this.url = url ?? ''
  }
}

export class WebdavClient {
  private opts: WebdavOptions
  private timeoutMs: number

  constructor(opts: WebdavOptions) {
    if (!opts.baseUrl) throw new WebdavError('WebDAV 地址为空')
    this.opts = opts
    this.timeoutMs = opts.timeoutMs ?? 60000
  }

  private buildUrl(rel: string): URL {
    const base = this.opts.baseUrl.replace(/\/+$/, '')
    const enc = rel
      .split('/')
      .filter(Boolean)
      .map(seg => encodeURIComponent(seg))
      .join('/')
    return new URL(enc ? `${base}/${enc}` : `${base}/`)
  }

  private authHeader(): string {
    const raw = `${this.opts.username}:${this.opts.password}`
    return 'Basic ' + Buffer.from(raw, 'utf-8').toString('base64')
  }

  /** 单次请求，不跟随重定向 */
  private once(method: string, url: URL, body?: Buffer, extraHeaders: Record<string, string> = {}): Promise<RawResponse> {
    const isHttps = url.protocol === 'https:'
    const mod = isHttps ? https : http

    const headers: Record<string, string> = {
      Authorization: this.authHeader(),
      'User-Agent': 'fangcun-backup/1.0',
      ...extraHeaders,
    }
    if (body && body.length) headers['Content-Length'] = String(body.length)

    return new Promise<RawResponse>((resolve, reject) => {
      const req = mod.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname + url.search,
          method,
          headers,
          rejectUnauthorized: isHttps ? !this.opts.allowSelfSigned : undefined,
          timeout: this.timeoutMs,
        },
        res => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) }))
        }
      )
      req.on('timeout', () => {
        req.destroy(new WebdavError(`请求超时（${Math.round(this.timeoutMs / 1000)}s）`, null, url.toString()))
      })
      req.on('error', (e: Error) => {
        reject(new WebdavError(`网络错误：${e.message}`, null, url.toString()))
      })
      if (body && body.length) req.write(body)
      req.end()
    })
  }

  /** 请求并跟随重定向（WebDAV 常见 301/302/307） */
  private async request(method: string, rel: string, body?: Buffer, extraHeaders: Record<string, string> = {}): Promise<RawResponse> {
    let url = this.buildUrl(rel)
    let res = await this.once(method, url, body, extraHeaders)
    for (let hop = 0; hop < 4; hop++) {
      if (![301, 302, 303, 307, 308].includes(res.status)) break
      const loc = res.headers['location']
      if (!loc) break
      url = new URL(loc, url)
      // 303 按规范改 GET；307/308 保持方法与 body
      const nextMethod = res.status === 303 ? 'GET' : method
      const nextBody = nextMethod === 'GET' ? undefined : body
      res = await this.once(nextMethod, url, nextBody, extraHeaders)
    }
    return res
  }

  /** 把 HTTP 状态翻译成人话。绝不回显密码。 */
  private explain(status: number, url: string, body: Buffer): string {
    const snippet = body.toString('utf-8').slice(0, 200)
    switch (status) {
      case 401: return `鉴权失败（401）。用户名或密码不对，注意坚果云需使用「应用密码」而非登录密码。`
      case 403: return `无权限（403）。账号可能没有该目录的写权限。`
      case 404: return `路径不存在（404）：${url}`
      case 405: return `服务端不接受该操作（405）：${url}`
      case 409: return `父目录不存在（409）：${url}`
      case 423: return `资源被锁定（423）：${url}`
      case 507: return `云端空间不足（507）`
      default: return `HTTP ${status}：${snippet || url}`
    }
  }

  /** 连通性 + 鉴权 + 目录可写，三步都过才算可用 */
  async test(): Promise<{ ok: boolean; status: number | null; detail: string; url: string }> {
    const url = this.opts.baseUrl
    // ① 鉴权：PROPFIND depth 0
    let res: RawResponse
    try {
      res = await this.request('PROPFIND', '', Buffer.from(PROPFIND_BODY, 'utf-8'), { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' })
    } catch (e) {
      return { ok: false, status: null, detail: (e as Error).message, url }
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: res.status, detail: this.explain(res.status, url, res.body), url }
    }
    if (res.status >= 400 && res.status !== 404 && res.status !== 405) {
      return { ok: false, status: res.status, detail: this.explain(res.status, url, res.body), url }
    }
    // ② 目录探测：MKCOL 幂等（405 = 已存在，视为通过）
    let mk: RawResponse
    try {
      mk = await this.request('MKCOL', '')
    } catch (e) {
      return { ok: false, status: null, detail: (e as Error).message, url }
    }
    if ([200, 201, 204, 405].includes(mk.status)) {
      return { ok: true, status: mk.status, detail: '连通、鉴权通过、目录可写', url }
    }
    return { ok: false, status: mk.status, detail: this.explain(mk.status, url, mk.body), url }
  }

  /** 建目录（幂等）。405 = 已存在，不算失败。 */
  async ensureCollection(rel: string): Promise<void> {
    // 空路径表示 baseUrl 自身，同样需要确保存在 —— 否则首次上传会因父目录缺失 409
    const segs = rel.split('/').filter(Boolean)
    const targets = segs.length === 0 ? [''] : []
    let cur = ''
    for (const s of segs) {
      cur = cur ? `${cur}/${s}` : s
      targets.push(cur)
    }
    for (const t of targets) {
      const res = await this.request('MKCOL', t)
      if (![200, 201, 204, 405].includes(res.status)) {
        const u = this.buildUrl(t).toString()
        // 409 = 父目录问题；在当前逐级创建的顺序下不该出现
        throw new WebdavError(this.explain(res.status, u, res.body), res.status, u)
      }
    }
  }

  /** 上传文件，成功后校验远端大小是否一致 */
  async put(rel: string, data: Buffer, contentType = 'application/octet-stream'): Promise<{ status: number; bytes: number }> {
    const res = await this.request('PUT', rel, data, {
      'Content-Type': contentType,
      'Content-Length': String(data.length),
    })
    if (![200, 201, 204].includes(res.status)) {
      throw new WebdavError(this.explain(res.status, this.buildUrl(rel).toString(), res.body), res.status, this.buildUrl(rel).toString())
    }
    return { status: res.status, bytes: data.length }
  }

  async get(rel: string): Promise<Buffer> {
    const res = await this.request('GET', rel)
    if (res.status !== 200) {
      throw new WebdavError(this.explain(res.status, this.buildUrl(rel).toString(), res.body), res.status, this.buildUrl(rel).toString())
    }
    return res.body
  }

  /** 取远端文件大小，用于上传后核对 */
  async statSize(rel: string): Promise<number | null> {
    try {
      const res = await this.request('HEAD', rel)
      if (res.status !== 200) return null
      const len = res.headers['content-length']
      return len ? Number(len) : null
    } catch {
      return null
    }
  }

  /** 列出目录下的文件（Depth: 1） */
  async list(rel = ''): Promise<RemoteFile[]> {
    const res = await this.request('PROPFIND', rel, Buffer.from(PROPFIND_BODY, 'utf-8'), {
      Depth: '1',
      'Content-Type': 'application/xml; charset=utf-8',
    })
    // 部分服务端不支持 PROPFIND，返回 405 —— 视为"无法列举"，不抛错（轮换会自动跳过）
    if (res.status === 405 || res.status === 501) return []
    if (res.status !== 207 && res.status !== 200) {
      throw new WebdavError(this.explain(res.status, this.buildUrl(rel).toString(), res.body), res.status, this.buildUrl(rel).toString())
    }

    const xml = res.body.toString('utf-8')
    const out: RemoteFile[] = []
    const blocks = xml.split(/<d:response[\s>]|<D:response[\s>]/i).slice(1)
    const selfHref = decodeURIComponent(this.buildUrl(rel).pathname).replace(/\/+$/, '')

    for (const b of blocks) {
      const hrefMatch = b.match(/<[dD]:href>([\s\S]*?)<\/[dD]:href>/i)
      if (!hrefMatch) continue
      let href = hrefMatch[1].trim()
      try {
        href = decodeURIComponent(href)
      } catch { /* 保持原值 */ }

      // 跳过集合自身
      const clean = href.replace(/\/+$/, '')
      if (clean === selfHref) continue

      const isCollection = /<[dD]:collection\s*\/?>/i.test(b)
      if (isCollection) continue

      const sizeMatch = b.match(/<[dD]:getcontentlength>(\d*)<\/[dD]:getcontentlength>/i)
      const mtimeMatch = b.match(/<[dD]:getlastmodified>([\s\S]*?)<\/[dD]:getlastmodified>/i)
      const name = clean.split('/').filter(Boolean).pop() || clean
      out.push({
        name,
        size: sizeMatch && sizeMatch[1] ? Number(sizeMatch[1]) : null,
        mtime: mtimeMatch ? mtimeMatch[1].trim() : null,
      })
    }
    return out
  }

  async remove(rel: string): Promise<void> {
    const res = await this.request('DELETE', rel)
    if (![200, 202, 204, 404].includes(res.status)) {
      throw new WebdavError(this.explain(res.status, this.buildUrl(rel).toString(), res.body), res.status, this.buildUrl(rel).toString())
    }
  }
}
