# Portfolio Status Dashboard — Railway/Docker build.
FROM node:22-slim

WORKDIR /app

# Install only production deps first for better layer caching.
COPY package.json ./
RUN npm install --omit=dev

# App source.
COPY . .

ENV NODE_ENV=production
# Railway provides PORT at runtime; default to 3000 for local docker runs.
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
