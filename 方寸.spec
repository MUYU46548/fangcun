# -*- mode: python ; coding: utf-8 -*-


a = Analysis(
    ['E:/CODE/CangKu/fangcun/tegula.py'],
    pathex=[],
    binaries=[],
    datas=[('E:/CODE/CangKu/fangcun/templates', 'templates'), ('E:/CODE/CangKu/fangcun/scripts/registry-default.yaml', '.')],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='方寸',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon='E:/CODE/CangKu/fangcun/assets/fangcun.ico',
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='方寸',
)
