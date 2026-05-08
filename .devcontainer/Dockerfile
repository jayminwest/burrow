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
		uidmap \
		unzip \
	&& rm -rf /var/lib/apt/lists/*

# Non-root dev user. UID/GID 1000 matches the default macOS/Linux host user
# so bind-mounted /workspace files keep sane ownership.
ARG USERNAME=dev
ARG USER_UID=1000
ARG USER_GID=1000
RUN groupadd --gid ${USER_GID} ${USERNAME} \
	&& useradd --uid ${USER_UID} --gid ${USER_GID} --create-home --shell /bin/bash ${USERNAME}

USER ${USERNAME}
ENV HOME=/home/${USERNAME}
ENV BUN_INSTALL=${HOME}/.bun
ENV PATH=${BUN_INSTALL}/bin:${PATH}

# Bun is the runtime + package manager (per CLAUDE.md). Pinned `latest` here;
# version drift between contributors is fine because CI runs the same setup.
RUN curl -fsSL https://bun.sh/install | bash

WORKDIR /workspace

# Sanity-check on image build that bwrap is wired correctly *inside* the
# image. (This does NOT prove the runtime flags are right — that requires
# the four `docker run` security flags documented in compose.yml.)
RUN bwrap --version

CMD ["sleep", "infinity"]
