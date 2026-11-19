FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000

RUN addgroup -S iln && adduser -S iln -G iln

COPY --from=build --chown=iln:iln /app/node_modules ./node_modules
COPY --from=build --chown=iln:iln /app/dist ./dist
COPY --from=build --chown=iln:iln /app/package.json ./package.json

USER iln
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:3000/health || exit 1

CMD ["node", "dist/index.js"]
