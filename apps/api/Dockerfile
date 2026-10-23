# API image — build from the repository root:
#   docker build -f apps/api/Dockerfile .
# The build context must be the root because npm workspaces need the root
# package.json + package-lock.json to install correctly.

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
RUN npm ci --workspace=apps/api --include-workspace-root

FROM node:24-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/tsconfig.json apps/api/
COPY apps/api/tsconfig.build.json apps/api/
COPY apps/api/src apps/api/src
RUN npm run -w apps/api build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Production dependencies only (no typescript/tsx in the final image).
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
RUN npm ci --workspace=apps/api --omit=dev --ignore-scripts
COPY --from=build /app/apps/api/dist apps/api/dist
# Migrations are read from disk at runtime by the migration CLI.
COPY apps/api/migrations apps/api/migrations

USER node
EXPOSE 3001
CMD ["node", "apps/api/dist/server.js"]
