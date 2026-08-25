# Build context is the repo root (needed for npm workspaces).
# docker compose build api  -> context: ., dockerfile: apps/api/Dockerfile

FROM node:20-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/package.json
RUN npm ci --workspace apps/api --include-workspace-root
COPY tsconfig.base.json ./
COPY apps/api ./apps/api
RUN npm run build --workspace apps/api

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /repo
COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/package.json
RUN npm ci --workspace apps/api --include-workspace-root --omit=dev
COPY --from=build /repo/apps/api/dist ./apps/api/dist
COPY apps/api/migrations ./apps/api/migrations
EXPOSE 3000
USER node
CMD ["node", "apps/api/dist/index.js"]
