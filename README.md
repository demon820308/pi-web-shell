<div align="center">
  <img src="assets/icon.png" alt="Pi Web" width="100" />
  <h1>Pi Web 桌面客户端</h1>
  <p><strong>基于 Electron + Node.js + @agegr/pi-web 的零依赖、独立解耦、支持内核静默热更新的智能 AI Coding 桌面工作台</strong></p>
  <p>
    <a href="https://github.com/demon820308/pi-web-shell/releases/latest">下载安装包/便携版 v0.2.6</a> ·
    <a href="#-核心功能特性">核心特性</a> ·
    <a href="#-快速上手">快速上手</a> ·
    <a href="#-内核热更新与容灾回滚">内核热更新</a> ·
    <a href="#%EF%B8%8F-技术架构">技术架构</a> ·
    <a href="#%EF%B8%8F-构建与发布打包">构建与发布</a> ·
    <a href="#%EF%B8%8F-环境与参数配置">配置选项</a> ·
    <a href="#-开源鸣谢">开源鸣谢</a> ·
    <a href="#-开源协议">开源协议</a>
  </p>
  <p>
    <a href="https://github.com/demon820308/pi-web-shell/releases/latest"><img src="https://img.shields.io/github/v/release/demon820308/pi-web-shell?color=orange&label=%E6%9C%80%E6%96%B0%E7%89%88%E6%9C%AC" alt="最新版本" /></a>
    <img src="https://img.shields.io/badge/%E7%89%88%E6%9C%AC-v0.2.6-green" alt="版本 v0.2.6" />
    <img src="https://img.shields.io/badge/%E5%B9%B3%E5%8F%B0-Windows%20x64-blue" alt="Windows x64" />
    <img src="https://img.shields.io/badge/%E6%A1%86%E6%9E%B6-Electron%2033%20%2B%20Node.js%2022-brightgreen" alt="Electron 33 + Node.js 22" />
    <img src="https://img.shields.io/badge/%E5%86%85%E6%A0%B8-%40agegr%2Fpi--web%20v0.12.2-orange" alt="@agegr/pi-web" />
    <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/%E5%BC%80%E6%BA%90%E5%8D%8F%E8%AE%AE-MIT-blue" alt="MIT" /></a>
  </p>
</div>

---

## ⚡ 零依赖开箱即用 · 架构完全解耦 · 静默热更新与安全回滚

| 🚀 零依赖 · 开箱即用 | 🛡️ 架构解耦 · 独立沙箱 | 🔄 静默热更新 · 失败自愈 |
| :--- | :--- | :--- |
| 内置便携版 **Node.js (v22.19.0)** 与完整 `node_modules` 依赖，打包为独立 EXE / ZIP，用户电脑无需预先安装任何 Node.js 开发环境。 | **Shell 与内核彻底解耦**：宿主窗口通过独立子进程以黑盒方式运行内核，仅通过本地安全端口与 IPC 通信，零侵入无缝集成。 | 内置内核自动更新引擎，后台静默下载、原子无损切换、若连续 3 次启动异常自动回滚至稳定版本，告别频繁重装软件。 |

---

## 🌟 核心功能特性

### 1. 🚀 原生级免安装与独立运行环境 (Zero-install Runtime)
- **自带运行时环境**：安装包内直接打包便携版 Node.js v22.19.0 以及 `@agegr/pi-web` 的全量运行时依赖，双击即开，真正实现普通用户零门槛使用。
- **开箱即用**：提供标准 NSIS 单用户安装包（无需管理员权限）以及免安装便携版（绿色解压即用），不污染用户系统全局环境。

### 2. 🛡️ 架构解耦与透明进程管理 (Decoupled Architecture)
- **不改动内核源码**：Shell 仅仅作为轻量级宿主容器，通过 `child_process.spawn` 启动内核，并监听标准输出就绪信号（Ready）。
- **智能单例运行**：内置单例锁（Single Instance Lock），重复启动时自动聚焦并置顶已有主窗口，避免多次运行造成服务端口冲突。
- **智能端口调度与冲突自愈**：服务默认监听 `30141` 端口；若端口被占用，自动递增探测可用端口（最多 +30 个端口）。同时支持在菜单栏「文件 → 设置服务端口」中手动自定义，设置自动持久化。

