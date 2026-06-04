# Node 22 is required for the built-in node:sqlite module the backend uses.
FROM node:22-slim

WORKDIR /app

# pnpm via corepack (matches the "packageManager" field in package.json)
RUN corepack enable

# Install deps first (better layer caching)
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# App source + build the Gantt bundle into dist/
COPY . .
RUN pnpm run build

# Drop dev dependencies (vite etc.) now that the build is done
RUN pnpm prune --prod

ENV NODE_ENV=production
# Database lives here — mount a Railway Volume at /data to persist it.
ENV DATA_DIR=/data

# Railway provides $PORT at runtime; the server reads it (defaults to 3000).
EXPOSE 3000
CMD ["node", "server/index.js"]
