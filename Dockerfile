FROM node:20-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY openapi.yaml ./openapi.yaml
RUN npm run build

FROM build AS test
COPY jest.config.js ./
COPY tests ./tests
RUN npm test
CMD ["npm", "test"]

FROM build AS production-deps
RUN npm prune --omit=dev

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN mkdir -p /app/data && chown node:node /app/data
COPY --from=production-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/openapi.yaml ./openapi.yaml
EXPOSE 3000
USER node
CMD ["node", "dist/src/server.js"]
