#!/usr/bin/env python3
"""方寸数据备份 — 独立校验与恢复工具（零依赖，仅用标准库）

这个脚本可以脱离方寸应用单独运行。把备份包和它放在一起，
换任何一台装了 Python 3.8+ 的机器都能验证数据是否完好、并还原出来。

用法：
    python fangcun-restore.py verify  fangcun-data-YYYYMMDD-HHMMSS.zip
    python fangcun-restore.py list    fangcun-data-YYYYMMDD-HHMMSS.zip
    python fangcun-restore.py extract fangcun-data-YYYYMMDD-HHMMSS.zip  <目标目录>

加密备份（`.fcz`，2026-10-31 起）：上面三条命令照用，脚本会认出 FCENC1 头并要口令：
    python fangcun-restore.py verify  fangcun-data-YYYYMMDD-HHMMSS.fcz        # 会提示输入口令
    python fangcun-restore.py extract x.fcz <目标目录> --password 你的口令
也可以先把密文解成一个普通 zip（自己决定放哪）：
    python fangcun-restore.py decrypt x.fcz out.zip --password 你的口令

退出码：0 = 成功；1 = 校验失败；2 = 参数或文件错误
"""
from __future__ import annotations

import argparse
import getpass
import hashlib
import hmac
import io
import json
import os
import struct
import sys
import zipfile

MANIFEST_NAME = "manifest.json"

# 中文 Windows 的控制台默认是 GBK：打印 ⚠ 这类字符会直接 UnicodeEncodeError 把脚本打死
# （不是逻辑错，但用户看到的就是"打不开"）。只放宽 errors，不改编码本身。
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(errors="replace")  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        pass

# ── 加密备份（FCENC1）：打开它只需要标准库 ──────────────────────────────
#
# 构造（与方寸主进程 desktop/src/main/backup/crypto.ts 必须逐字节一致）：
#   scrypt(口令, salt) → 64B → encKey(32) + macKey(32)
#   AES-256-CTR 加密 zip；HMAC-SHA256 覆盖“头部前 51 字节 + 密文”
# 格式：magic 6B | ver 1B | N/r/p 各 4B | salt 16B | iv 16B | tag 32B | 密文
#
# ⚠ Python 标准库没有 AES，所以下面自带一份 AES-256 块加密（只做加密方向，CTR 不需要解密）。
#   它有 FIPS-197 测试向量钉住（scripts/test/e2e-backup-crypto.cjs）。
ENC_MAGIC = b"FCENC1"
ENC_VERSION = 1
ENC_HEADER = 83

_SBOX = (
    0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
    0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
    0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
    0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
    0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
    0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
    0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
    0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
    0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
    0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
    0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
    0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
    0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
    0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
    0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
    0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16,
)
_RCON = (0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36, 0x6c, 0xd8, 0xab, 0x4d)


def _xtime(a: int) -> int:
    return ((a << 1) ^ 0x1B) & 0xFF if a & 0x80 else (a << 1) & 0xFF


def _mul(a: int, b: int) -> int:
    r = 0
    while b:
        if b & 1:
            r ^= a
        a = _xtime(a)
        b >>= 1
    return r & 0xFF


