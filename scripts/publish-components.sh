#!/usr/bin/env bash
# 打包并发布组件库（三部分各是什么见 docs/deploy.md「发布组件库」）：
#   scripts/publish-components.sh <私有组件库路径> <本机输出目录> <目标位置>
# 目标位置是部署目录的 components/，可以是本机路径，也可以是 主机:路径。
# 输出目录要长期保留、每次复用：打包时靠它里面已有的 vendor/ 拦下同路径不同内容的文件。
# 上传前先核对目标位置：vendor/ 里目标位置已有、内容却不一样的文件一个都不覆盖，发现就列出来报错退出，
# 什么都不传。之后按 vendor/（只增不删不改）→ <版本号>/ → catalog.json（最后传，原子替换）的顺序上传。
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
