#!/usr/bin/env bash

# 服务器上升级应用、运行时或两边：拉镜像、核对并按需迁移、更新版本号、重启、等健康。
# 与 compose.yaml 放在同一部署目录，在该目录执行。步骤说明见仓库 docs/deploy.md「升级」。

set -euo pipefail
# 被中断（Ctrl-C）或 kill 时按退出处理：后面登记的退出处理（重启原版运行时、打印回滚步骤）才会执行。
trap 'exit 130' INT
trap 'exit 143' TERM

HEALTH_TIMEOUT=180

usage() {
  cat >&2 <<'EOF'
用法：
  ./upgrade.sh app vX.Y.Z                            只升级后端、前端与渲染服务，运行时不动
  ./upgrade.sh runtime vX.Y.Z [--stamp-baseline]     只升级运行时
      --stamp-baseline 只在第一次升到运行时自己管迁移的版本时用一次
  ./upgrade.sh all vX.Y.Z --app-first|--runtime-first
                                                     两边都升级到 vX.Y.Z，先升参数里写的那一边，
                                                     成功后再升另一边；先后顺序必须写明
EOF
  exit 2
}

die() {
  echo "错误：$*" >&2
  exit 1
}

# 按升级对象设置名称、.env 里的版本变量、跑迁移的服务、要拉的镜像与重启参数。
configure() {
  case $1 in
    app)
      label=应用
      var=IMAGE_TAG
      migration_service=server
      services=(server web render)
      up_args=(server web render)
      ;;
    runtime)
      label=运行时
      var=RUNTIME_IMAGE_TAG
      migration_service=runtime
      services=(runtime)
      up_args=(--no-deps runtime)
      ;;
  esac
}

