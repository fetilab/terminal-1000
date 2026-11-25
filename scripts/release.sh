#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 terminal-1000 contributors
#
# 把一个版本的构建产物发到 GitHub Releases。
#
# 本机没有落盘的推送凭据（无 credential.helper、无 gh CLI），所以 token 走环境变量，
# 用完即弃，不写进任何文件：
#
#   GITHUB_TOKEN=ghp_xxx scripts/release.sh            # 用 package.json 里的版本
#   GITHUB_TOKEN=ghp_xxx scripts/release.sh --dry-run  # 只打印将要做什么
#
# 做的事：确认工作区干净 → 推 master → 建 tag → 建 Release → 逐个上传附件。
# 附件从 apps/desktop/release/ 按版本号自动挑选（六种桌面格式 + 两个 Android ABI）。
set -uo pipefail

REPO=${REPO:-fetilab/terminal-1000}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
REL_DIR="$ROOT/apps/desktop/release"
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

say() { printf '\033[36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31m失败:\033[0m %s\n' "$*" >&2; exit 1; }

# ── 推送用的 git 配置隔离 ────────────────────────────────────────────────
# 这台机器的 ~/.gitconfig 里挂了几条加速规则：
#   url.https://<第三方代理>/https://github.com/.insteadof = https://github.com/
# 它们对匿名 clone 有用，但推送 URL 里内嵌了 token，一旦被 insteadOf 改写，
# token 就会随 URL 明文发给那个代理（出现在对方访问日志里）。
# 所以推送/建 tag 一律用一份临时 global 配置：只保留 user 身份与 proxy/sslverify
# （proxy 是访问 GitHub 的通道，必须留着），一条 url.*.insteadof 都不带。
GITCFG=$(mktemp)
trap 'rm -f "$GITCFG"' EXIT
{
  printf '[user]\n\tname = %s\n\temail = %s\n' \
    "$(git -C "$ROOT" config user.name || echo 'terminal-1000 releases')" \
    "$(git -C "$ROOT" config user.email || echo 'noreply@localhost')"
  for key in http.proxy https.proxy http.sslverify; do
    v=$(git -C "$ROOT" config --get "$key" 2>/dev/null) || continue
    printf '[%s]\n\t%s = %s\n' "${key%%.*}" "${key#*.}" "$v"
  done
} > "$GITCFG"
git_iso() { GIT_CONFIG_GLOBAL="$GITCFG" git -C "$ROOT" "$@"; }

# GitHub 会把资产名里的空格改写成点：本地 `terminal-1000 Setup 0.3.0.exe`
# 上传后叫 `terminal-1000.Setup.0.3.0.exe`。两处都依赖这个名字，所以统一走
# 这一个函数，否则：
#   · 校验和清单里写的是本地名，用户下载后 `sha256sum -c` 报「找不到文件」；
#   · 「已存在就跳过」永远匹配不上，重发一次就把 8 个包再传 750MB。
remote_name() { printf '%s' "${1// /.}"; }

VERSION=$(node -p "require('$ROOT/package.json').version")
TAG="v$VERSION"
say "版本 $VERSION（tag $TAG，仓库 $REPO）"

[ -d "$REL_DIR" ] || die "找不到 $REL_DIR，先跑 scripts/pack-local.sh"

# 附件：六种桌面格式 + 两个 Android ABI。
# 文件名带版本号，缺一个就报出来而不是静默少传。
#
# Android 两个包由 `apps/android` 的打包流程产出（需要 Android SDK）：
#   assembleRelease → zipalign → apksigner，产物拷进 same release 目录即可。
ASSETS=(
  "$REL_DIR/terminal-1000-$VERSION.AppImage"
  "$REL_DIR/terminal-1000_${VERSION}_amd64.deb"
  "$REL_DIR/terminal-1000-$VERSION.x86_64.rpm"
  "$REL_DIR/terminal-1000-$VERSION.pacman"
  "$REL_DIR/terminal-1000-$VERSION-x86_64.flatpak"
  "$REL_DIR/terminal-1000 Setup $VERSION.exe"
  "$REL_DIR/terminal-1000-$VERSION-arm64-v8a.apk"
  "$REL_DIR/terminal-1000-$VERSION-x86_64.apk"
)
missing=0
for f in "${ASSETS[@]}"; do
  if [ -f "$f" ]; then
    say "附件 $(basename "$f")  $(du -h "$f" | cut -f1)"
  else
    printf '\033[33m缺附件:\033[0m %s\n' "$f" >&2
    missing=1
  fi
done
[ "$missing" -eq 0 ] || die "八种格式没齐，不会只上传一部分"

if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then
  die "工作区有未提交改动，先提交（Release 必须对应一个确定的提交）"
fi

[ "$DRY" -eq 0 ] || { say "--dry-run：到此为止"; exit 0; }

[ -n "${GITHUB_TOKEN:-}" ] || die "缺少 GITHUB_TOKEN（需要 repo 写权限）"

