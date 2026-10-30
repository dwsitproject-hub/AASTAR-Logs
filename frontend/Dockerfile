# Astar ERP frontend: Vite build served by Nginx, which proxies /api and /api/ws
# to the backend on the same origin. Build context: frontend/.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG VITE_GIT_SHA=local
ARG VITE_HUB_SDK_KEY=
ARG VITE_HUB_SDK_URL=
ENV VITE_GIT_SHA=$VITE_GIT_SHA \
    VITE_HUB_SDK_KEY=$VITE_HUB_SDK_KEY \
    VITE_HUB_SDK_URL=$VITE_HUB_SDK_URL
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
