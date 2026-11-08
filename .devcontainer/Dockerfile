FROM debian:trixie-slim

ARG TZ
ENV TZ="$TZ"

ARG WS

ARG USERNAME=vscode
ARG USER_UID=1000
ARG USER_GID=$USER_UID

RUN apt-get update \
    && export DEBIAN_FRONTEND=noninteractive \
    && apt-get -y install --no-install-recommends \
    openssh-client git tig bash-completion locales \
    python3 python3-pip python3-kconfiglib \
    git-delta ripgrep libusb-1.0-0 \
    xz-utils ca-certificates \
    curl \
    gh \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Node.js 22 (Vite 8 / rolldown need >=20.19 or >=22.12; Debian trixie ships 20.x)
ARG NODE_VERSION=22.12.0
RUN set -eux; \
    case "$(uname -m)" in \
      x86_64)  NODE_ARCH=x64;   NODE_SHA=22982235e1b71fa8850f82edd09cdae7e3f32df1764a9ec298c72d25ef2c164f ;; \
      aarch64) NODE_ARCH=arm64; NODE_SHA=8cfd5a8b9afae5a2e0bd86b0148ca31d2589c0ea669c2d0b11c132e35d90ed68 ;; \
      *) echo "unsupported architecture $(uname -m)" >&2; exit 1 ;; \
    esac; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"; \
    echo "${NODE_SHA}  node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" | sha256sum -c -; \
    tar -xJf "node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" -C /usr/local --strip-components=1 --no-same-owner; \
    rm "node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"; \
    node --version && npm --version

# Uncomment en_US.UTF-8 for inclusion in generation
RUN sed -i 's/^# *\(en_US.UTF-8\)/\1/' /etc/locale.gen

RUN locale-gen
RUN dpkg-reconfigure locales

RUN groupadd --gid $USER_GID $USERNAME \
    && useradd -s /bin/bash --uid $USER_UID --gid $USER_GID -m $USERNAME

# Create workspace and config directories and set permissions
RUN mkdir -p /home/$USERNAME/.claude && \
  chown -R $USERNAME:$USERNAME /home/$USERNAME/.claude

# GitHub CLI config dir (mounted as a volume, so it must exist with the right owner)
RUN mkdir -p /home/$USERNAME/.config/gh && \
  chown -R $USERNAME:$USERNAME /home/$USERNAME/.config

# Ensure default user has access to /usr/local/share
RUN mkdir -p /usr/local/share/npm-global && \
  chown -R $USERNAME:$USERNAME /usr/local/share

# Create workspace and set permissions
RUN mkdir -p /$WS && \
  chown -R $USERNAME:$USERNAME /$WS

WORKDIR /$WS

# Set up non-root user
USER $USERNAME

# Configure git branch in PS1 prompt
RUN echo 'parse_git_branch() {' >> ~/.bashrc && \
    echo '  git branch 2> /dev/null | sed -e "/^[^*]/d" -e "s/* \(.*\)/(\\1)/"' >> ~/.bashrc && \
    echo '}' >> ~/.bashrc && \
    echo "export PS1='\[\033[01;32m\]\u@\h\[\033[00m\]:\[\033[01;34m\]\w\[\033[00m\] \[\e[91m\]\$(parse_git_branch)\[\e[00m\]\$ '" >> ~/.bashrc

# Install Claude
RUN curl -fsSL https://claude.ai/install.sh | bash
