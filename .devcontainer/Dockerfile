# Linux-canonical dev environment for burrow.
#
# bwrap is the canonical sandbox primitive on Linux (SPEC §8.1, mx-52752e).
# macOS dev hosts run sandbox-exec, but the deploy target is Linux + bwrap —
# so this image lets a macOS contributor exercise the same bwrap path their
# CI and production runs hit.
#
# See ../README.md for the four `docker run` security flags this image needs
# at launch time and why each one is load-bearing for nested userns.

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# bubblewrap: the sandbox primitive. git/build-essential/ca-certificates/curl/
# unzip: needed to install bun, pull the project, and build native deps.
# uidmap: required for `bwrap --unshare-user` to map subuids inside the
# container's user namespace.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		bubblewrap \
		ca-certificates \
		build-essential \
		curl \
		git \
		gnupg \
		uidmap \
		unzip \
	&& rm -rf /var/lib/apt/lists/*

# Node 20 LTS via NodeSource. burrow.toml's [toolchain] declares node = ">=20",
# so `bw doctor` / `bw up` fail inside the container without it. Ubuntu 24.04
# ships Node 18 by default, so the NodeSource setup script is the simplest
# pinned-LTS path that matches the bun toolchain pin's spirit.
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
	&& apt-get install -y --no-install-recommends nodejs \
	&& rm -rf /var/lib/apt/lists/*

# Non-root dev user. UID/GID 1000 matches the default macOS/Linux host user
# so bind-mounted /workspace files keep sane ownership. Ubuntu 24.04 ships
# a stock `ubuntu` user at 1000:1000, so drop it first before claiming the id.
ARG USERNAME=dev
ARG USER_UID=1000
ARG USER_GID=1000
RUN if id -u ubuntu >/dev/null 2>&1; then userdel --remove ubuntu; fi \
	&& groupadd --gid ${USER_GID} ${USERNAME} \
	&& useradd --uid ${USER_UID} --gid ${USER_GID} --create-home --shell /bin/bash ${USERNAME}

USER ${USERNAME}
ENV HOME=/home/${USERNAME}
ENV BUN_INSTALL=${HOME}/.bun
ENV PATH=${BUN_INSTALL}/bin:${PATH}

# Bun is the runtime + package manager (per CLAUDE.md). Pinned `latest` here;
# version drift between contributors is fine because CI runs the same setup.
RUN curl -fsSL https://bun.sh/install | bash

# Claude Code CLI, baked into the image so `claude` is on PATH the moment the
# container starts. Auth happens on first run (`claude` walks the user through).
RUN bun install -g @anthropic-ai/claude-code

# Mulch + Seeds CLIs. CLAUDE.md mandates `ml prime` / `sd prime` at session
# start and `sd close` / `sd sync` at session end, so the canonical dev
# environment must ship them. Versions pinned to the ones CLAUDE.md references
# for reproducible images.
RUN bun install -g @os-eco/mulch-cli@0.8.0 @os-eco/seeds-cli@0.4.0

WORKDIR /workspace

# Sanity-check on image build that bwrap is wired correctly *inside* the
# image. (This does NOT prove the runtime flags are right — that requires
# the four `docker run` security flags documented in compose.yml.)
RUN bwrap --version

CMD ["sleep", "infinity"]
