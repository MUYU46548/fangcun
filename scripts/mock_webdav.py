"""Mini WebDAV 服务桩 — 仅用于方寸备份链路的离线端到端测试。

零依赖（stdlib）。支持方寸备份用到的全部方法：
    PROPFIND (Depth 0/1) / MKCOL / PUT / GET / HEAD / DELETE
带 Basic Auth 校验。

用法：
    python scripts/mock_webdav.py --port 8899 --root /tmp/dav --user test --pass secret
"""
from __future__ import annotations

import argparse
import base64
import datetime
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

ROOT = ""
USER = ""
PASSWORD = ""


def local_path(url_path: str) -> str:
    """把 URL 路径映射到本地目录，拒绝目录穿越。"""
    rel = unquote(urlparse(url_path).path).lstrip("/")
    full = os.path.normpath(os.path.join(ROOT, rel))
    if not full.startswith(os.path.normpath(ROOT)):
        raise PermissionError("path traversal")
    return full


def http_date(ts: float) -> str:
    return datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).strftime(
        "%a, %d %b %Y %H:%M:%S GMT"
    )


class DavHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "MiniWebDAV/1.0"

    # ── 工具 ─────────────────────────────────────────────────────────────
    def log_message(self, fmt, *args):  # 静音默认日志
        pass

    def _auth_ok(self) -> bool:
        header = self.headers.get("Authorization", "")
        if not header.startswith("Basic "):
            return False
        try:
            raw = base64.b64decode(header[6:]).decode("utf-8")
        except Exception:
            return False
        user, _, pwd = raw.partition(":")
        return user == USER and pwd == PASSWORD

    def _deny(self):
        # 关键：必须先把请求体读干净。否则残留字节会污染 keep-alive 连接，
        # 客户端下一条请求会读到上一段的 body，直接解析失败。
        try:
            self._read_body()
        except Exception:
            pass
        body = b"Unauthorized"
        self.close_connection = True
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="mock"')
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length else b""

    def _send(self, code: int, body: bytes = b"", ctype: str = "text/plain"):
        self.send_response(code)
        # 204/304 按 RFC 不得携带 Content-Length 与正文，否则部分客户端判定连接异常
        if code not in (204, 304):
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body and code not in (204, 304):
            self.wfile.write(body)

    # ── 方法 ─────────────────────────────────────────────────────────────
    def do_PROPFIND(self):
        if not self._auth_ok():
            return self._deny()
        self._read_body()
        depth = self.headers.get("Depth", "1")
        try:
            path = local_path(self.path)
        except PermissionError:
            return self._send(403)
        if not os.path.exists(path):
            return self._send(404)

        href_base = urlparse(self.path).path
        if not href_base.endswith("/"):
            href_base += "/"

        items = [(href_base, path, os.path.isdir(path))]
        if depth != "0" and os.path.isdir(path):
            for name in sorted(os.listdir(path)):
                child = os.path.join(path, name)
                items.append((href_base + name, child, os.path.isdir(child)))

        parts = ['<?xml version="1.0" encoding="utf-8"?>', '<D:multistatus xmlns:D="DAV:">']
        for href, real, is_dir in items:
            parts.append("<D:response>")
            parts.append(f"<D:href>{href}</D:href>")
            parts.append("<D:propstat><D:prop>")
            if is_dir:
                parts.append("<D:resourcetype><D:collection/></D:resourcetype>")
            else:
                try:
                    st = os.stat(real)
                    parts.append(f"<D:getcontentlength>{st.st_size}</D:getcontentlength>")
                    parts.append(f"<D:getlastmodified>{http_date(st.st_mtime)}</D:getlastmodified>")
                except OSError:
                    pass
                parts.append("<D:resourcetype/>")
            parts.append("</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>")
            parts.append("</D:response>")
        parts.append("</D:multistatus>")

        body = "\n".join(parts).encode("utf-8")
        self.send_response(207)
        self.send_header("Content-Type", 'application/xml; charset="utf-8"')
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_MKCOL(self):
        if not self._auth_ok():
            return self._deny()
        self._read_body()
        try:
            path = local_path(self.path)
        except PermissionError:
            return self._send(403)
        if os.path.isdir(path):
            return self._send(405)  # 已存在
        parent = os.path.dirname(path)
        if not os.path.isdir(parent):
            return self._send(409)  # 父目录不存在
        try:
            os.mkdir(path)
        except OSError:
            return self._send(500)
        return self._send(201)

    def do_PUT(self):
        if not self._auth_ok():
            return self._deny()
        data = self._read_body()
        try:
            path = local_path(self.path)
        except PermissionError:
            return self._send(403)
        if not os.path.isdir(os.path.dirname(path)):
            return self._send(409)
        existed = os.path.exists(path)
        with open(path, "wb") as f:
            f.write(data)
        return self._send(204 if existed else 201)

    def do_GET(self):
        if not self._auth_ok():
            return self._deny()
        try:
            path = local_path(self.path)
        except PermissionError:
            return self._send(403)
        if not os.path.isfile(path):
            return self._send(404)
        with open(path, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_HEAD(self):
        if not self._auth_ok():
            return self._deny()
        try:
            path = local_path(self.path)
        except PermissionError:
            return self._send(403)
        if not os.path.isfile(path):
            return self._send(404)
        self.send_response(200)
        self.send_header("Content-Length", str(os.path.getsize(path)))
        self.end_headers()

    def do_DELETE(self):
        if not self._auth_ok():
            return self._deny()
        try:
            path = local_path(self.path)
        except PermissionError:
            return self._send(403)
        if not os.path.exists(path):
            return self._send(404)
        if os.path.isdir(path):
            import shutil
            shutil.rmtree(path, ignore_errors=True)
        else:
            os.remove(path)
        return self._send(204)


def main() -> int:
    global ROOT, USER, PASSWORD
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8899)
    ap.add_argument("--root", required=True)
    ap.add_argument("--user", default="tester")
    ap.add_argument("--pass", dest="password", default="s3cret")
    args = ap.parse_args()

    ROOT = os.path.abspath(args.root)
    USER = args.user
    PASSWORD = args.password
    os.makedirs(ROOT, exist_ok=True)

    srv = ThreadingHTTPServer(("127.0.0.1", args.port), DavHandler)
    print(f"mock WebDAV on http://127.0.0.1:{args.port}/  root={ROOT}  user={USER}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
