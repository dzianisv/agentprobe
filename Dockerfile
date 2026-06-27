FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    python3.11 python3-pip \
    adb \
    xvfb xdotool scrot \
    chromium-browser \
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