class _AES256:
    """只实现 AES-256 的**块加密**（CTR 模式只需要这一方向）。"""

    def __init__(self, key: bytes):
        if len(key) != 32:
            raise ValueError("AES-256 需要 32 字节密钥")
        self.nk = 8
        self.nr = 14
        w = [list(key[4 * i:4 * i + 4]) for i in range(self.nk)]
        for i in range(self.nk, 4 * (self.nr + 1)):
            temp = list(w[i - 1])
            if i % self.nk == 0:
                temp = temp[1:] + temp[:1]
                temp = [_SBOX[b] for b in temp]
                temp[0] ^= _RCON[i // self.nk - 1]
            elif self.nk > 6 and i % self.nk == 4:
                temp = [_SBOX[b] for b in temp]
            w.append([w[i - self.nk][j] ^ temp[j] for j in range(4)])
        self.rk = [bytes(sum(w[4 * r:4 * r + 4], [])) for r in range(self.nr + 1)]

    @staticmethod
    def _add(a: bytearray, rk: bytes) -> None:
        for i in range(16):
            a[i] ^= rk[i]

    @staticmethod
    def _sub(a: bytearray) -> None:
        for i in range(16):
            a[i] = _SBOX[a[i]]

    @staticmethod
    def _shift(a: bytearray) -> None:
        # 状态按列存放：a[4*c+r]；行 r 左移 r
        out = bytearray(16)
        for c in range(4):
            for r in range(4):
                out[4 * c + r] = a[4 * ((c + r) % 4) + r]
        a[:] = out

    @staticmethod
    def _mix(a: bytearray) -> None:
        for c in range(4):
            i = 4 * c
            s0, s1, s2, s3 = a[i], a[i + 1], a[i + 2], a[i + 3]
            a[i] = _mul(s0, 2) ^ _mul(s1, 3) ^ s2 ^ s3
            a[i + 1] = s0 ^ _mul(s1, 2) ^ _mul(s2, 3) ^ s3
            a[i + 2] = s0 ^ s1 ^ _mul(s2, 2) ^ _mul(s3, 3)
            a[i + 3] = _mul(s0, 3) ^ s1 ^ s2 ^ _mul(s3, 2)

    def encrypt_block(self, block: bytes) -> bytes:
        a = bytearray(block)
        self._add(a, self.rk[0])
        for r in range(1, self.nr):
            self._sub(a)
            self._shift(a)
            self._mix(a)
            self._add(a, self.rk[r])
        self._sub(a)
        self._shift(a)
        self._add(a, self.rk[self.nr])
        return bytes(a)


def _ctr_xor(key: bytes, iv: bytes, data: bytes) -> bytes:
    """AES-256-CTR：IV 当 128 位大端计数器，每块 +1（与 Node 的 aes-256-ctr 一致）。"""
    aes = _AES256(key)
    counter = int.from_bytes(iv, "big")
    out = bytearray(len(data))
    for off in range(0, len(data), 16):
        ks = aes.encrypt_block(counter.to_bytes(16, "big"))
        chunk = data[off:off + 16]
        for i, b in enumerate(chunk):
            out[off + i] = b ^ ks[i]
        counter = (counter + 1) % (1 << 128)
    return bytes(out)


def _derive_keys(password: str, salt: bytes, n: int, r: int, p: int) -> tuple[bytes, bytes]:
    # maxmem 必须给：OpenSSL 默认上限 32MB，而 128*N*r 本身就贴着这条线，不给会直接报
    # "memory limit exceeded"（与 Node 侧 scryptSync 的 maxmem 是同一个坑）。
    maxmem = max(64 * 1024 * 1024, 128 * n * r * 2)
    dk = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=n, r=r, p=p, dklen=64, maxmem=maxmem)
    return dk[:32], dk[32:]


def is_encrypted(raw: bytes) -> bool:
    return len(raw) >= ENC_HEADER and raw[:6] == ENC_MAGIC


def decrypt_container(raw: bytes, password: str) -> bytes:
    """解 FCENC1 → 里面的 zip 字节。失败一律抛 ValueError，并说清是哪一种。"""
    if not is_encrypted(raw):
        raise ValueError("不是方寸的加密备份（文件头不是 FCENC1）")
    if raw[6] != ENC_VERSION:
        raise ValueError(f"加密备份版本 {raw[6]} 不认识（当前支持 {ENC_VERSION}）")
    n, r, p = struct.unpack(">III", raw[7:19])
    if n < 1024 or n > (1 << 20) or r < 1 or r > 32 or p < 1 or p > 8:
        raise ValueError("加密参数不合理（文件可能损坏或被篡改）")
    salt, iv, tag = raw[19:35], raw[35:51], raw[51:83]
    ct = raw[ENC_HEADER:]
    enc_key, mac_key = _derive_keys(password, salt, n, r, p)
    expect = hmac.new(mac_key, raw[:51] + ct, hashlib.sha256).digest()
    if not hmac.compare_digest(expect, tag):
        raise ValueError("口令不对，或者这份备份被改过 —— 两种都过不了校验")
    return _ctr_xor(enc_key, iv, ct)


