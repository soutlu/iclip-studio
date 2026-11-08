#!/usr/bin/env bash

# 服务器上升级应用或运行时：拉镜像、改 .env 里的版本号、迁移、重启、等健康。
# 与 compose.yaml 放在同一部署目录，在该目录执行。步骤说明见仓库 docs/deploy.md「升级」。

set -euo pipefail

HEALTH_TIMEOUT=180

usage() {
  cat >&2 <<'EOF'
用法：
  ./upgrade.sh app vX.Y.Z                                  升级后端、前端与渲染服务，运行时不动
  ./upgrade.sh runtime runtime-vX.Y.Z [--stamp-baseline]   只升级运行时
      --stamp-baseline 只在第一次升到运行时自己管迁移的版本时用一次
EOF
  exit 2
}

die() {
  echo "错误：$*" >&2
  exit 1
}

# 读 .env 里某个变量的值；没有这一行或值为空都输出空串。
env_get() {
  grep -E "^$1=" .env | tail -n 1 | cut -d= -f2- || true
}

# 改 .env 里某个变量：有这一行就替换，没有就追加。写回原文件，保留权限与属主。
env_set() {
  local key=$1 value=$2 tmp
  if grep -qE "^${key}=" .env; then
    tmp=$(mktemp)
    awk -v k="$key" -v v="$value" 'index($0, k "=") == 1 { print k "=" v; next } { print }' .env >"$tmp"
    cat "$tmp" >.env
    rm -f "$tmp"
  else
    # 末行没有换行时先补一个
    if [[ -s .env && -n $(tail -c 1 .env) ]]; then
      echo >>.env
    fi
    echo "${key}=${value}" >>.env
  fi
}

rollback_hint() {
  echo >&2
  echo "升级没有完成。.env 里的 ${var} 已改成 ${version}，回滚：" >&2
  if [[ -n $old ]]; then
    echo "  1. 把 .env 里的 ${var} 改回 ${old}" >&2
  else
    echo "  1. 删掉 .env 里的 ${var} 这一行（升级前没有，缺省为 latest）" >&2
  fi
  echo "  2. docker compose up -d ${up_args[*]}" >&2
  echo "数据库迁移不会自动回退，已执行的迁移需要另行处理。" >&2
}

wait_healthy() {
  local service=$1 cid status deadline
  deadline=$((SECONDS + HEALTH_TIMEOUT))
  cid=$(docker compose ps -q "$service")
  [[ -n $cid ]] || die "${service} 容器没有在运行，查看日志：docker compose logs ${service}"
  while true; do
    status=$(docker inspect -f '{{.State.Health.Status}}' "$cid")
    if [[ $status == healthy ]]; then
      echo "${service} 已健康"
      return
    fi
    if ((SECONDS >= deadline)); then
      die "${service} ${HEALTH_TIMEOUT} 秒内没有变为健康（当前 ${status}），查看日志：docker compose logs ${service}"
    fi
    sleep 3
  done
}

wait_running() {
  local service=$1 cid status
  cid=$(docker compose ps -q "$service")
  [[ -n $cid ]] || die "${service} 容器没有在运行，查看日志：docker compose logs ${service}"
  status=$(docker inspect -f '{{.State.Status}}' "$cid")
  [[ $status == running ]] || die "${service} 容器状态为 ${status}，查看日志：docker compose logs ${service}"
  echo "${service} 在运行"
}

[[ $# -ge 2 ]] || usage
target=$1
version=$2
stamp_baseline=false
case $target in
  app)
    [[ $# -eq 2 && $version =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || usage
    var=IMAGE_TAG
    services=(server web render)
    up_args=(server web render)
    ;;
  runtime)
    [[ $version =~ ^runtime-v[0-9]+\.[0-9]+\.[0-9]+$ ]] || usage
    if [[ $# -eq 3 && $3 == --stamp-baseline ]]; then
      stamp_baseline=true
    elif [[ $# -ne 2 ]]; then
      usage
    fi
    var=RUNTIME_IMAGE_TAG
    services=(runtime)
    up_args=(--no-deps runtime)
    ;;
  *)
    usage
    ;;
esac

[[ -f compose.yaml && -f .env ]] || die "当前目录缺少 compose.yaml 或 .env，请在部署目录执行"

# 版本号以 .env 为准：shell 里导出的同名变量会盖过 .env，让后面的迁移与重启用错版本。
unset IMAGE_TAG RUNTIME_IMAGE_TAG

# compose 里 RUNTIME_IMAGE_TAG 缺省为 latest，.env 不写的话升级应用时拉取会把运行时带到最新，
# 所以先把运行时当前在用的版本写进 .env。
if [[ $target == app && -z $(env_get RUNTIME_IMAGE_TAG) ]]; then
  runtime_cid=$(docker compose ps -q runtime)
  runtime_tag=
  if [[ -n $runtime_cid ]]; then
    runtime_image=$(docker inspect -f '{{.Config.Image}}' "$runtime_cid")
    # 标签在最后一个 / 之后的冒号后面；没有冒号说明镜像没带标签
    if [[ ${runtime_image##*/} == *:* ]]; then
      runtime_tag=${runtime_image##*:}
    fi
  fi
  if [[ -z $runtime_tag || $runtime_tag == latest ]]; then
    die ".env 里没有 RUNTIME_IMAGE_TAG，也读不出运行时容器当前的版本，请手动在 .env 里写上 RUNTIME_IMAGE_TAG=<运行时当前版本>"
  fi
  env_set RUNTIME_IMAGE_TAG "$runtime_tag"
  echo ".env 里没有 RUNTIME_IMAGE_TAG，已按运行时容器当前的版本补上：RUNTIME_IMAGE_TAG=${runtime_tag}"
fi

old=$(env_get "$var")
echo "${var}：${old:-（未设置，缺省 latest）} → ${version}"

echo "拉取镜像：${services[*]}"
if ! env "${var}=${version}" docker compose pull "${services[@]}"; then
  die "拉取镜像失败，.env 里的 ${var} 没有改动。请检查版本号 ${version} 是否存在、服务器是否已 docker login"
fi

trap rollback_hint EXIT
env_set "$var" "$version"

if [[ $target == app ]]; then
  echo "执行后端迁移"
  docker compose run --rm server alembic upgrade head
  echo "重启：${up_args[*]}"
  docker compose up -d "${up_args[@]}"
  wait_healthy server
  wait_healthy render
  wait_running web
else
  if [[ $stamp_baseline == true ]]; then
    echo "打运行时迁移基线标记"
    docker compose run --rm --no-deps runtime python -m agent_runtime.admin stamp-baseline
  fi
  echo "执行运行时迁移"
  docker compose run --rm --no-deps runtime python -m agent_runtime.admin migrate
  echo "重启：runtime"
  docker compose up -d "${up_args[@]}"
  wait_healthy runtime
fi

trap - EXIT
echo "升级完成。${var}：${old:-（未设置，缺省 latest）} → ${version}"

# 只清没有标签的悬空镜像；带标签的旧版本保留，回滚时要用。
docker image prune -f
