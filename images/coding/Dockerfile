FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5

ARG BEAM_IMAGE_VERSION=dev

LABEL org.opencontainers.image.source="https://github.com/bipa-app/beam"
LABEL org.opencontainers.image.description="Credential-free coding sandbox for Beam"
LABEL org.opencontainers.image.version="${BEAM_IMAGE_VERSION}"

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends \
    ca-certificates \
    curl \
    git \
    openssh-client \
    openssh-server \
    rsync \
    sudo \
    unzip \
  && rm -rf /var/lib/apt/lists/* \
  && groupmod --new-name user node \
  && usermod --login user --home /home/user --move-home node \
  && printf 'user ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/beam-user \
  && chmod 0440 /etc/sudoers.d/beam-user

RUN curl --fail --silent --show-error --location \
    --output /tmp/bun.zip \
    https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-linux-x64-baseline.zip \
  && echo "a063908ae08b7852ca10939bbdc6ceed3ddabce8fb9402dce83d65d73b36e6c7  /tmp/bun.zip" \
    | sha256sum --check \
  && unzip -q /tmp/bun.zip -d /tmp/bun \
  && install -m 0755 /tmp/bun/bun-linux-x64-baseline/bun /usr/local/bin/bun \
  && ln -s /usr/local/bin/bun /usr/local/bin/bunx \
  && rm -rf /tmp/bun /tmp/bun.zip

RUN curl --fail --silent --show-error --location \
    --output /tmp/herdr \
    https://github.com/herdrdev/herdr/releases/download/v0.8.0/herdr-linux-x86_64 \
  && echo "b872ea7e40fa2cb17e857ac9b62b1bf26db7b403c622f5d2f3f5b35f6e9acd28  /tmp/herdr" \
    | sha256sum --check \
  && install -m 0755 /tmp/herdr /usr/local/bin/herdr \
  && rm -f /tmp/herdr

RUN npm install --global \
    @anthropic-ai/claude-code@2.1.251 \
    @earendil-works/pi-coding-agent@0.84.4 \
    @oh-my-pi/pi-coding-agent@18.0.11 \
    @openai/codex@0.151.0 \
  && npm cache clean --force

COPY images/coding/beam-sandbox-start /usr/local/bin/beam-sandbox-start

RUN chmod 0755 /usr/local/bin/beam-sandbox-start \
  && printf '%s\n' "$BEAM_IMAGE_VERSION" > /etc/beam-coding-image \
  && mkdir -p /workspace /run/sshd \
  && chown user:user /workspace

WORKDIR /workspace
CMD ["/bin/bash"]
