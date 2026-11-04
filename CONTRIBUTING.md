# 贡献指南

感谢你有兴趣为 terminal-1000 做贡献。本项目以 **GPL-3.0** 发布。

## 开发流程

```bash
corepack enable
pnpm install
pnpm dev
```

提交前：

```bash
pnpm typecheck
pnpm test
```

## 强制要求

### 1. 不得引入专有或未明确许可的资源

这是本项目的红线。以下内容**一律不接受**：

- 其它终端/远程连接软件的代码、二进制、反编译产物
- 第三方软件的图标、插画、字体（除非许可明确允许再分发且已注明）
- 许可不明或禁止再分发的命令补全语料、命令手册文本
- 任何从专有软件包中提取的资源

引用第三方资源时，必须在 `THIRD-PARTY-NOTICES.md` 登记：名称、版本、许可证、来源 URL。

### 2. 许可证头

新增的源码文件请在文件顶部加 SPDX 标识（简短形式即可，无需粘贴 GPL 全文）：

```ts
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors
```

HTML / CSS / Markdown 对应形式：

```html
<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
```

### 3. 测试

- 新增功能：附单元测试，或在 PR 描述中给出可复现的手工验证步骤
- 修 bug：附能复现该 bug 的测试（回归测试优于一次性验证）
- 涉及网络/SSH 的测试：使用本地 mock，不要依赖外部主机

## 代码规范

- TypeScript strict 模式；避免 `any`，边界处用 `zod` 校验
- 主进程服务之间只通过 `packages/shared` 的类型交互，不要跨模块 import 内部实现
- 文件与目录命名：`kebab-case`；类型/组件：`PascalCase`
- 错误处理：面向用户的错误要有稳定的 `code` 与可读 `message`

## 提交信息

采用 Conventional Commits：

```
feat(ssh): 支持跳板机链路逐跳指纹校验
fix(sftp): 修正目录递归上传的进度统计
docs(readme): 补充数据存放位置
test(monitor): 补充采集脚本解析用例
```

## Pull Request

1. 一个 PR 只做一件事
2. 描述中说明：改了什么、为什么、怎么验证
3. 若涉及用户可见行为变化，同步更新 README

## 报告问题

请附上：操作系统与版本、terminal-1000 版本、复现步骤、期望与实际结果、相关日志。
**请勿在 Issue 中粘贴真实的密码、私钥或主机凭据** —— 请脱敏后再贴。
