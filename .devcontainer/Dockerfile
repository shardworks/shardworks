FROM mcr.microsoft.com/devcontainers/base:jammy

# install: yq
RUN wget https://github.com/mikefarah/yq/releases/download/v4.45.1/yq_linux_amd64 -O /usr/local/bin/yq &&\
    chmod +x /usr/local/bin/yq

# install: dolt CLI
RUN curl -fsSL https://github.com/dolthub/dolt/releases/latest/download/install.sh | bash

# install: mysql client (for post-create init and operator ad-hoc queries)
RUN apt-get update && apt-get install -y default-mysql-client && rm -rf /var/lib/apt/lists/*

COPY rootfs/ /
RUN find /usr/local/bin -type f -exec chmod +x {} \;

USER vscode

# install: claude code
RUN curl -fsSL https://claude.ai/install.sh | bash

CMD ["sleep", "infinity"]
