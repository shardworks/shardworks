FROM mcr.microsoft.com/devcontainers/base:jammy

# install: yq
RUN wget https://github.com/mikefarah/yq/releases/download/v4.45.1/yq_linux_amd64 -O /usr/local/bin/yq &&\
    chmod +x /usr/local/bin/yq

COPY rootfs/ /
RUN chmod +x /usr/local/bin/*

USER vscode

# install: claude code
RUN curl -fsSL https://claude.ai/install.sh | bash

CMD ["sleep", "infinity"]
