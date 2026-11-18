#!/usr/bin/env bash
# 打包并发布外置组件库（产物结构见 docs/deploy.md「发布组件库」）：
#   scripts/publish-components.sh <私有组件库路径> <本机输出目录> <目标位置>
# - <目标位置> 为部署目录下的 components/（支持本机路径或 主机:路径）。
# - <本机输出目录> 须长期保留复用，供打包比对已有 vendor/、拦截同名文件内容变更。
# - 上传前先校验目标位置已有的 vendor/ 文件无内容冲突，再按 vendor/ → <版本号>/ → catalog.json 顺序上传。
set -euo pipefail

die() {
  echo "$*" >&2
  exit 1
}

[ $# -eq 3 ] || die "用法：$0 <私有组件库路径> <本机输出目录> <目标位置>"
root=$(cd "$(dirname "$0")/.." && pwd -P)
library=$(cd "$1" && pwd -P) || die "找不到组件库目录 $1"
mkdir -p "$2"
out=$(cd "$2" && pwd -P)
dest=${3%/}
[ -n "$dest" ] || die "目标位置不能是根目录"

(cd "$root/web" && pnpm hf:registry --library "$library" --out "$out")
version=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version ?? "")' \
  "$out/catalog.json")
[ -n "$version" ] && [ -d "$out/$version" ] || die "打包结果里找不到 catalog.json 指向的版本目录：$version"

# 只比目标位置已有的文件（--existing），按内容比（-c）；要传数据的文件（itemize 以 <f 或 >f 开头）就是内容不同的。
changes=$(rsync -a -n -c --existing -i "$out/vendor" "$dest/") || die "核对目标位置的 vendor/ 失败"
conflicts=$(printf '%s\n' "$changes" | awk '/^[<>]f/ { sub(/^[^ ]+ /, ""); print "  " $0 }')
if [ -n "$conflicts" ]; then
  die "目标位置的 vendor/ 里有这些文件已存在、内容却不一样，什么都没传：
$conflicts"
fi

echo "上传 vendor/（只补目标位置没有的文件）"
rsync -a --ignore-existing "$out/vendor" "$dest/"
echo "上传 $version/"
rsync -a "$out/$version" "$dest/"
echo "上传 catalog.json"
rsync -a "$out/catalog.json" "$dest/"
echo "组件库 $version 已发布到 $dest/"
