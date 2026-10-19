FROM oven/bun:1.1-alpine

WORKDIR /app

COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile || bun install

COPY tsconfig.json mikro-orm.config.ts ./
COPY src ./src

EXPOSE 3000

CMD ["sh", "-c", "bun run migration:up && bun run start"]

