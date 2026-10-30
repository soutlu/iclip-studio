# 运行时服务镜像：Python 3.13 + uv 按 uv.lock 精确安装；不带 ffmpeg，媒体加工不在运行时里做。
FROM python:3.13-slim

COPY --from=ghcr.io/astral-sh/uv:0.11.7 /uv /bin/uv

# 用镜像自带的 Python，不让 uv 再下载一份；字节码预编译换启动速度；不留下载缓存。
ENV UV_PYTHON_DOWNLOADS=never \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_NO_CACHE=1 \
    PATH=/app/.venv/bin:$PATH

# 构建上下文是仓库根（见 Dockerfile.dockerignore）。configs/ 不进镜像，由部署挂到 /app/configs。
WORKDIR /app

# 先建运行用户、以它的身份装依赖和拷源码，文件生来就归它所有，不必最后 chown -R 复制出一个大层。
RUN useradd --system --uid 1000 --home /app agent-runtime \
    && chown agent-runtime:agent-runtime /app
USER agent-runtime

# 先装依赖再拷源码，改代码不重装依赖。
COPY --chown=agent-runtime:agent-runtime runtime/pyproject.toml runtime/uv.lock ./
RUN uv sync --locked --no-dev --no-install-project

COPY --chown=agent-runtime:agent-runtime runtime/src ./src
RUN uv sync --locked --no-dev

EXPOSE 7790

# 默认监听 localhost，容器外访问不到，必须显式 0.0.0.0。只跑 1 个 worker。
CMD ["python", "-m", "agent_runtime.main", "--host", "0.0.0.0", "--port", "7790"]
