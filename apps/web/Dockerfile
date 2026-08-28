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
# Vite inlines VITE_* vars into the static bundle at build time, not read
# from the container at runtime — Section 12B.4's error tracking (a
# no-op if unset, see src/lib/error-tracking.ts) has to be supplied here,
# via --build-arg (docker-compose.yml passes these through from .env).
ARG VITE_SENTRY_DSN=
ARG VITE_RELEASE_VERSION=dev
ENV VITE_SENTRY_DSN=$VITE_SENTRY_DSN
ENV VITE_RELEASE_VERSION=$VITE_RELEASE_VERSION
RUN npm run build --workspace apps/web

FROM nginx:1.27-alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