### 3. 🔄 内核静默热更新与容灾回滚 (Kernel Hot-Updates & Auto Rollback)
- **超轻量更新体积**：每次仅更新 `pi-web` 核心包（压缩包约 220MB），相比重新下载完整桌面安装包（~300MB）速度更快、开销更低。
- **平滑无感升级**：后台静默检测并下载更新包，完成后右下角弹窗提示“立即重启”；用户确认后执行秒级原子目录替换并重启内核。
- **3 次异常自动回滚**：如果新内核连续 3 次未能成功就绪启动，系统将自动触发安全回滚机制，恢复至上一个正常运行的备份版本，确保业务永不中断。

### 4. 🧰 技能密钥与环境管理 (Skill Key Manager)
- **可视化密钥配置**：支持在菜单栏「文件 → 技能密钥设置」中直观管理 AI 技能所需的 API Key（如 Tavily、Firecrawl、Brave、GitHub 等）。
- **自动探测与同步**：自动扫描 `~/.pi/agent/skills/` 目录中的技能定义（支持 `SKILL.md` 中引用的各类 `*_API_KEY` 变量），提供密文掩码显示并同步写入 `~/.pi/agent/.env`，启动时自动注入内核子进程。

### 5. 📌 系统托盘与常驻后台 (System Tray & Resident Mode)
- **托盘常驻运行**：点击窗口关闭按钮自动最小化至系统托盘，AI 任务在后台持续运转不受打扰；支持在托盘中一键重启服务、配置密钥、查看运行日志或彻底退出。
- **开机自启支持**：支持菜单栏勾选「文件 → 开机自动启动」，系统登录后自动在后台拉起服务。
- **窗口与日志追踪**：自动记录并持久化窗口尺寸与屏幕位置；内置运行日志收集，支持菜单栏一键打开日志文件与用户数据目录。

---

## 📦 快速上手

### 方式一：Windows 桌面客户端（推荐日常使用）

无需安装 Node.js 或 Git，解压/安装即用！

