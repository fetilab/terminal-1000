// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 terminal-1000 contributors

/**
 * Monaco 的**按需装配**（仅本模块 import monaco，其它地方只 import 它的导出）。
 *
 * 为什么不 `import * as monaco from 'monaco-editor'`：
 * 包根会带上**全部 84 种语言**与全部语言服务（json/ts/css/html 的 worker），
 * 体积与首屏都吃不消。这里只取：
 * - `editor.main`：完整编辑器（含**查找替换**等 contrib）
 * - 十几种**语法着色**用得到的语言
 *
 * 注意没有引入 `vs/language/*`（JSON/TS 的语言服务）——那会额外带来 worker 与
 * 校验/补全能力，但**语法高亮 + 查找替换不需要它们**，而我们的体积预算很紧。
 */

// ⚠️ 实测：用 `editor.main` 会连带把 json/css/html/ts 的**语言服务 worker**
// （共 17.4MB）一起打进产物。只要编辑器本身（含查找替换）用 `editor.api` + 按需 contrib。
import * as monaco from 'monaco-editor/editor/editor.api'
import 'monaco-editor/editor/contrib/find/browser/findController'
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching'
import 'monaco-editor/editor/contrib/folding/browser/folding'
import 'monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter'
import 'monaco-editor/editor/contrib/comment/browser/comment'

// 语言：只按语法着色的需求挑（每个 register 都很小）
import 'monaco-editor/languages/definitions/shell/register'
import 'monaco-editor/languages/definitions/python/register'
import 'monaco-editor/languages/definitions/javascript/register'
import 'monaco-editor/languages/definitions/typescript/register'
import 'monaco-editor/languages/definitions/yaml/register'
import 'monaco-editor/languages/definitions/ini/register'
import 'monaco-editor/languages/definitions/markdown/register'
import 'monaco-editor/languages/definitions/dockerfile/register'
import 'monaco-editor/languages/definitions/xml/register'
import 'monaco-editor/languages/definitions/css/register'
import 'monaco-editor/languages/definitions/html/register'
import 'monaco-editor/languages/definitions/sql/register'
import 'monaco-editor/languages/definitions/cpp/register'
import 'monaco-editor/languages/definitions/go/register'
import 'monaco-editor/languages/definitions/rust/register'
import 'monaco-editor/languages/definitions/java/register'
import 'monaco-editor/languages/definitions/lua/register'
import 'monaco-editor/languages/definitions/powershell/register'
import 'monaco-editor/languages/definitions/bat/register'
import 'monaco-editor/languages/definitions/php/register'
import 'monaco-editor/languages/definitions/ruby/register'
import 'monaco-editor/languages/definitions/csharp/register'
import 'monaco-editor/languages/definitions/perl/register'
import 'monaco-editor/languages/definitions/r/register'
import 'monaco-editor/languages/definitions/scss/register'
import 'monaco-editor/languages/definitions/less/register'
import 'monaco-editor/languages/definitions/graphql/register'
import 'monaco-editor/languages/definitions/hcl/register'
import 'monaco-editor/languages/definitions/protobuf/register'
import 'monaco-editor/languages/definitions/clojure/register'
import 'monaco-editor/languages/definitions/dart/register'
import 'monaco-editor/languages/definitions/kotlin/register'
import 'monaco-editor/languages/definitions/swift/register'
import 'monaco-editor/languages/definitions/coffee/register'
import 'monaco-editor/languages/definitions/fsharp/register'
import 'monaco-editor/languages/definitions/julia/register'
import 'monaco-editor/languages/definitions/pascal/register'
import 'monaco-editor/languages/definitions/vb/register'
import 'monaco-editor/languages/definitions/objective-c/register'
import 'monaco-editor/languages/definitions/azcli/register'
import 'monaco-editor/languages/definitions/bicep/register'
import 'monaco-editor/languages/definitions/redis/register'
import 'monaco-editor/languages/definitions/pug/register'
import 'monaco-editor/languages/definitions/handlebars/register'

export { monaco }
