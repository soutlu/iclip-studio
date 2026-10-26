# 成片渲染服务镜像（iclip-render）。构建上下文为仓库根：要用 web/ 的成片合成构建与后端合同的
# zod 生成物。镜像里不带组件库：部署时把组件库目录挂到 RENDER_REGISTRY_ROOT（见 deploy/compose.yaml）。
#
#   docker build --platform linux/amd64 -f render/Dockerfile -t iclip-render .
#
# 只出 linux/amd64：渲染用的 chrome-headless-shell（Chrome for Testing）没有 Linux arm64 版本。
# 运行环境照 HyperFrames 自己的渲染镜像（packages/gcp-cloud-run/Dockerfile）：同一组系统库、
# 固定版本的 ffmpeg 静态构建；Chrome 用 HyperFrames 0.8.168 命令行固定的版本。

ARG NODE_IMAGE=node:22.23.3-bookworm-slim

# ---------------------------------------------------------------- 打包
FROM ${NODE_IMAGE} AS bundle
# 本机网络到 npm 官方源慢时可换镜像源：--build-arg NPM_CONFIG_REGISTRY=https://registry.npmmirror.com
ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org/
ENV NPM_CONFIG_REGISTRY=$NPM_CONFIG_REGISTRY \
    PNPM_CONFIG_REGISTRY=$NPM_CONFIG_REGISTRY
WORKDIR /app/render
COPY render/package.json render/pnpm-lock.yaml render/pnpm-workspace.yaml render/.npmrc ./
RUN npm install -g "pnpm@$(node -p "require('./package.json').packageManager.split('@')[1]")" \
    && pnpm install --frozen-lockfile
COPY render/ ./
COPY web/src/features/storyboard/whole-film/ /app/web/src/features/storyboard/whole-film/
COPY web/src/shared/api/generated/ /app/web/src/shared/api/generated/
RUN pnpm build && pnpm prune --prod

# ---------------------------------------------------------------- 运行
FROM ${NODE_IMAGE} AS runtime

# Chrome 依赖的系统库与字体；fonts-noto-cjk 给没有中文字形的字体兜底（组件目录里的字体，中文另由组件库的 Noto Sans SC 补上）。
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    unzip \
    xz-utils \
    libgbm1 \
    libegl1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libcups2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libxshmfence1 \
    libgtk-3-0 \
    fonts-liberation \
    fonts-noto-color-emoji \
    fonts-noto-cjk \
    fonts-noto-core \
    fontconfig \
    && rm -rf /var/lib/apt/lists/* \
    && fc-cache -f

# ffmpeg / ffprobe：与 HyperFrames 渲染镜像同一份静态构建（BtbN n8.0.1），核对 sha256。
ARG FFMPEG_RELEASE=https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-02-28-12-59
ARG FFMPEG_BUILD=ffmpeg-n8.0.1-66-g27b8d1a017
ARG FFMPEG_SHA256=26d2ecd0cefba99f9d1ea92252a3a4f743a58df4c1c3cf9f8bbaaa40b1fca5b0
RUN curl -fsSL -o /tmp/ffmpeg.tar.xz "$FFMPEG_RELEASE/$FFMPEG_BUILD-linux64-gpl-8.0.tar.xz" \
    && echo "$FFMPEG_SHA256  /tmp/ffmpeg.tar.xz" | sha256sum -c - \
    && tar -xJf /tmp/ffmpeg.tar.xz -C /usr/local/bin --strip-components=2 --wildcards '*/bin/ffmpeg' '*/bin/ffprobe' \
    && rm /tmp/ffmpeg.tar.xz \
    && ffmpeg -version | head -n1

# chrome-headless-shell：HyperFrames 0.8.168 命令行（packages/cli/src/browser/manager.ts）固定的版本。
ARG CHROME_HEADLESS_SHELL=152.0.7977.30
RUN npx --yes @puppeteer/browsers install "chrome-headless-shell@$CHROME_HEADLESS_SHELL" --path /opt/puppeteer \
    && CHS="$(find /opt/puppeteer/chrome-headless-shell -name chrome-headless-shell -type f | head -n1)" \
    && mkdir -p /opt/chrome \
    && ln -s "$CHS" /opt/chrome/chrome-headless-shell \
    && /opt/chrome/chrome-headless-shell --version

ENV PRODUCER_HEADLESS_SHELL_PATH=/opt/chrome/chrome-headless-shell \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    CONTAINER=true \
    NODE_ENV=production \
    PORT=8080 \
    RENDER_REGISTRY_ROOT=/app/registry \
    RENDER_WORK_DIR=/tmp/iclip-render/work

WORKDIR /app
COPY --from=bundle /app/render/package.json ./
COPY --from=bundle /app/render/node_modules ./node_modules
COPY --from=bundle /app/render/dist ./dist

# 卷挂载在父目录，启动与退出时清理 work 子目录，不删除挂载点。
RUN mkdir -p /tmp/iclip-render && chown node:node /tmp/iclip-render
USER node
EXPOSE 8080
CMD ["node", "--enable-source-maps", "dist/main.js"]
