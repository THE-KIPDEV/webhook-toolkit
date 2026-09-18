# Runs the stdio MCP server (used by MCP directories to introspect the tools).
FROM node:22-alpine
WORKDIR /app
COPY package*.json tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm ci --ignore-scripts && npm run build && npm prune --omit=dev
ENV NODE_ENV=production
ENTRYPOINT ["node", "dist/cli/index.js", "mcp"]
