#!/usr/bin/env bash
# 发版的两步与上线前摘要（流程见 docs/release.md「发版步骤」）：
#   release.sh summary <提交> [vX.Y.Z]  打印上一个版本标签到该提交的上线前摘要；只读本地 Git，不联网
#   release.sh check [分支]             拉取远端，取分支（缺省 main）最新提交打印摘要，确认它有一次成功的
#                                       手动触发的全量 ci（没有就触发并等它结束），最后打印打标签的命令
#   release.sh tag <vX.Y.Z> <提交>      校验后给该提交创建 GitHub Release：推送标签并触发镜像流水线
# 任何一项校验不通过都报错退出。打标签前须获得开发者明确确认，这一步由人把关，脚本不再询问。
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION_RE='^v[0-9]+\.[0-9]+\.[0-9]+$'
MIGRATIONS=server/migrations/versions
RUNTIME_PATHS=(runtime.ref plugins/video deploy/runtime-video)
CONFIG_FILES=(server/src/iclip/config/models.py deploy/compose.yaml deploy/runtime.example.yaml deploy/upgrade.sh)

die() {
  echo "$*" >&2
  exit 1
}

# 从提交往回能到达的、最近的 vX.Y.Z 标签（runtime-v* 等其他格式不算）。提交本身就是版本标签时报错。
previous_tag() {
  local sha=$1 tag
  tag=$(git describe --tags --abbrev=0 --match 'v[0-9]*' --exclude 'v*[!0-9.]*' "$sha" 2>/dev/null) ||
    die "从 $sha 往回找不到 vX.Y.Z 版本标签"
  [[ $tag =~ $VERSION_RE ]] || die "最近的版本标签 $tag 不是 vX.Y.Z 格式"
  [ "$(git rev-list --count "$tag..$sha")" -gt 0 ] || die "提交 $sha 已经是 ${tag}，没有新提交可发"
  printf '%s\n' "$tag"
}

# 打印迁移文件里按关键字看像是删除或改动已有结构的行。downgrade() 的函数体本来就是删除，不看；
# 模块级的 SQL 常量要看，upgrade() 常把语句写在常量里再执行（常量也可能只给 downgrade() 用，宁可多报）。
risky_lines() {
  git show "$1" | awk '
    /^def downgrade/ { skip = 1; next }
    /^(def |[A-Za-z_])/ { skip = 0 }
    !skip {
      line = tolower($0)
      if (line ~ /drop|rename|truncate|alter_column|alter column|set data type/) {
        sub(/^[ \t]+/, "")
        print "    - `" $0 "`"
      }
    }'
}

summary() {
  local sha prev version count file changed old new
  sha=$(git rev-parse --verify --quiet "$1^{commit}") || die "找不到提交 $1"
  version=${2:-vX.Y.Z}
  prev=$(previous_tag "$sha")
  count=$(git rev-list --count "$prev..$sha")

  echo "## 上线前要看的摘要"
  echo
  echo "对比范围：\`$prev\` 到 \`${sha:0:12}\`，共 $count 个提交。"
  echo

  echo "### 运行时"
  echo
  local runtime_changed=false
  if git diff --quiet "$prev" "$sha" -- "${RUNTIME_PATHS[@]}"; then
    echo "不用升级：\`runtime.ref\`、\`plugins/video/\`、\`deploy/runtime-video/\` 都没有改动。"
  else
    runtime_changed=true
    echo "要升级，有改动的是："
    for file in "${RUNTIME_PATHS[@]}"; do
      git diff --quiet "$prev" "$sha" -- "$file" && continue
      if [ "$file" = runtime.ref ]; then
        old=$(git show "$prev:runtime.ref" 2>/dev/null || echo '（没有这个文件）')
        new=$(git show "$sha:runtime.ref")
        echo "- \`runtime.ref\`：\`$old\` → \`$new\`。运行时自己的迁移在运行时项目 Cue 里，这里看不到，到它那边对照这两个版本之间的迁移。"
      else
        echo "- \`$file/\`：$(git diff --name-only "$prev" "$sha" -- "$file" | wc -l | tr -d ' ') 个文件"
      fi
    done
  fi
  echo

  echo "### 后端迁移"
  echo
  local added risky=""
  added=$(git diff --name-only --diff-filter=A "$prev" "$sha" -- "$MIGRATIONS" | grep '\.py$' || true)
  if [ -z "$added" ]; then
    echo "没有新增迁移。"
  else
    echo "新增的迁移："
    for file in $added; do
      echo "- \`${file##*/}\`"
      local lines
      lines=$(risky_lines "$sha:$file")
      [ -n "$lines" ] && risky="$risky- \`${file##*/}\`"$'\n'"$lines"$'\n'
    done
  fi
  changed=$(git diff --name-only --diff-filter=MDR "$prev" "$sha" -- "$MIGRATIONS" || true)
  if [ -n "$changed" ]; then
    echo
    echo "改动了已有的迁移文件（已在线上跑过的迁移不会重跑）："
    for file in $changed; do echo "- \`$file\`"; done
  fi
  if [ -n "$risky" ]; then
    echo
    echo "**以下迁移按关键字看有删除或改动已有结构的操作**（只是按关键字匹配的提示，不看 \`downgrade()\`，可能有漏有误，以迁移代码为准）。这样的版本跑完迁移后上一个版本的代码可能用不了，回滚镜像前要先处理数据库（规则见 \`docs/architecture.md\`「后端的持久化与迁移」）："
    echo
    printf '%s' "$risky"
  fi
  echo

  echo "### 配置与编排"
  echo
  local configs=""
  for file in "${CONFIG_FILES[@]}"; do
    git diff --quiet "$prev" "$sha" -- "$file" || configs="$configs- \`$file\`"$'\n'
  done
  if [ -z "$configs" ]; then
    echo "都没有改动。"
  else
    echo "有改动，升级前在服务器上对照新版本补齐："
    printf '%s' "$configs"
  fi
  echo

  echo "### 建议的升级命令"
  echo
  if [ "$runtime_changed" = true ]; then
    echo "\`./upgrade.sh all $version --app-first\` 或 \`./upgrade.sh all $version --runtime-first\`，顺序按 \`contract/conventions.md\`「跨版本兼容」的升级顺序选。"
  else
    echo "\`./upgrade.sh app $version\`"
  fi
}

