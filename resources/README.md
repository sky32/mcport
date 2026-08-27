# MCPort 资源

本目录存放应用的全部源资源：

- `MCPort-Logo-Dark.png` / `MCPort-Logo-Light.png`：界面 Logo
- `icons/MCPort-Icon.png`：应用图标源（Runtime `/icon.png` favicon 直接读取，也是 icns/ico 的生成源）
- `icons/MCPort-Tray-Icon.png`：托盘单色图标源
- `icons/icon.icns`、`icons/icon.ico`：生成的 Electron 打包图标（electron-builder 配置引用）

首次使用时创建资源处理专用的 Python 虚拟环境：

    python3 -m venv .venv-resources
    .venv-resources/bin/python -m pip install -r requirements-resources.txt

然后运行下面的命令，在 `icons/` 生成 ico/icns，并把图标和 Logo 同步到 Renderer：

    .venv-resources/bin/python scripts/generate-desktop-icons.py

该脚本需要 Python Pillow。源图标缺失时会用内置绘制的占位图标兜底。
