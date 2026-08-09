#!/usr/bin/env bash
# beam-sandbox bootstrap (GCE startup script). Runs as root at boot.
# System-level dependencies only — harnesses and auth are per-user by design
# (credentials never travel; each user installs and logs in as themselves).
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y tmux rsync git curl unzip build-essential pkg-config

# Docker (optional — remove if the projects you beam never need it).
# NOTE: docker-group membership is root-equivalent on this VM; an admin adds
# users explicitly: sudo usermod -aG docker <oslogin-user>
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
fi
