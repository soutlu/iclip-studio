# 后端镜像：Python 3.13 + uv 按 uv.lock 精确安装，带 ffmpeg/ffprobe（镜头素材能力启动时检查它们在 PATH 上）。
FROM python:3.13-slim

COPY --from=ghcr.io/astral-sh/uv:0.11.7 /uv /bin/uv

RUN apt-get update -qq \
    && apt-get install -y -qq --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# 用镜像自带的 Python，不让 uv 再下载一份；字节码预编译换启动速度；不留下载缓存。
ENV UV_PYTHON_DOWNLOADS=never \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_NO_CACHE=1 \
    PATH=/app/.venv/bin:$PATH

# alembic.ini 与 scripts.admin 按相对路径解析，工作目录必须是 server 根；
# configs/、agents/ 不进镜像，由部署把两个目录挂到 /app 下。
WORKDIR /app

# 先建运行用户、以它的身份装依赖和拷源码，文件生来就归它所有。不要在最后 chown -R /app：
# 那会把整个虚拟环境复制成一个新层，每次改代码都要重新上传这个大层。
RUN useradd --system --uid 1000 --home /app iclip && chown iclip:iclip /app
USER iclip

# 先装依赖再拷源码，改代码不重装依赖。
COPY --chown=iclip:iclip pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev --no-install-project

COPY --chown=iclip:iclip alembic.ini ./
COPY --chown=iclip:iclip src ./src
COPY --chown=iclip:iclip migrations ./migrations
COPY --chown=iclip:iclip scripts ./scripts
RUN uv sync --locked --no-dev

EXPOSE 7788

# 默认监听 localhost，容器外访问不到，必须显式 0.0.0.0。
# 实时投影在单个进程内存里，多 worker 会漏实时事件，只跑 1 个。
CMD ["python", "-m", "iclip.main", "--host", "0.0.0.0", "--port", "7788"]
