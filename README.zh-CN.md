<div align="center">

# 🛡️ ProxyDeck

**现代化的 Chrome 代理切换器 —— 支持按标签页分流、粘性会话与实时 IP 信息。**

[English](README.md) · [简体中文](README.zh-CN.md) · [Bahasa Indonesia](README.id.md)

[![Manifest V3](https://img.shields.io/badge/Manifest-V3-4f8cff?style=flat-square)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![License: MIT](https://img.shields.io/badge/License-MIT-16c47f?style=flat-square)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-175%20单元%20%2B%2085%20端到端-7b5cff?style=flat-square)](#-测试)
[![No dependencies](https://img.shields.io/badge/依赖-零-ffb020?style=flat-square)](#-项目结构)

</div>

---

## 简介

配置一次代理，之后从工具栏一键开关。ProxyDeck 会明确告诉你**当前的出口在哪里** —— IP、城市、地区、国家、ISP、ASN、时区 —— 以及这次会话**用掉了多少流量**。

与常见切换器相比，它有两点不同：

| | |
|---|---|
| 🗂 **按标签页分流** | 只让*某一个标签页*走代理，其余标签页仍使用你的真实 IP。一边做调研，一边保持正常登录状态。 |
| 📌 **粘性会话** | 轮换网关每次请求都会换 IP。ProxyDeck 会锁定一个出口 IP 并保持住 —— 想保持多久都可以，也可以设定自动轮换的时间。 |

---

## ✨ 功能

### 连接
- **协议** —— HTTP、HTTPS、SOCKS4、SOCKS5
- **认证** —— 自动应答需要用户名／密码的代理
- **快速粘贴** —— 几乎任何格式都能识别并自动填表：
  ```
  host:port                       user:pass@host:port
  host:port:user:pass             socks5://user:pass@host:port
  ```
- **多服务器** —— 保存、编辑、切换、删除，可导出为 JSON
- **绕过列表** —— 始终不走代理的主机

### 🗂 标签页范围
可选择**所有标签页**或**仅选定的标签页**。在标签页模式下，当前标签页会出现一个开关；打开后只有该标签页走代理。其他内容 —— 你的邮箱、后台面板 —— 仍走真实连接。

> Chrome 没有提供按标签页设置代理的 API，因此 ProxyDeck 会把已代理标签页中加载的主机编译成 PAC 脚本。也就是说分流是**按主机**进行的：如果两个标签页打开同一个网站，它们会走相同的线路。

### 📌 粘性会话
轮换住宅网关会把会话 ID 编码在用户名里。ProxyDeck 内置了主流服务商的语法，并自动为你拼接出真实用户名：

| 服务商 | 实际发送为 |
|---|---|
| DataImpulse | `user__cr.us__sid.a1b2c3d4` |
| Bright Data | `user-country-us-session-a1b2c3d4` |
| Oxylabs | `user-cc-us-sessid-a1b2c3d4e5` |
| Smartproxy / Decodo | `user-country-us-session-a1b2c3d4e5` |
| IPRoyal | `user_country-us_session-a1b2c3d4` |
| 自定义 | 你自己的 `{cc}` / `{sid}` 模板 |

- 选择**国家**，网关就会给你该地区的出口
- 设置**保持 N 分钟**，到期后 ProxyDeck 会自动轮换 —— 填 `0` 表示一直保持
- 随时点击 **Rotate** 换一个新 IP
- 实际发送给网关的用户名始终可见，不必靠猜

### 📊 实时信息
- 出口 IP，附国旗、城市、地区、邮编
- ISP／组织、ASN、时区、经纬度、查询延迟
- 下载／上传字节数、会话时长、请求数、平均速率
- 一键复制完整位置报告

---

## 📦 安装

**从源码安装**（当前为未打包版本，推荐此方式）：

1. 下载或克隆本仓库
2. 打开 `chrome://extensions`
3. 打开右上角的**开发者模式**
4. 点击**加载已解压的扩展程序**，选择项目文件夹

**从 ZIP 安装：**

```bash
node tools/build-zip.js        # 生成 dist/proxydeck-<version>.zip
```

然后把 ZIP 拖到 `chrome://extensions` 页面上。

---

## 🚀 快速上手

1. 点击 ProxyDeck 图标 →**Add** 标签
2. 把代理字符串粘贴进 **Quick paste** 并点击 **Parse** —— 或者手动填写
3. *（可选）* 在 **Sticky session** 中选择服务商，设置国家和保持时间
4. *（可选）* 把 **Proxy scope** 设为 *Selected tabs only*
5. 点击 **Save & Connect**

Connect 标签页会立即显示新的出口 IP 及其位置。任何时候点击电源按钮即可恢复直连。

---

## 🧪 测试

所有功能都在真实浏览器与真实代理下验证过 —— 没有任何 mock。

```bash
# 175 条引擎断言，纯 Node，无需浏览器
node tests/run-tests.mjs

# 启动已加载扩展的 Chrome for Testing
bash tools/restart-chrome.sh

# 52 项检查：连接、认证、地理位置、计数器、断开
CDP_PORT=9335 python tools/e2e.py

# 33 项检查：粘性会话保持同一 IP、轮换、标签页隔离
CDP_PORT=9335 python tools/e2e_tabs.py
```

端到端测试会先记录你的真实 IP，通过真实的上游代理建立连接，断言页面加载来自另一个出口 —— 然后断开并断言 IP 恢复原状。标签页隔离的验证方式是同时加载两个标签页，检查它们报告的 IP **确实不同**。

也请测试打包后的产物，而不只是工作目录：

```bash
node tools/build-zip.js
unzip -o dist/proxydeck-*.zip -d /tmp/proxydeck-ship
EXT_DIR=/tmp/proxydeck-ship bash tools/restart-chrome.sh
CDP_PORT=9335 python tools/e2e.py
```

---

## 📁 项目结构

```
manifest.json                      Manifest V3
src/engine/proxy.js                纯逻辑 —— 解析、PAC、会话、流量计算
src/background/service-worker.js   chrome.proxy、认证、地理位置、字节计数、标签页范围
src/popup/                         popup.html · popup.css · popup.js
icons/                             生成的 PNG 图标集
tests/run-tests.mjs                175 条断言，零依赖
tools/build-zip.js                 ZIP 打包脚本
tools/make-icons.mjs               PNG 图标生成器
tools/restart-chrome.sh            Chrome for Testing 启动脚本
tools/e2e.py                       连接／地理位置／流量测试套件
tools/e2e_tabs.py                  标签页范围／粘性会话测试套件
tools/cdp.py                       极简 DevTools Protocol 客户端
```

无需构建步骤、无打包工具、无 `node_modules`。`engine/` 层是不含任何 `chrome.*` 调用的纯函数，因此整个测试套件在纯 Node 下毫秒级完成。

---

## 🔐 权限

| 权限 | 用途 |
|---|---|
| `proxy` | 设置与清除浏览器代理 |
| `storage` | 保存服务器配置与计数器 |
| `webRequest`、`webRequestAuthProvider` | 应答代理认证、统计流量 |
| `tabs`、`webNavigation` | 判断请求属于哪个标签页，用于标签页分流 |
| `alarms` | 刷新计数器、运行会话计时器 |
| `browsingData` | 轮换时清除已缓存的代理凭据 |
| `<all_urls>` | 在任意站点上代理并统计请求 |

**你的数据归你所有。** 不会上传任何内容。ProxyDeck 主动发起的唯一外部请求是 IP 位置查询（ipwho.is，备用 ipapi.co、geojs.io、ip-api.com）—— 而且这次请求本身就是*走你的代理*的，这正是它的意义所在。

---

## ⚠️ 已知限制

- **流量统计为估算值。** 它基于 `chrome.webRequest`，这是 MV3 扩展能获取的唯一线路级信号。服务器返回 `Content-Length` 时使用真实值；分块传输与压缩响应为近似值。
- **标签页分流按主机生效。** Chrome 没有按标签页设置代理的 API，同一站点在两个标签页中会走相同线路。
- **SOCKS 代理不支持认证。** 这是 Chrome 的限制，界面会在你尝试时给出提示。
- **轮换效果取决于网关。** 将会话绑定到端口的服务商需要配置端口范围；绑定到用户名的服务商开箱即用。

---

## 🤝 参与贡献

本项目基于 MIT 开源 —— 随意 fork、修改、发布、商用。欢迎提交 Pull Request。

提交之前请确认：

```bash
node tests/run-tests.mjs     # 必须保持全绿
```

如果你改动了路由、会话处理或计数器，请在 `tests/run-tests.mjs` 中补充断言；需要真实浏览器的场景请补充到 `tools/e2e_tabs.py`。

---

## 📄 许可证

[MIT](LICENSE) —— 随便用，保留版权声明即可。

---

## 👤 作者

**Ariful Islam** —— [@knownrdx](https://github.com/knownrdx)

如果 ProxyDeck 对你有帮助，点一个 ⭐ 对我意义重大。
