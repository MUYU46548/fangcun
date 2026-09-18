#!/usr/bin/env python3
"""方寸数据备份 — 独立校验与恢复工具（零依赖，仅用标准库）

这个脚本可以脱离方寸应用单独运行。把备份包和它放在一起，
换任何一台装了 Python 3.8+ 的机器都能验证数据是否完好、并还原出来。

用法：
    python fangcun-restore.py verify  fangcun-data-YYYYMMDD-HHMMSS.zip
    python fangcun-restore.py list    fangcun-data-YYYYMMDD-HHMMSS.zip
    python fangcun-restore.py extract fangcun-data-YYYYMMDD-HHMMSS.zip  <目标目录>

退出码：0 = 成功；1 = 校验失败；2 = 参数或文件错误
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import struct
import sys
import zipfile

MANIFEST_NAME = "manifest.json"

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


def verify(zip_path: str) -> tuple[bool, list, dict | None]:
    """四层校验，与方寸应用内实现的严格程度对齐。

    ① sha256 sidecar（若存在）
    ② ZIP 结构可解析 + 逐条 CRC
    ③ local header 与 central directory 字段一致
    ④ manifest 自洽（条目齐全、逐文件 sha256 抽查一致）
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

    with open(zip_path, "rb") as f:
        raw = f.read()

    # ② 结构 + CRC
    try:
        with zipfile.ZipFile(zip_path, "r") as z:
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
        with zipfile.ZipFile(zip_path, "r") as z:
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
        with zipfile.ZipFile(zip_path, "r") as z:
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
    ok, errors, manifest = verify(args.zip)
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
    ok, errors, manifest = verify(args.zip)
    if not manifest:
        print("无法读取 manifest，包可能已损坏：")
        for e in errors:
            print("  - " + e)
        return 1
    print(f"备份时间 : {manifest.get('createdAt')}")
    print(f"来源主机 : {manifest.get('hostname')}")
    print(f"文件数   : {manifest.get('totalFiles')}   原始体积: {manifest.get('totalBytes'):,} B")
    print(f"完整性   : {'PASS' if ok else 'FAIL（详见 verify 输出）'}")
    print("\n内容清单：")
    for f in sorted(manifest.get("files", []), key=lambda x: x["path"]):
        print(f"  {f['size']:>9,} B  {f['path']}")
    return 0 if ok else 1


def cmd_extract(args) -> int:
    ok, errors, manifest = verify(args.zip)
    if not ok:
        print("校验未通过，已拒绝解压（避免把损坏数据写进目标目录）：")
        for e in errors[:10]:
            print("  - " + e)
        return 1

    dest = os.path.abspath(args.dest)
    os.makedirs(dest, exist_ok=True)

    count = 0
    with zipfile.ZipFile(args.zip, "r") as z:
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
    with zipfile.ZipFile(args.zip, "r") as z:
        data = z.read(MANIFEST_NAME)
    with open(os.path.join(dest, MANIFEST_NAME), "wb") as f:
        f.write(data)

    print(f"已还原 {count} 个文件到：{dest}")
    print("\n下一步：")
    print("  1. 核对目录结构：task-data/  registry.yaml  docs/")
    print("  2. 若用于恢复方寸：把 task-data/ 与 registry.yaml 放回数据目录")
    print("     （默认 %APPDATA%\\fangcun-desktop，或用方寸设置页选择目录）")
    print("  3. 原有的 manifest.json 一并保留，便于日后再次校验")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(
        description="方寸数据备份 — 独立校验与恢复工具",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = ap.add_subparsers(dest="cmd", required=True)

    p1 = sub.add_parser("verify", help="校验备份包完整性")
    p1.add_argument("zip")
    p1.set_defaults(func=cmd_verify)

    p2 = sub.add_parser("list", help="列出备份内容")
    p2.add_argument("zip")
    p2.set_defaults(func=cmd_list)

    p3 = sub.add_parser("extract", help="校验后解压还原")
    p3.add_argument("zip")
    p3.add_argument("dest")
    p3.set_defaults(func=cmd_extract)

    args = ap.parse_args()
    try:
        return args.func(args)
    except FileNotFoundError as e:
        print(f"文件不存在：{e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