# 隔离自检：隔离后的配置里绝不能还有 url.*.insteadOf。
# 有的话说明 insteadOf 来自 system 层（/etc/gitconfig），临时 global 挡不住，
# 这时宁可停下来也不能把 token 推给第三方。
if git_iso config --get-regexp '^url\.' >/dev/null 2>&1; then
  die "git 配置隔离失败：仍能读到 url.*.insteadOf 规则，推送会把 token 发给第三方代理"
fi
say "推送通道已隔离：insteadOf 规则全部屏蔽，proxy 保留"

API="https://api.github.com/repos/$REPO"
auth=(-H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github+json")
# 附件动辄上百 MB，网络抖一下不能整个发布重来。
net=(--retry 5 --retry-delay 8 --retry-all-errors --connect-timeout 30)
# 进度条只在终端里有意义；重定向到日志时它会被写成一行几 MB 的 '\r' 垃圾，
# 所以非 tty 一律关掉（--no-progress-meter 只关进度、仍会打印错误）。
if [ -t 2 ]; then PROG=(--progress-bar); else PROG=(--no-progress-meter); fi

# ── 1. 推代码 + tag ─────────────────────────────────────────────────────
say "推送 master"
git_iso push "https://x-access-token:$GITHUB_TOKEN@github.com/$REPO.git" HEAD:master \
  || die "推送 master 失败"

if git_iso rev-parse "$TAG" >/dev/null 2>&1; then
  say "tag $TAG 已存在，跳过创建"
else
  git_iso tag -a "$TAG" -m "terminal-1000 $TAG"
fi
say "推送 tag $TAG"
git_iso push "https://x-access-token:$GITHUB_TOKEN@github.com/$REPO.git" "$TAG" \
  || die "推送 tag 失败"

# ── 2. 建 Release（已存在就复用）────────────────────────────────────────
notes=$(sed -n "/^## \[$VERSION\]/,/^## \[/p" "$ROOT/CHANGELOG.md" | sed '$d')
if curl -sf "${auth[@]}" "$API/releases/tags/$TAG" >/dev/null; then
  say "Release $TAG 已存在，复用它"
else
  say "创建 Release $TAG"
  body=$(printf '%s' "$notes" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify({tag_name:process.argv[1],name:process.argv[1],body:s.slice(0,60000)})))' "$TAG")
  curl -sf -X POST "${auth[@]}" -H 'Content-Type: application/json' \
    -d "$body" "$API/releases" >/dev/null || die "创建 Release 失败"
fi

# ── 3. 上传附件（已存在同名就跳过）──────────────────────────────────────
upload_url=$(curl -sf "${auth[@]}" "$API/releases/tags/$TAG" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.upload_url.replace(/\{.*\}$/,""))})')
[ -n "$upload_url" ] || die "拿不到 upload_url"

# 已有的附件名一次问清，别每传一个都重新拉一遍 release（8 个包就是 8 次请求）。
existing=$(curl -sf "${auth[@]}" "$API/releases/tags/$TAG" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log((j.assets||[]).map(a=>a.name).join("\n"))})')

# 校验和清单自己生成而不是手写：文件名必须与 GitHub 上完全一致才可能校验通过。
SUMS="$REL_DIR/SHA256SUMS.txt"
say "生成 SHA256SUMS.txt（文件名用 GitHub 规范化后的形式）"
: > "$SUMS"
for f in "${ASSETS[@]}"; do
  printf '%s  %s\n' "$(sha256sum "$f" | cut -d' ' -f1)" \
    "$(remote_name "$(basename "$f")")" >> "$SUMS"
done

for f in "${ASSETS[@]}"; do
  name=$(remote_name "$(basename "$f")")
  if printf '%s\n' "$existing" | grep -Fxq -- "$name"; then
    say "已存在，跳过 $name"
    continue
  fi
  say "上传 $name（$(du -h "$f" | cut -f1)，最大可能要几分钟）"
  curl "${net[@]}" -f "${PROG[@]}" -X POST "${auth[@]}" \
    -H 'Content-Type: application/octet-stream' \
    --data-binary "@$f" \
    "$upload_url?name=$(node -p 'encodeURIComponent(process.argv[1])' "$name")" >/dev/null \
    || die "上传 $name 失败"
  say "  ✓ $name"
done

# 校验和清单（可选附件，不参与「八包齐全」校验）
if ! printf '%s\n' "$existing" | grep -Fxq -- "SHA256SUMS.txt"; then
  say "上传 SHA256SUMS.txt"
  curl "${net[@]}" -f "${PROG[@]}" -X POST "${auth[@]}" \
    -H 'Content-Type: text/plain' \
    --data-binary "@$SUMS" "$upload_url?name=SHA256SUMS.txt" >/dev/null \
    || say "  （校验和上传失败，不影响八包）"
fi

say "完成：https://github.com/$REPO/releases/tag/$TAG"
