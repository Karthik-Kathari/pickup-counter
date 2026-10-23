# Web image — build from the repository root:
#   docker build -f apps/web/Dockerfile .
# The build context must be the root so npm workspaces resolve the same way
# as on the host (root package.json + lockfile).

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
RUN npm ci --workspace=apps/web --include-workspace-root
COPY tsconfig.base.json ./
COPY apps/web apps/web
# `npm run -w apps/web build` = tsc --noEmit && vite build. The bundle calls
# the API with relative URLs only, so no API origin is baked in here.
RUN npm run -w apps/web build

FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
