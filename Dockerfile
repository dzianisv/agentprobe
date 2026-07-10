FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Add Google Chrome repository
RUN apt-get update && apt-get install -y gnupg curl ca-certificates \
    && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
    && rm -rf /var/lib/apt/lists/*

RUN apt-get update && apt-get install -y \
    python3.11 python3-pip \
    adb \
    xvfb xdotool scrot xterm \
    google-chrome-stable \
    ffmpeg \
    curl unzip \
    && rm -rf /var/lib/apt/lists/*

# Install bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"

WORKDIR /agentprobe
COPY . .

RUN pip3 install -e .
RUN cd browser && bun install

ENTRYPOINT ["agentprobe"]
