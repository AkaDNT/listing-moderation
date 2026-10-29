FROM node:22-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build
COPY tsconfig.json ./
COPY src ./src
COPY tests ./tests
COPY scripts ./scripts
COPY openapi.yaml ./openapi.yaml
COPY compose.yaml ./compose.yaml
COPY seed ./seed
COPY migrations ./migrations
COPY ops ./ops
RUN npm run build

FROM build AS test
CMD ["npm", "test"]

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist/src ./dist/src
COPY --from=build /app/seed ./seed
COPY --from=build /app/migrations ./migrations
EXPOSE 8080
CMD ["node", "dist/src/api.js"]
