# =============================================================
# Production image — Railway / Fly.io / Render / any container host
# =============================================================
FROM node:22-alpine

EXPOSE 3000
WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./
# The Shopify CLI is a dev-only dependency and is large; drop it here.
RUN npm ci --omit=dev && npm cache clean --force
RUN npm remove @shopify/cli @shopify/app 2>/dev/null || true

COPY . .

RUN npm run build

CMD ["npm", "run", "docker-start"]
