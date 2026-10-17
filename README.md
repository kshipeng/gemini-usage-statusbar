# Gemini Usage Statusbar

[中文](#chinese) | [English](#english)

---

<a name="chinese"></a>
## 🚀 概览

**Gemini Usage Statusbar HUD** 是一款专为 Google Gemini (`https://gemini.google.com/`) 设计的高性能、极简微缩油猴脚本。它无缝内嵌至 Gemini 聊天页面的底部输入框状态栏，为您提供多账号并发同步、全量配额监控、动态倒计时与无感后台校准。

### ✨ 核心功能

* **极简微缩胶囊**：零冗余图标内嵌至输入框状态栏，支持底部微光进度条与三档色彩动态预警（正常、预警、高危）。
* **全量多账号并发同步**：一键并发探测并同步所有已登录 Google 账号（`u0` ~ `u4`）的最新 5 小时与每周限额配额，支持同屏多账号对比。
* **SSR / RPC 双重校准**：深度解析 `WIZ_global_data`，通过 `AF_initDataCallback` 状态机与 `batchexecute` 跨账号协议重放，实现毫秒级（~80ms）极速响应。
* **零弹窗无感水合**：采用视口微透明后台 Iframe 异步水合与虚拟 Blank 降级机制，更新配额时“偷偷”完成，绝不打扰您的正常对话。
* **智能联动刷新**：支持每次发送提问后自动延迟刷新、自定义定时轮询（1m/5m/15m）以及配额重置时间点的精准倒计时。

### 📦 安装指南

1. 在浏览器中安装 **Tampermonkey（暴力猴）** 或 **Violentmonkey** 插件。
2. 新建脚本并将 `gemini-usage-statusbar.user.js` 源码完整粘贴进去并保存。
3. 打开 [Google Gemini](https://gemini.google.com/) 即可在输入框左侧看到实时用量胶囊。

---

<a name="english"></a>
## 🚀 Overview

**Gemini Usage Statusbar HUD** is an advanced, ultra-lightweight userscript designed for Google Gemini (`https://gemini.google.com/`). It embeds seamlessly into the chat interface status bar, providing real-time, multi-account concurrent quota monitoring, dynamic countdowns, and automated synchronization without intrusive pop-ups.

### ✨ Key Features

* **Minimalist HUD Capsule**: Cleanly embedded into the Gemini input bar status section with zero redundant icons, glowing progress bar, and 3-stage color warnings.
* **Multi-Account Concurrent Sync**: Instantly probe, parse, and synchronize quotas across multiple logged-in Google accounts (`u0` ~ `u4`) in parallel without manual page switching.
* **SSR & RPC Dual Calibration**: Automatically extracts `WIZ_global_data` and calibrates parsing coordinates via `AF_initDataCallback` and `batchexecute` protocol replay for blazing-fast synchronization (~80ms).
* **Stealth Hydration Engine**: Utilizes background iframe stealth hydration and virtual blank fallback mechanisms to update quotas seamlessly without stealing focus or disrupting your workflow.
* **Smart Auto-Refresh**: Automatically refreshes quotas upon prompt submission, at custom time intervals, or dynamically as quotas reset.

### 📦 Installation

1. Install a userscript manager such as **Tampermonkey** or **Violentmonkey** in your browser.
2. Click [Install Script](#) (or create a new script and paste the source code).
3. Open [Google Gemini](https://gemini.google.com/), and the usage HUD will automatically appear in the input bar.

---

## ⌨️ Shortcuts & Interactions / 交互指南

* **Left Click / 左键点击**：展开/折叠多账号配额总览与设置面板。
* **Alt + Left Click / Alt + 左键**：立即强制刷新当前账号配额。
* **Ctrl/Cmd + Alt + Left Click / 组合键 + 左键**：触发全量多账号并发探测与同步。