# 该提交最近一次成功的手动触发（workflow_dispatch）ci 的地址；没有就输出空。
successful_run() {
  gh run list --workflow ci.yml --event workflow_dispatch --commit "$1" --status success \
    --limit 1 --json url --jq '.[0].url // empty'
}

latest_dispatch_id() {
  gh run list --workflow ci.yml --event workflow_dispatch --branch "$1" \
    --limit 1 --json databaseId --jq '.[0].databaseId // 0'
}

# 在分支上手动触发全量 ci 并等它结束；这次运行检查的不是待发的提交或运行没有成功时报错退出。
trigger_and_wait() {
  local ref=$1 sha=$2 before out id head conclusion
  before=$(latest_dispatch_id "$ref")
  out=$(gh workflow run ci.yml --ref "$ref")
  [ -n "$out" ] && echo "$out"
  # gh 能拿到新运行的地址时会打印出来；拿不到就等分支上出现比触发前更新的手动运行。
  id=$(printf '%s\n' "$out" | sed -n 's|.*/actions/runs/\([0-9][0-9]*\).*|\1|p' | head -n 1)
  local tries=0
  while [ -z "$id" ]; do
    local latest
    latest=$(latest_dispatch_id "$ref")
    if [ "$latest" -gt "$before" ]; then
      id=$latest
    else
      tries=$((tries + 1))
      [ "$tries" -le 12 ] || die "触发后 60 秒内没有在 $ref 上看到新的手动 ci 运行"
      sleep 5
    fi
  done

  head=$(gh run view "$id" --json headSha --jq .headSha)
  [ "$head" = "$sha" ] ||
    die "这次 ci 运行（${id}）检查的是 ${head}，不是待发的 ${sha}：触发前 $ref 又进了新提交，重新执行 make release-check"
  echo "等待 ci 运行 $id 结束……"
  gh run watch "$id" --interval 30 >/dev/null
  conclusion=$(gh run view "$id" --json conclusion,url --jq '.conclusion + " " + .url')
  [ "${conclusion%% *}" = success ] || die "ci 运行没有成功：$conclusion"
  echo "ci 通过：${conclusion#* }"
}

check() {
  local ref=${1:-main} sha run
  git fetch origin --tags
  sha=$(git rev-parse --verify --quiet "refs/remotes/origin/$ref^{commit}") || die "远端没有分支 $ref"
  summary "$sha"
  echo
  run=$(successful_run "$sha")
  if [ -n "$run" ]; then
    echo "这个提交已有成功的手动全量 ci，不再触发：$run"
  else
    echo "这个提交还没有成功的手动全量 ci，在 $ref 上触发一次。"
    trigger_and_wait "$ref" "$sha"
  fi
  echo
  echo "确认上面的摘要、获得开发者同意后，执行（版本号由开发者定）："
  echo "  make release VERSION=vX.Y.Z SHA=$sha"
}

tag() {
  local version=$1 sha=$2 prev notes rc
  [[ $version =~ $VERSION_RE ]] || die "版本号要写成 vX.Y.Z：$version"
  [[ $sha =~ ^[0-9a-f]{40}$ ]] || die "SHA 要写 make release-check 最后打印的完整 40 位提交哈希：$sha"
  git fetch origin --tags
  git cat-file -e "$sha^{commit}" 2>/dev/null || die "找不到提交 $sha"
  ! git rev-parse --verify --quiet "refs/tags/$version" >/dev/null || die "标签 $version 本地已经存在"
  rc=0
  git ls-remote --exit-code --tags origin "refs/tags/$version" >/dev/null || rc=$?
  case $rc in
    0) die "标签 $version 远端已经存在" ;;
    2) ;;
    *) die "查不了远端标签（git ls-remote 退出码 ${rc}）" ;;
  esac
  [ -n "$(successful_run "$sha")" ] || die "提交 $sha 没有成功的手动全量 ci，先执行 make release-check"

  prev=$(previous_tag "$sha")
  notes=$(summary "$sha" "$version")
  gh release create "$version" --target "$sha" --title "$version" \
    --notes "$notes" --generate-notes --notes-start-tag "$prev"
  git fetch origin --tags
  echo
  echo "已创建 ${version}，镜像流水线随标签推送开始。查它的结果（输出 completed success 才算完成）："
  echo "  gh api \"repos/{owner}/{repo}/actions/workflows/release-images.yml/runs?event=push&branch=$version\" --jq 'first(.workflow_runs[]) | .status + \" \" + .conclusion'"
}

usage() {
  die "用法：$0 summary <提交> [vX.Y.Z] | check [分支] | tag <vX.Y.Z> <提交>"
}

case ${1:-} in
  summary) [ $# -ge 2 ] && [ $# -le 3 ] || usage; summary "$2" "${3:-}" ;;
  check) [ $# -le 2 ] || usage; check "${2:-main}" ;;
  tag) [ $# -eq 3 ] || usage; tag "$2" "$3" ;;
  *) usage ;;
esac