1. 前往 [Releases 发布页面](https://github.com/demon820308/pi-web-shell/releases/latest) 下载最新版本：
   - **`Pi-Web-Setup-0.2.6.exe`**（标准安装程序，无需管理员权限）或
   - **`Pi-Web-0.2.6-x64.zip`**（绿色免安装便携版）；
2. 双击运行 **`Pi-Web.exe`**；
3. 客户端将自动唤起内置 Node.js 并运行内核，加载完毕后直接呈现全功能 Web 控制台！

---

### 方式二：开发者源码本地运行

如果您需要对 Shell 外壳进行二次开发或定制功能：

```bash
# 1. 克隆代码仓库
git clone https://github.com/demon820308/pi-web-shell.git
cd pi-web-shell

# 2. 安装项目依赖
npm install

# 3. 准备运行时依赖（下载便携 Node.js 并安装 pi-web 内核至 resources/）
npm run stage

# 4. 启动桌面端调试
npm start

# 或以日志调试模式启动（输出详细子进程日志）
npm run dev
```

> **💡 调试提示**：如果本地已有全局 Node 和 `@agegr/pi-web`，当 `resources/` 目录未初始化时，Shell 会自动回退调用系统的全局 Node.js 和全局 pi-web 执行。

---

## 🔄 内核热更新与容灾回滚

桌面客户端采用**「外壳（Shell）与内核（Kernel）分离」**的热更新设计，升级时无需重新下载与覆盖安装整个桌面应用程序：

```text
  [ 检查更新 (GitHub Release / 自定义 Manifest) ]
                       │
                       ▼
         [ 后台静默下载 kernel.tar.gz ]
                       │
                       ▼
       [ 校验 SHA-256 完整性并解压到 incoming ]
                       │
                       ▼
         [ 桌面右下角提示：已就绪，立即重启 ]
                       │
        ┌──────────────┴──────────────┐
        ▼                             ▼
   [ 用户点击重启 ]             [ 用户稍后处理 ]
        │                             │
        ▼                             ▼
  停止内核子进程                 下次启动时生效
        │
        ▼
  原子目录重命名替换:
  pi-web/          ──> pi-web-backup/
  pi-web-incoming/ ──> pi-web/
        │
        ▼
  启动新版本内核
        │
        ├─► 启动成功 (检测到 Ready) ──► 更新完成！
        │
        └─► 连续失败 3 次 ──────────► 自动触发回滚恢复 pi-web-backup
```

- **热更新日志**：可通过菜单「内核 → 查看更新日志」查看当前更新状态及历史版本（存储在 `userData/update-state.json`）。
- **自定义更新源**：支持通过环境变量 `PI_WEB_UPDATE_MANIFEST_URL` 指定私有分发服务器地址。

---

## 🏗️ 技术架构

```text
┌──────────────────────────────────────────────────────────────────┐
│                   Pi Web Shell (Electron 宿主)                   │
│                                                                  │
│  ┌───────────────────────┐          ┌─────────────────────────┐  │
│  │   Electron 主进程     │          │   BrowserWindow 渲染层  │  │
│  │   (main.js)           │          │   (renderer/)           │  │
│  │                       │          │                         │  │
│  │  ├─ 端口探测与容灾    │ ◄──────► │  ├─ 启动加载与错误页面  │  │
│  │  ├─ 托盘与菜单调度    │   IPC    │  ├─ 热更新悬浮提示条    │  │
│  │  ├─ 密钥环境管理      │          │  ├─ 端口与密钥弹窗配置  │  │
│  │  └─ 内核热更新状态机  │          │  └─ 承载 Web 控制台界面 │  │
│  └───────────┬───────────┘          └────────────▲────────────┘  │
└──────────────┼───────────────────────────────────┼───────────────┘
               │ child_process.spawn               │
               │ (内置 Node.js 执行)               │ HTTP (127.0.0.1:30141)
               ▼                                   │
┌──────────────────────────────────────────────────┼───────────────┐
│              内置独立运行时 (EXE Resources 目录) │               │
│                                                  │               │
│  ├─ resources/node/v22.19.0/node.exe             │               │
│  ├─ resources/pi-web/                 ───────────┘               │
│  │   (当前运行内核，含独立 node_modules / Next 产物)             │
│  ├─ resources/pi-web-backup/                                     │
│  │   (前一版本备份，用于启动失败快速回滚)                        │
│  └─ resources/pi-web-incoming/                                   │
│      (后台静默下载完毕、等待热替换的新版本)                      │
└──────────────────────────────────────────────────────────────────┘
```

---

## 🛠️ 构建与发布打包

### 本地构建产物

项目通过 `electron-builder` 进行封装，执行以下命令前请先执行 `npm run stage` 准备运行时资产：

| 脚本命令 | 对应行为说明 |
| :--- | :--- |
| `npm run stage` | 一键下载便携版 Node.js 并固化 `@agegr/pi-web` 至 `resources/` 目录 |
| `npm run build` | 完整构建 Windows NSIS 安装程序（`.exe`）与绿色便携版（`.zip`） |
| `npm run build:installer` | 仅构建 Windows NSIS 安装包 |
| `npm run build:zip` | 仅构建绿色便携 ZIP 压缩包 |
| `npm run build:dir` | 仅生成已解压的目录产物（`dist/win-unpacked/`，方便本地调试） |

打包生成的文件输出在 `dist/` 目录下：
- **`Pi-Web-Setup-<version>.exe`**：适合普通用户的单用户安装包。
- **`Pi-Web-<version>-x64.zip`**：即开即用的免安装绿色便携包。

### 独立内核发布（维护者）

当仅需更新 `pi-web` 内核时，可直接打包轻量级内核增量包：

```bash
# 1. 在 scripts/stage-pi-web.js 中更新 PI_WEB_VERSION
# 2. 重新拉取新版本内核资源
npm run stage

# 3. 生成内核 tarball 与更新清单 (位于 dist-kernel/ 目录)
npm run release:kernel

# 4. 生成并通过 GitHub CLI (gh) 自动上传发布到 GitHub Releases
npm run release:kernel:upload
```

---

## ⚙️ 环境与参数配置

可以通过系统环境变量或配置文件对客户端运行参数进行深度自定义：

| 环境变量名称 | 默认值 | 配置说明 |
| :--- | :--- | :--- |
| `PORT` | `30141` | 自定义内核 HTTP 服务监听端口（也可在菜单界面内直接修改） |
| `PI_WEB_HOSTNAME` | `127.0.0.1` | 绑定监听的主机地址 |
| `PI_WEB_BIN` | - | 开发者调试：强制指定自定义的 `pi-web.js` 入口文件绝对路径 |
| `PI_WEB_NODE` | - | 开发者调试：强制指定自定义的 `node.exe` 二进制文件绝对路径 |
| `PI_WEB_PASSWORD` | - | 开启 HTTP 基础身份验证（Basic Auth）密码 |
| `PI_WEB_UPDATE_MANIFEST_URL` | - | 覆盖默认的 GitHub Release 更新源，指定私有 Manifest 清单 URL |
| `PI_WEB_UPDATE_DISABLED` | `0` | 设置为 `1` 时彻底禁用自动检查与后台热更新功能 |

> 此外，用户主目录下的 `~/.pi/agent/.env` 文件中的配置项会在程序启动时自动合并并注入到内核运行环境中。

---

## 📁 项目目录结构

```text
pi-web-shell/
├── assets/                  # 应用图标资源 (icon.png)
├── build/                   # 构建图标与配置资源 (icon.ico)
├── lib/                     # 内核热更新状态机与校验核心模块
│   ├── manifest-client.js   # 获取与校验更新清单 (GitHub API / 自定义 JSON)
│   ├── update-state.js      # 更新状态持久化与日志存储 (userData/update-state.json)
│   └── kernel-updater.js    # 热更新状态流转、静默下载、原子替换与回滚逻辑
├── renderer/                # 渲染层页面与轻量交互视图
│   ├── index.html           # 启动就绪动画、异常屏与热更新悬浮提示条
│   ├── port-settings.html   # 端口自定义设置弹窗界面
│   ├── skill-keys.html      # 技能密钥可视化配置面板
│   ├── renderer.js          # 渲染层交互脚本
│   └── styles.css           # 界面样式表
├── scripts/                 # 构建与固化自动化脚本
│   ├── fetch-node.js        # 构建前自动拉取官方 Node.js 便携版
│   ├── stage-pi-web.js      # 构建前固化 @agegr/pi-web 运行时至 resources
│   └── release.js           # 内核增量发布构建打包脚本
├── resources/               # (Git 忽略) 打包时内置的独立运行时资源
│   ├── node/v22.19.0/       # 便携版 Node.js 运行时
│   └── pi-web/              # 完整的 pi-web 依赖及静态产物
├── main.js                  # Electron 主进程 (生命周期、子进程管理、托盘、菜单)
├── preload.js               # 安全沙箱桥接脚本 (Context Bridge)
├── package.json             # 项目元信息、构建脚本及 electron-builder 配置
└── README.md                # 项目说明文档
```

---

## 🙏 致谢与开源鸣谢

- 核心内核由 [@agegr/pi-web](https://github.com/agegr/pi-web) 提供，感谢原作者优秀的 AI Coding Agent Web 工作台与开源贡献！
- 桌面外壳基于 [Electron](https://www.electronjs.org/) 与 [electron-builder](https://www.electron.build/) 构建。

---

## 📄 开源协议

本项目采用 [MIT 许可证](https://opensource.org/licenses/MIT) 开源发布。
