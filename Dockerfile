# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts index.html ./
COPY server ./server
COPY shared ./shared
COPY web ./web
COPY tests ./tests
RUN npm run build \
    && ./node_modules/.bin/tsc --noEmit false --allowImportingTsExtensions false \
       --module NodeNext --moduleResolution NodeNext --target ES2022 \
       --esModuleInterop --skipLibCheck --rootDir . --outDir runtime \
       server/*.ts shared/*.ts

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001 \
    DATA_FILE=/app/data/cloudmedia.json
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force \
    && mkdir -p /app/data \
    && chown -R node:node /app/data
COPY --from=build /app/dist ./dist
COPY --from=build /app/runtime ./runtime
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "runtime/server/index.js"]
