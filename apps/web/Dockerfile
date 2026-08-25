# Build context is the repo root (needed for npm workspaces), same as
# apps/api/Dockerfile.

FROM node:20-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json* ./
COPY apps/web/package.json apps/web/package.json
COPY packages/theme/package.json packages/theme/package.json
RUN npm ci --workspace apps/web --workspace packages/theme --include-workspace-root
COPY tsconfig.base.json ./
COPY packages/theme ./packages/theme
COPY apps/web ./apps/web
RUN npm run build --workspace apps/web

FROM nginx:1.27-alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
