# ogygiaBench — hermetic image (Node + Chromium via Playwright + pnpm + bun)
FROM mcr.microsoft.com/playwright:v1.52.0-jammy

ENV PNPM_HOME=/usr/local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN apt-get update && apt-get install -y --no-install-recommends unzip curl ca-certificates \
	&& rm -rf /var/lib/apt/lists/* \
	&& corepack enable && corepack prepare pnpm@10.15.1 --activate \
	&& curl -fsSL https://bun.sh/install | bash \
	&& ln -sf /root/.bun/bin/bun /usr/local/bin/bun \
	&& ln -sf /root/.bun/bin/bunx /usr/local/bin/bunx

WORKDIR /repo

COPY packages/ogygia /repo/packages/ogygia
COPY package.json pnpm-workspace.yaml /repo/
COPY bench /repo/bench

WORKDIR /repo/bench

# Point CHROME_PATH at Playwright's bundled Chromium.
RUN CHROME_BIN="$(ls -d /ms-playwright/chromium-*/chrome-linux/chrome 2>/dev/null | head -1)" \
	&& test -n "$CHROME_BIN" \
	&& ln -sf "$CHROME_BIN" /usr/local/bin/chrome

ENV CHROME_PATH=/usr/local/bin/chrome
# The harness is TypeScript; the image ships Node 22.14 (type-stripping is default only at 22.18+),
# so enable it explicitly. Harmless on .js/.mjs. CI=1 keeps pnpm non-interactive.
ENV NODE_OPTIONS=--experimental-strip-types
ENV CI=1

RUN pnpm install --ignore-workspace --no-lockfile --config.confirmModulesPurge=false

COPY bench/docker-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

CMD ["/entrypoint.sh"]