def load_raw(path: str, password: str | None, interactive: bool = True) -> tuple[bytes, bool]:
    """读备份文件；加密的就解密。返回 (zip 字节, 是否加密)。"""
    with open(path, "rb") as f:
        raw = f.read()
    if not is_encrypted(raw):
        return raw, False
    pw = password
    if not pw:
        if not interactive or not sys.stdin.isatty():
            raise ValueError("这是加密备份，需要口令（--password 或交互输入）")
        pw = getpass.getpass("这份备份是加密的，请输入口令：")
    return decrypt_container(raw, pw), True


# ── 校验 ────────────────────────────────────────────────────────────────


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def read_local_headers(raw: bytes) -> dict:
    """从 zip 原始字节里读出每个条目的 local header 关键字段。

    central directory 是权威来源，但如果只有 CD 被篡改（或 local header 被改），
    单看一边就发现不了。这里把两边都读出来做交叉比对。
    """
    out = {}
    pos = 0
    n = len(raw)
    while pos + 30 <= n:
        if raw[pos:pos + 4] != b"PK\x03\x04":
            break
        (flags, method, _t, _d, crc, csize, usize, name_len, extra_len) = struct.unpack(
            "<HHHHIIIHH", raw[pos + 6:pos + 30]
        )
        name = raw[pos + 30:pos + 30 + name_len].decode("utf-8", "replace")
        out[name] = {
            "flags": flags,
            "method": method,
            "crc": crc,
            "comp_size": csize,
            "raw_size": usize,
            "has_data_descriptor": bool(flags & 0x0008),
        }
        pos += 30 + name_len + extra_len + csize
    return out


def verify(zip_path: str, raw: bytes | None = None) -> tuple[bool, list, dict | None]:
    """四层校验，与方寸应用内实现的严格程度对齐。

    ① sha256 sidecar（若存在；**加密包按密文算**，这样能在解密前就发现文件坏了）
    ② ZIP 结构可解析 + 逐条 CRC
    ③ local header 与 central directory 字段一致
    ④ manifest 自洽（条目齐全、逐文件 sha256 抽查一致）

    `raw` 传进来时用它当 zip 内容（加密包解密后的字节），否则从磁盘读。
    """
    errors: list[str] = []
    manifest = None

    if not os.path.isfile(zip_path):
        return False, [f"文件不存在：{zip_path}"], None

    # ① sha256 sidecar
    sidecar = zip_path + ".sha256"
    actual_sha = sha256_file(zip_path)
    if os.path.isfile(sidecar):
        with open(sidecar, encoding="utf-8") as f:
            expected = f.read().strip()
        if expected and expected != actual_sha:
            errors.append(
                f"sha256 不匹配（期望 {expected[:16]}…，实际 {actual_sha[:16]}…）——文件已被改动或传输损坏"
            )
    else:
        print("  · 未找到 .sha256 校验文件，退化为结构与 CRC 校验")

    if raw is None:
        with open(zip_path, "rb") as f:
            raw = f.read()
    src = io.BytesIO(raw)

    # ② 结构 + CRC
    try:
        with zipfile.ZipFile(src, "r") as z:
            names = z.namelist()
            if not names:
                errors.append("备份包内没有任何条目")
            bad = z.testzip()
            if bad is not None:
                errors.append(f"CRC 校验失败：{bad}")
            try:
                manifest = json.loads(z.read(MANIFEST_NAME).decode("utf-8"))
            except KeyError:
                errors.append(f"缺少 {MANIFEST_NAME}")
            except Exception as e:  # noqa: BLE001
                errors.append(f"{MANIFEST_NAME} 不是合法 JSON：{e}")
    except zipfile.BadZipFile as e:
        return False, errors + [f"ZIP 结构损坏：{e}"], None
    except Exception as e:  # noqa: BLE001
        return False, errors + [f"读取失败：{e}"], None

    # ③ local / central directory 交叉比对
    lh = read_local_headers(raw)
    try:
        with zipfile.ZipFile(io.BytesIO(raw), "r") as z:
            for info in z.infolist():
                l = lh.get(info.filename)
                if l is None:
                    errors.append(f"local header 缺失：{info.filename}")
                    continue
                if l["flags"] != info.flag_bits:
                    errors.append(f"标志位不一致：{info.filename}")
                if l["method"] != info.compress_type:
                    errors.append(f"压缩算法不一致：{info.filename}")
                if not l["has_data_descriptor"]:
                    if l["crc"] != info.CRC:
                        errors.append(f"CRC 记录不一致：{info.filename}")
                    if l["comp_size"] != info.compress_size:
                        errors.append(f"压缩尺寸不一致：{info.filename}")
                    if l["raw_size"] != info.file_size:
                        errors.append(f"原始尺寸不一致：{info.filename}")
    except Exception as e:  # noqa: BLE001
        errors.append(f"交叉比对失败：{e}")

    # 路径安全：任何条目都不允许是绝对路径或含 ..
    if manifest:
        for f in manifest.get("files", []):
            name = str(f.get("path", ""))
            parts = name.replace("\\", "/").split("/")
            if name.startswith("/") or ".." in parts:
                errors.append(f"条目路径非法：{name}")

    # ④ manifest 自洽
    if manifest:
        files = manifest.get("files", [])
        if manifest.get("totalFiles") != len(files):
            errors.append(f"manifest 记录的 totalFiles({manifest.get('totalFiles')}) 与实际({len(files)}) 不符")
        with zipfile.ZipFile(io.BytesIO(raw), "r") as z:
            in_zip = set(z.namelist())
            for f in files:
                if f["path"] not in in_zip:
                    errors.append(f"manifest 列出但包内缺失：{f['path']}")
            # 抽样复核 sha256：首尾各 5 个，兼顾速度与覆盖
            for f in (files[:5] + files[-5:]):
                if f["path"] not in in_zip:
                    continue
                got = hashlib.sha256(z.read(f["path"])).hexdigest()
                if got != f.get("sha256"):
                    errors.append(f"文件 sha256 与 manifest 不符：{f['path']}")

        # 密钥防泄漏：备份包里不该出现这些
        leak = [
            f["path"] for f in files
            if any(k in os.path.basename(f["path"]).lower()
                   for k in ("llm-config.json", "backup-config.json", "credentials.json", ".env"))
            or os.path.basename(f["path"]).lower().endswith((".key", ".pem", ".p12", ".jks"))
        ]
        if leak:
            errors.append("检测到密钥类文件进入备份包（不应发生）：" + ", ".join(leak))

    return (len(errors) == 0), errors, manifest