# 打印把一边恢复到升级前版本的两步：$1 版本变量，$2 升级前的值（空表示原来没有这一行），其余为重启参数。
restore_steps() {
  local key=$1 value=$2
  shift 2
  if [[ -n $value ]]; then
    echo "  1. 把 .env 里的 ${key} 改回 ${value}" >&2
  else
    echo "  1. 删掉 .env 里的 ${key} 这一行（升级前没有，缺省为 latest）" >&2
  fi
  echo "  2. docker compose up -d $*" >&2
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

run_migration_container() {
  env "${var}=${version}" docker compose run --rm --no-deps -T "$migration_service" "$@"
}

migration_status() {
  # 直接读取 Alembic 版本表。alembic current 会加载 env.py 并尝试创建 schema。
  run_migration_container python - "$target" <<'PY'
import asyncio
import os
import sys
from pathlib import Path

from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.script import ScriptDirectory


async def check_migration_status():
    if sys.argv[1] == "app":
        from iclip.domains.identity.infra_sql import DB_SCHEMA
        from iclip.platform.db.engine import build_engine

        scripts = ScriptDirectory.from_config(Config("alembic.ini"))
        engine = build_engine(os.environ["DATABASE_URL"])
    else:
        from pydantic import ValidationError
        from sqlalchemy.ext.asyncio import create_async_engine

        from agent_runtime.harness.sessions import DB_SCHEMA
        from agent_runtime.migrations import runner
        from agent_runtime.settings import CoreEnv

        scripts = ScriptDirectory(str(Path(runner.__file__).parent))
        try:
            database_url = CoreEnv().database_url
        except ValidationError as exc:
            raise SystemExit(exc.errors()[0]["msg"]) from None
        engine = create_async_engine(database_url)

    def read_heads(connection):
        migration = MigrationContext.configure(connection, opts={"version_table_schema": DB_SCHEMA})
        return set(migration.get_current_heads())

    try:
        expected = set(scripts.get_heads())
        if not expected:
            raise SystemExit("目标镜像没有 Alembic 迁移版本")
        async with engine.connect() as connection:
            await connection.exec_driver_sql("SET TRANSACTION READ ONLY")
            current = await connection.run_sync(read_heads)
    finally:
        await engine.dispose()

    unknown = current.difference(revision.revision for revision in scripts.walk_revisions())
    if unknown:
        raise SystemExit(f"目标镜像无法识别 {DB_SCHEMA} 的迁移版本 {', '.join(sorted(unknown))}")

    print(
        f"{DB_SCHEMA} 当前版本 {', '.join(sorted(current)) or '未登记'}，"
        f"目标版本 {', '.join(sorted(expected))}",
        file=sys.stderr,
    )
    print("current" if current == expected else "pending")


asyncio.run(check_migration_status())
PY
}

restart_old_runtime() {
  echo >&2
  echo "运行时迁移没有完成，按原版本重新启动运行时（.env 未改动；迁移在一个事务里，没完成的不会留下）" >&2
  docker compose up -d --no-deps runtime >&2 ||
    echo "运行时没能重新启动，请手动执行：docker compose up -d --no-deps runtime" >&2
}

rollback_hint() {
  echo >&2
  echo "升级没有完成。请按以下步骤恢复 .env 中的 ${var} 并重启：" >&2
  restore_steps "$var" "$old" "${up_args[@]}"
  echo "数据库迁移不会自动回退，已执行的迁移需要另行处理。" >&2
}

# 同时升级应用与运行时：在独立子进程中按指定顺序分别执行单边升级（保留单边升级自身的错误退出与提示）。
# $1 第一步升级的一端，$2 第二步升级的一端。
upgrade_all() {
  local first=$1 second=$2 first_label first_var first_old second_label second_var second_old now
  local -a first_up second_up
  configure "$first"
  first_label=$label first_var=$var first_up=("${up_args[@]}")
  configure "$second"
  second_label=$label second_var=$var second_up=("${up_args[@]}")

  first_old=$(env_get "$first_var")
  echo "== 先升级${first_label}"
  if ! bash "$0" "$first" "$version"; then
    echo >&2
    echo "${first_label}升级未完成（见上方提示），${second_label}未启动升级。" >&2
    exit 1
  fi

  # 第二步的旧版本须在第一步完成后读取（首次升级应用会自动补填 .env 中的 RUNTIME_IMAGE_TAG）。
  second_old=$(env_get "$second_var")
  echo "== 再升级${second_label}"
  if ! bash "$0" "$second" "$version"; then
    now=$(env_get "$second_var")
    echo >&2
    echo "升级中断（${first_label}已完成，${second_label}未完成）：" >&2
    echo "  ${first_label}已完成：${first_var} ${first_old:-（未设置，缺省 latest）} → ${version}" >&2
    # 若第二步升级前 .env 已是目标版本（如上次失败后重跑），无法从 .env 反推更早版本号。
    if [[ $second_old == "$version" ]]; then
      echo "  ${second_label}未完成（见上方提示）；.env 中的 ${second_var} 在本次执行前就已是 ${version}" >&2
    elif [[ $now == "$second_old" ]]; then
      echo "  ${second_label}未变更：.env 中的 ${second_var} 仍为 ${second_old:-（未设置，缺省 latest）}，容器未重启" >&2
    else
      echo "  ${second_label}未完成：${second_var} 已写入 ${now}，但重启或健康检查失败（见上方提示）" >&2
    fi
    echo >&2
    echo "如需整体回滚，请先回滚${second_label}，再回滚${first_label}：" >&2
    if [[ $second_old == "$version" ]]; then
      echo "${second_label}：" >&2
      echo "  1. 把 .env 里的 ${second_var} 改回升级到 ${version} 之前的版本" >&2
      echo "  2. docker compose up -d ${second_up[*]}" >&2
    elif [[ $now == "$second_old" ]]; then
      echo "${second_label}：无需处理（.env 与容器均未变动）" >&2
    else
      echo "${second_label}：" >&2
      restore_steps "$second_var" "$second_old" "${second_up[@]}"
    fi
    echo "${first_label}：" >&2
    restore_steps "$first_var" "$first_old" "${first_up[@]}"
    echo "数据库迁移不会自动回退，已执行的迁移需要另行处理。" >&2
    exit 1
  fi
  echo "两边都已升级到 ${version}"
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
[[ $version =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || usage
stamp_baseline=false
case $target in
  app)
    [[ $# -eq 2 ]] || usage
    ;;
  runtime)
    if [[ $# -eq 3 && $3 == --stamp-baseline ]]; then
      stamp_baseline=true
    elif [[ $# -ne 2 ]]; then
      usage
    fi
    ;;
  all)
    [[ $# -eq 3 && ($3 == --app-first || $3 == --runtime-first) ]] || usage
    ;;
  *)
    usage
    ;;
esac

[[ -f compose.yaml && -f .env ]] || die "当前目录缺少 compose.yaml 或 .env，请在部署目录执行"
[[ -w .env ]] || die "当前账号无法写入 .env"

# 版本号以 .env 为准：shell 里导出的同名变量会盖过 .env，让后面的迁移与重启用错版本。
unset IMAGE_TAG RUNTIME_IMAGE_TAG

if [[ $target == all ]]; then
  if [[ $3 == --app-first ]]; then
    upgrade_all app runtime
  else
    upgrade_all runtime app
  fi
  exit 0
fi

configure "$target"

# compose 里 RUNTIME_IMAGE_TAG 缺省为 latest，.env 不写的话升级应用时拉取会把运行时带到最新，
# 所以准备在切换应用版本前把运行时当前在用的版本写进 .env。
runtime_tag=
if [[ $target == app && -z $(env_get RUNTIME_IMAGE_TAG) ]]; then
  runtime_cid=$(docker compose ps -q runtime)
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
fi

old=$(env_get "$var")
echo "${var}：${old:-（未设置，缺省 latest）} → ${version}"

echo "拉取镜像：${services[*]}"
if ! env "${var}=${version}" docker compose pull "${services[@]}"; then
  die "拉取镜像失败，.env 里的 ${var} 没有改动。请检查版本号 ${version} 是否存在、服务器是否已 docker login"
fi

database_status=$(migration_status) || die "无法核对 ${migration_service} 的数据库版本"
case $database_status in
  current|pending) ;;
  *) die "无法识别 ${migration_service} 的数据库版本检查结果" ;;
esac

if [[ $database_status == current ]]; then
  [[ $stamp_baseline != true ]] || die "运行时已在目标数据库版本，无需打基线标记"
  echo "数据库已在目标版本，直接切换镜像"
elif [[ $target == app ]]; then
  echo "执行后端迁移"
  run_migration_container alembic upgrade head
else
  if [[ $stamp_baseline == true ]]; then
    echo "打运行时迁移基线标记"
    run_migration_container python -m agent_runtime.admin stamp-baseline
  fi
  # 运行时的迁移会按库里已有的数据生成新结构（如对话行）；旧运行时在迁移期间还在跑，这段时间写下的
  # 内容就进不了新结构，所以先停运行时。迁移没完成就退出（失败或被中断）时按原版本重新启动它。
  echo "停止运行时，再执行运行时迁移（迁移期间对话不可用）"
  docker compose stop runtime
  trap restart_old_runtime EXIT
  echo "执行运行时迁移"
  run_migration_container python -m agent_runtime.admin migrate
  trap - EXIT
fi

trap rollback_hint EXIT
if [[ -n $runtime_tag ]]; then
  env_set RUNTIME_IMAGE_TAG "$runtime_tag"
  echo ".env 里没有 RUNTIME_IMAGE_TAG，已按运行时容器当前的版本补上：RUNTIME_IMAGE_TAG=${runtime_tag}"
fi
env_set "$var" "$version"

echo "重启：${up_args[*]}"
docker compose up -d "${up_args[@]}"
if [[ $target == app ]]; then
  wait_healthy server
  wait_healthy render
  wait_running web
else
  wait_healthy runtime
fi

trap - EXIT
echo "升级完成。${var}：${old:-（未设置，缺省 latest）} → ${version}"

# 只清没有标签的悬空镜像；带标签的旧版本保留，回滚时要用。
docker image prune -f
