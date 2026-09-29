# syntax=docker/dockerfile:1.7
# ^ Necesario para los cache mounts (--mount=type=cache). Coolify usa BuildKit por defecto.
#
# Reserva Ecológica Caacupé — build de producción (misma plantilla que neura-sistemas).
# Reemplaza a nixpacks: imagen standalone (node server.js), mucho más liviana en RAM,
# compilada en el build server en lugar del servidor de producción.

# Imagen Debian slim (glibc), NO Alpine: sharp, node-forge, xml-crypto y pg traen o
# enlazan binarios nativos que en musl (Alpine) dan problemas.
ARG NODE_IMAGE=node:22-slim

# ─────────────────────────────────────────────────────────────────────────────
# Stage 1: deps — node_modules en una capa que solo se invalida con el lockfile.
# ─────────────────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2: builder — compila Next con caché incremental persistente entre deploys.
# ─────────────────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

# Variables NEXT_PUBLIC_*: Next las hornea en el bundle del navegador EN EL BUILD, así que
# tienen que llegar como build args (Coolify las pasa si están marcadas "build variable").
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_SUPER_ADMIN_EMAILS
ARG NEXT_PUBLIC_CHAT_LIST_DEBUG
ARG NEXT_PUBLIC_WHATSAPP_LINK_PHONE_NUMBER
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_SUPER_ADMIN_EMAILS=$NEXT_PUBLIC_SUPER_ADMIN_EMAILS
ENV NEXT_PUBLIC_CHAT_LIST_DEBUG=$NEXT_PUBLIC_CHAT_LIST_DEBUG
ENV NEXT_PUBLIC_WHATSAPP_LINK_PHONE_NUMBER=$NEXT_PUBLIC_WHATSAPP_LINK_PHONE_NUMBER

RUN --mount=type=cache,target=/app/.next/cache \
    npm run build

# ─────────────────────────────────────────────────────────────────────────────
# Stage 3: runner — imagen final mínima.
# ─────────────────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# standalone arranca con `node server.js`, que lee estas dos variables.
# Sin HOSTNAME=0.0.0.0 el server escucha en localhost y Coolify/Traefik no llega.
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# curl: lo usa el HEALTHCHECK de Coolify (corre DENTRO del contenedor).
# ca-certificates: con --no-install-recommends curl queda sin certificados raíz y todo
# `curl https://...` (p. ej. scheduled tasks de Coolify) falla con "(77) error setting
# certificate file". Esta app no usa ffmpeg (a diferencia de neura-sistemas).
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs nextjs

# Salida standalone: server.js + el subconjunto de node_modules que Next rastreó
# (incluye sharp, pg y demás nativos usados por el código).
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
# Assets estáticos (JS/CSS con hash): standalone NO los copia solo.
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# public/: la app lo lee en runtime (logo del KUDE, fuentes de los tickets de sorteo).
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 3000

# standalone arranca así, NO con `next start`.
CMD ["node", "server.js"]