# ── 命令 ────────────────────────────────────────────────────────────────


def cmd_verify(args) -> int:
    print(f"校验 {os.path.basename(args.zip)}")
    try:
        raw, encrypted = load_raw(args.zip, args.password)
    except ValueError as e:
        print(f"\n结论：FAIL —— {e}")
        return 1
    if encrypted:
        print("  · 这是加密备份（FCENC1），已解密后校验")
    ok, errors, manifest = verify(args.zip, raw)
    if manifest:
        print(f"  备份时间   : {manifest.get('createdAt')}")
        print(f"  文件数     : {manifest.get('totalFiles')}")
        print(f"  原始体积   : {manifest.get('totalBytes'):,} B")
        excluded = manifest.get("excludedSecrets") or []
        print(f"  已排除敏感 : {', '.join(excluded) if excluded else '（无）'}")
    if ok:
        print("\n结论：PASS —— 备份包完整可用")
        return 0
    print("\n结论：FAIL")
    for e in errors[:20]:
        print("  - " + e)
    if len(errors) > 20:
        print(f"  … 另有 {len(errors) - 20} 项")
    return 1


def cmd_list(args) -> int:
    try:
        raw, encrypted = load_raw(args.zip, args.password)
    except ValueError as e:
        print(f"打不开：{e}")
        return 1
    ok, errors, manifest = verify(args.zip, raw)
    if not manifest:
        print("无法读取 manifest，包可能已损坏：")
        for e in errors:
            print("  - " + e)
        return 1
    print(f"备份时间 : {manifest.get('createdAt')}")
    print(f"来源主机 : {manifest.get('hostname')}")
    print(f"文件数   : {manifest.get('totalFiles')}   原始体积: {manifest.get('totalBytes'):,} B")
    print(f"加密     : {'是（FCENC1）' if encrypted else '否'}")
    print(f"完整性   : {'PASS' if ok else 'FAIL（详见 verify 输出）'}")
    print("\n内容清单：")
    for f in sorted(manifest.get("files", []), key=lambda x: x["path"]):
        print(f"  {f['size']:>9,} B  {f['path']}")
    return 0 if ok else 1


