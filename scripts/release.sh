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
# 附件从 apps/desktop/release/ 按版本号自动挑选（六种格式）。
set -uo pipefail

REPO=${REPO:-fetilab/terminal-1000}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
REL_DIR="$ROOT/apps/desktop/release"
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

say() { printf '\033[36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31m失败:\033[0m %s\n' "$*" >&2; exit 1; }

VERSION=$(node -p "require('$ROOT/package.json').version")
TAG="v$VERSION"
say "版本 $VERSION（tag $TAG，仓库 $REPO）"

[ -d "$REL_DIR" ] || die "找不到 $REL_DIR，先跑 scripts/pack-local.sh"

# 附件：六种格式。文件名带版本号，缺一个就报出来而不是静默少传。
ASSETS=(
  "$REL_DIR/terminal-1000-$VERSION.AppImage"
  "$REL_DIR/terminal-1000_${VERSION}_amd64.deb"
  "$REL_DIR/terminal-1000-$VERSION.x86_64.rpm"
  "$REL_DIR/terminal-1000-$VERSION.pacman"
  "$REL_DIR/terminal-1000-$VERSION-x86_64.flatpak"
  "$REL_DIR/terminal-1000 Setup $VERSION.exe"
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
[ "$missing" -eq 0 ] || die "六种格式没齐，不会只上传一部分"

if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then
  die "工作区有未提交改动，先提交（Release 必须对应一个确定的提交）"
fi

[ "$DRY" -eq 0 ] || { say "--dry-run：到此为止"; exit 0; }

[ -n "${GITHUB_TOKEN:-}" ] || die "缺少 GITHUB_TOKEN（需要 repo 写权限）"

API="https://api.github.com/repos/$REPO"
auth=(-H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github+json")

# ── 1. 推代码 + tag ─────────────────────────────────────────────────────
say "推送 master"
git -C "$ROOT" push "https://x-access-token:$GITHUB_TOKEN@github.com/$REPO.git" HEAD:master || die "推送 master 失败"

if git -C "$ROOT" rev-parse "$TAG" >/dev/null 2>&1; then
  say "tag $TAG 已存在，跳过创建"
else
  git -C "$ROOT" tag -a "$TAG" -m "terminal-1000 $TAG"
fi
say "推送 tag $TAG"
git -C "$ROOT" push "https://x-access-token:$GITHUB_TOKEN@github.com/$REPO.git" "$TAG" || die "推送 tag 失败"

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

for f in "${ASSETS[@]}"; do
  name=$(basename "$f")
  if curl -sf "${auth[@]}" "$API/releases/tags/$TAG" | grep -q "\"name\": *\"$name\""; then
    say "已存在，跳过 $name"
    continue
  fi
  say "上传 $name"
  curl -sf -X POST "${auth[@]}" \
    -H 'Content-Type: application/octet-stream' \
    --data-binary "@$f" \
    "$upload_url?name=$(node -p 'encodeURIComponent(process.argv[1])' "$name")" >/dev/null \
    || die "上传 $name 失败"
done

say "完成：https://github.com/$REPO/releases/tag/$TAG"
