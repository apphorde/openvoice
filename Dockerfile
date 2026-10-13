FROM ghcr.io/cloud-cli/image-node:latest

WORKDIR /home/app
COPY --chown=1000:1000 package.json package-lock.json ./
COPY --chown=1000:1000 server.js ./
COPY --chown=1000:1000 src ./src
COPY --chown=1000:1000 public ./public
RUN npm ci --cache /tmp/npm-cache --ignore-scripts --no-audit --no-fund && npm run build && npm prune --cache /tmp/npm-cache --omit=dev --ignore-scripts --no-audit --no-fund
RUN node --check server.js

ENV HOST=0.0.0.0 PORT=4173 DATA_FILE=/data/goals.json
EXPOSE 4173

CMD ["npm", "start"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 4173) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
