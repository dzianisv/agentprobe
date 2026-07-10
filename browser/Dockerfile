FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    xdotool \
    scrot \
    xterm \
    ffmpeg \
    unzip \
    curl \
    jq \
    ca-certificates \
    gnupg \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Use Chrome For Testing (CFT) instead of Chrome Stable. Chrome 142+ removed
# the --load-extension flag in branded Chrome; the workaround
# --disable-features=DisableLoadExtensionCommandLineSwitch was also removed.
# CFT preserves --load-extension and is the supported testing build.
# See: https://groups.google.com/a/chromium.org/g/chromium-extensions/c/1-g8EFx2BBY
RUN CFT_VERSION="$(curl -fsSL https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json | jq -r .channels.Stable.version)" \
    && echo "Installing Chrome For Testing ${CFT_VERSION}" \
    && curl -fsSL "https://storage.googleapis.com/chrome-for-testing-public/${CFT_VERSION}/linux64/chrome-linux64.zip" -o /tmp/cft.zip \
    && unzip -q /tmp/cft.zip -d /opt \
    && rm /tmp/cft.zip \
    && ln -s /opt/chrome-linux64/chrome /usr/local/bin/google-chrome \
    && google-chrome --version

RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && corepack enable \
    && corepack prepare pnpm@latest --activate \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash \
    && ln -s /root/.bun/bin/bun /usr/local/bin/bun

WORKDIR /app
COPY package.json /app/package.json
RUN bun install --frozen-lockfile 2>/dev/null || bun install
COPY runner.ts /app/runner.ts
COPY cases /app/cases
COPY setup-chrome-profile.sh /app/setup-chrome-profile.sh
RUN chmod +x /app/setup-chrome-profile.sh
ENV DISPLAY=:99

ENTRYPOINT ["bash", "-lc", "\
  Xvfb :99 -screen 0 1920x1080x24 &\
  sleep 1;\
  if [ -f /app/extension.zip ]; then\
    mkdir -p /app/extension && unzip -qo /app/extension.zip -d /app/extension;\
  fi;\
  exec bun /app/runner.ts \"$@\"\
  ", "entrypoint"]
