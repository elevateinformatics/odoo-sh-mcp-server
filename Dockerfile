# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
RUN apk add --no-cache openssh-client tini
WORKDIR /app
ENV NODE_ENV=production \
    ODOO_SH_SSH_KEY_PATH=/keys/id \
    ODOO_SH_SSH_KNOWN_HOSTS=/home/node/.ssh/known_hosts \
    ODOO_SH_READ_ONLY=true
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 755 /usr/local/bin/entrypoint.sh && mkdir -p /home/node/.ssh && chown -R node:node /home/node/.ssh && chmod 700 /home/node/.ssh
USER node
LABEL org.opencontainers.image.source="https://github.com/elevateinformatics/odoo-sh-mcp-server" \
      org.opencontainers.image.description="MCP server for Odoo.sh over SSH (stdio)" \
      org.opencontainers.image.licenses="MIT"
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
