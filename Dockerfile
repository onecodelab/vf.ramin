# Builder stage: install dev deps and build
FROM node:20 AS builder
WORKDIR /app
RUN npm install -g pnpm
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm prisma generate
RUN pnpm build

# Runtime stage: only production deps
FROM node:20 AS runner
WORKDIR /app
RUN npm install -g pnpm
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma
RUN pnpm install --prod --frozen-lockfile
COPY dist ./dist
COPY eng.traineddata ./eng.traineddata
EXPOSE 3001
CMD ["node", "dist/index.js"]