def cmd_extract(args) -> int:
    try:
        raw, encrypted = load_raw(args.zip, args.password)
    except ValueError as e:
        print(f"打不开：{e}")
        return 1
    ok, errors, manifest = verify(args.zip, raw)
    if not ok:
        print("校验未通过，已拒绝解压（避免把损坏数据写进目标目录）：")
        for e in errors[:10]:
            print("  - " + e)
        return 1

    dest = os.path.abspath(args.dest)
    os.makedirs(dest, exist_ok=True)

    count = 0
    with zipfile.ZipFile(io.BytesIO(raw), "r") as z:
        for info in z.infolist():
            if info.filename == MANIFEST_NAME:
                continue
            rel = info.filename.replace("\\", "/")
            parts = rel.split("/")
            if rel.startswith("/") or ".." in parts:
                print(f"  跳过非法路径：{info.filename}")
                continue
            target = os.path.join(dest, *parts)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with z.open(info) as src, open(target, "wb") as dst:
                dst.write(src.read())
            count += 1

    # manifest 一并还原，便于日后再次校验
    with zipfile.ZipFile(io.BytesIO(raw), "r") as z:
        data = z.read(MANIFEST_NAME)
    with open(os.path.join(dest, MANIFEST_NAME), "wb") as f:
        f.write(data)

    print(f"已还原 {count} 个文件到：{dest}（{'加密包，已解密' if encrypted else '未加密包'}）")
    print("\n下一步：")
    print("  1. 核对目录结构：task-data/  registry.yaml  docs/")
    print("  2. 若用于恢复方寸：把 task-data/ 与 registry.yaml 放回数据目录")
    print("     （默认 %APPDATA%\\fangcun-desktop，或用方寸设置页选择目录）")
    print("  3. 原有的 manifest.json 一并保留，便于日后再次校验")
    return 0


def cmd_decrypt(args) -> int:
    """把加密备份解成一个普通 zip（放哪由用户决定）。"""
    try:
        raw, encrypted = load_raw(args.zip, args.password)
    except ValueError as e:
        print(f"打不开：{e}")
        return 2
    if not encrypted:
        print("这不是加密备份，不用解 —— 它本来就是 zip")
        return 2
    with open(args.out, "wb") as f:
        f.write(raw)
    print(f"已解密到：{os.path.abspath(args.out)}")
    print("⚠ 这是一份**明文** zip：用完请自己删掉，别留在共享目录里。")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(
        description="方寸数据备份 — 独立校验与恢复工具",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = ap.add_subparsers(dest="cmd", required=True)

    p1 = sub.add_parser("verify", help="校验备份包完整性")
    p1.add_argument("zip")
    p1.add_argument("--password", default=None, help="加密备份的口令（不给就交互输入）")
    p1.set_defaults(func=cmd_verify)

    p2 = sub.add_parser("list", help="列出备份内容")
    p2.add_argument("zip")
    p2.add_argument("--password", default=None, help="加密备份的口令（不给就交互输入）")
    p2.set_defaults(func=cmd_list)

    p3 = sub.add_parser("extract", help="校验后解压还原")
    p3.add_argument("zip")
    p3.add_argument("dest")
    p3.add_argument("--password", default=None, help="加密备份的口令（不给就交互输入）")
    p3.set_defaults(func=cmd_extract)

    p4 = sub.add_parser("decrypt", help="把加密备份解成普通 zip")
    p4.add_argument("zip")
    p4.add_argument("out")
    p4.add_argument("--password", default=None, help="加密备份的口令（不给就交互输入）")
    p4.set_defaults(func=cmd_decrypt)

    args = ap.parse_args()
    try:
        return args.func(args)
    except FileNotFoundError as e:
        print(f"文件不存在：{e}", file=sys.stderr)
        return 2
    except ValueError as e:
        print(f"打不开：{e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
