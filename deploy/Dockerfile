FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --registry=https://registry.npmjs.org --ignore-scripts --no-audit --no-fund
COPY tsconfig*.json vite.config.ts ./
COPY request-limits.json ./
COPY native/abilock-lock.c ./native/abilock-lock.c
COPY scripts/build-file-lock.mjs ./scripts/build-file-lock.mjs
COPY src ./src
COPY web ./web
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
RUN npm ci --omit=dev --registry=https://registry.npmjs.org --ignore-scripts --no-audit --no-fund && mkdir /app/data && chown node:node /app/data
COPY --from=build /app/dist ./dist
COPY --from=build /app/native/file-lock ./native/file-lock
COPY request-limits.json ./
COPY docs/providers ./docs/providers
COPY docs/protocols ./docs/protocols
USER node
CMD ["node", "dist/src/start.js"]
