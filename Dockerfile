# ---------- build stage ----------
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
COPY migrations/ migrations/
RUN npm run typecheck

# ---------- runtime stage ----------
FROM node:22-slim
RUN groupadd --system app && useradd --system --gid app app
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/src/ src/
COPY --from=build /app/tsconfig.json ./
COPY migrations/ migrations/

USER app
EXPOSE 3000

# Select the process via CMD: "web", "worker", or "migrate".
ENTRYPOINT ["npx", "tsx"]
CMD ["src/web/main.ts"]
