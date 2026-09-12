# 方寸打包脚本
# 使用方法：
#   1. pip install pyinstaller pywebview
#   2. python scripts/build.py          # 打包成目录
#   3. python scripts/build.py --setup  # 打包成目录 + Inno Setup 安装包（需先安装 Inno Setup）

import subprocess
import sys
import os
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST_DIR = os.path.join(ROOT, "dist")
BUILD_DIR = os.path.join(ROOT, "build")

def clean():
    """清理之前的构建产物。"""
    for d in [DIST_DIR, BUILD_DIR]:
        if os.path.isdir(d):
            print(f"  清理 {d}")
            shutil.rmtree(d)

def build_dir():
    """PyInstaller 目录模式打包。"""
    print("=== PyInstaller 目录模式打包 ===")
    
    # --add-data 格式：source;destination（Windows 用 ;，Linux/Mac 用 :）
    sep = ";" if sys.platform == "win32" else ":"
    templates_src = os.path.join(ROOT, "templates")
    registry_src = os.path.join(ROOT, "scripts", "registry-default.yaml")
    
    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--onedir",           # 目录模式（启动快、误报少）
        "--console",          # 保留控制台（调试用，发布时改 --windowed）
        "--name", "方寸",
        "--clean",
        "--noconfirm",
        # 嵌入模板文件
        "--add-data", f"{templates_src}{sep}templates",
        # 嵌入默认注册表模板
        "--add-data", f"{registry_src}{sep}.",
        os.path.join(ROOT, "tegula.py")
    ]
    
    print(f"  执行: {' '.join(cmd)}")
    result = subprocess.run(cmd, cwd=ROOT)
    if result.returncode != 0:
        print("  ✗ 打包失败")
        sys.exit(1)
    
    print(f"  ✓ 输出: {os.path.join(DIST_DIR, '方寸')}")

def create_icon():
    """创建默认图标（如果不存在）。"""
    icon_path = os.path.join(ROOT, "assets", "fangcun.ico")
    if os.path.exists(icon_path):
        return icon_path
    
    # 如果没有图标文件，创建一个简单的
    try:
        from PIL import Image, ImageDraw, ImageFont
        os.makedirs(os.path.join(ROOT, "assets"), exist_ok=True)
        
        # 创建 256x256 的图标
        img = Image.new("RGBA", (256, 256), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)
        
        # 画一个紫色圆角方块（方寸的主题色）
        draw.rounded_rectangle([8, 8, 248, 248], radius=40, fill="#9b8fc4")
        
        # 写一个"寸"字
        try:
            font = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 140)
        except Exception:
            font = ImageFont.load_default()
        
        draw.text((128, 128), "寸", fill="white", font=font, anchor="mm")
        
        img.save(icon_path, format="ICO", sizes=[(16, 16), (32, 32), (48, 48), (256, 256)])
        print(f"  ✓ 创建图标: {icon_path}")
        return icon_path
    except ImportError:
        print("  ⚠ 无 PIL，跳过图标创建")
        return None

def build_setup():
    """Inno Setup 安装包打包。"""
    print("=== Inno Setup 安装包 ===")
    
    # 检测 Inno Setup
    iscc = None
    for path in [
        r"C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
        r"C:\Program Files\Inno Setup 6\ISCC.exe",
    ]:
        if os.path.exists(path):
            iscc = path
            break
    
    if not iscc:
        print("  ✗ 未找到 Inno Setup，请先安装: https://jrsoftware.org/isdl.php")
        print("  跳过安装包生成，目录模式打包已完成")
        return False
    
    # 复制 ISS 脚本到 dist 目录
    iss_src = os.path.join(ROOT, "scripts", "fangcun.iss")
    iss_dst = os.path.join(DIST_DIR, "fangcun.iss")
    shutil.copy(iss_src, iss_dst)
    
    # 编译
    result = subprocess.run([iscc, iss_dst], cwd=DIST_DIR)
    if result.returncode != 0:
        print("  ✗ Inno Setup 编译失败")
        return False
    
    print(f"  ✓ 安装包: {os.path.join(DIST_DIR, '方寸_setup.exe')}")
    return True

def main():
    """主入口。"""
    args = sys.argv[1:]
    
    print("方寸打包脚本")
    print("=" * 40)
    
    # 清理
    clean()
    
    # 创建图标
    icon = create_icon()
    
    # 目录模式打包
    build_dir()
    
    # 安装包打包
    if "--setup" in args:
        build_setup()
    
    print()
    print("=" * 40)
    print("打包完成！")
    print(f"  目录: {os.path.join(DIST_DIR, '方寸')}")
    if "--setup" in args:
        print(f"  安装包: {os.path.join(DIST_DIR, '方寸_setup.exe')}")

if __name__ == "__main__":
    main()
