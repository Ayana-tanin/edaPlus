FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY web ./web
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY --from=build /app/web/dist ./web/dist
RUN mkdir -p data && chown node:node data
VOLUME /app/data
EXPOSE 3000
USER node
CMD ["node", "server/index.js"]
