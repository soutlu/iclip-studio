# 运行时服务镜像：Python 3.13 + uv 按部署包 deploy/runtime-video 的 uv.lock 精确安装运行时与视频插件；
# 不带 ffmpeg，媒体加工在后端做，插件经后端的内部接口要结果。运行时项目本身不依赖插件包，接哪个插件包由
# 运行时配置的 plugins.factory 决定。
FROM python:3.13-slim

COPY --from=ghcr.io/astral-sh/uv:0.11.7 /uv /bin/uv

# 用镜像自带的 Python，不让 uv 再下载一份；字节码预编译换启动速度；不留下载缓存。虚拟环境建在 /app/.venv，
# 不跟着部署包放在源码目录里。
ENV UV_PYTHON_DOWNLOADS=never \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_NO_CACHE=1 \
    UV_PROJECT_ENVIRONMENT=/app/.venv \
    PATH=/app/.venv/bin:$PATH

# 构建上下文是仓库根（见 Dockerfile.dockerignore）。configs/ 不进镜像，由部署挂到 /app/configs。
WORKDIR /app

# 先建运行用户、以它的身份装依赖和拷源码，文件生来就归它所有，不必最后 chown -R 复制出一个大层。
# 三个项目照仓库里的相对位置放在 /src 下：部署包的路径依赖 ../../runtime 与 ../../plugins/video、视频插件的
# ../../runtime 都照原样解析。
RUN useradd --system --uid 1000 --home /app agent-runtime \
    && chown agent-runtime:agent-runtime /app \
    && mkdir /src && chown agent-runtime:agent-runtime /src
USER agent-runtime

# 先装第三方依赖再拷源码，改代码不重装依赖：两个路径依赖这时只有项目文件，装的时候跳过它们。
COPY --chown=agent-runtime:agent-runtime runtime/pyproject.toml /src/runtime/
COPY --chown=agent-runtime:agent-runtime plugins/video/pyproject.toml /src/plugins/video/
COPY --chown=agent-runtime:agent-runtime deploy/runtime-video/pyproject.toml deploy/runtime-video/uv.lock /src/deploy/runtime-video/
RUN uv sync --project /src/deploy/runtime-video --locked --no-dev \
    --no-install-package agent-runtime --no-install-package iclip-video-plugins

COPY --chown=agent-runtime:agent-runtime runtime/src /src/runtime/src
COPY --chown=agent-runtime:agent-runtime plugins/video/src /src/plugins/video/src
RUN uv sync --project /src/deploy/runtime-video --locked --no-dev

EXPOSE 7790

# 默认监听 localhost，容器外访问不到，必须显式 0.0.0.0。只跑 1 个 worker。
CMD ["python", "-m", "agent_runtime.main", "--host", "0.0.0.0", "--port", "7790"]
