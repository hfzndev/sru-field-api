# syntax=docker/dockerfile:1
#
# Multi-stage build for sru-field-api (doc 09 §1).
#
# Two things here exist because of past pain on SRU APP, and removing either
# breaks the deploy in a way that is not obvious from the logs:
#
#   git in the builder — scripts/version.js shells out to `git describe`. No
#   git, no version.json, and the running image cannot say what it is.
#
#   build tools for better-sqlite3 — it is a native module. Without python3,
#   make and g++ the install either fails outright or silently falls back, and
#   the container starts and then dies on its first query.

# ---------------------------------------------------------------- deps stage
FROM node:22-alpine AS deps
WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci

# --------------------------------------------------------------- build stage
FROM node:22-alpine AS builder
WORKDIR /app

# git is required by scripts/version.js, which runs as part of `npm run build`.
RUN apk add --no-cache git python3 make g++

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Never set SKIP_GIT_TAG here. It is exactly the switch that produces an empty
# version.json and a deploy nobody can identify afterwards.
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# Fail the build rather than ship an image that cannot report its own version.
RUN node -e "const v=require('./public/version.json'); if(!v.version||v.commit==='nogit'){console.error('version.json is empty or has no git metadata:',JSON.stringify(v));process.exit(1)} console.log('built version',v.version,v.commit)"

# ---------------------------------------------------------------- run stage
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Runs unprivileged. The image writes nothing outside /app/data, which is a
# mounted volume owned by this user.
RUN addgroup -g 1001 -S nodejs && adduser -u 1001 -S nextjs -G nodejs

# `output: standalone` emits a self-contained server plus only the node_modules
# it actually traced, which is why this stage needs no npm install.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# The first-time seed runs here via `docker exec` (doc 09 §3), and it is the one
# thing in this image that is not the Next server. Standalone output compiles
# the route handlers and keeps only what they load at runtime — of lib/ that is
# a single file — so the seed scripts and their source imports have to be copied
# explicitly. Without these three lines the documented seed fails on a brand new
# deploy, at the exact moment there is no admin account to log in and fix it.
#
# Verify after changing anything here (see docs/VPS-SETUP.md step 9):
#   docker run --rm -v <vol>:/app/data -e ... <image> node scripts/seed-admin.js
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts
COPY --from=builder --chown=nextjs:nodejs /app/lib ./lib

# bcryptjs is bundled into the compiled server, so tracing leaves no copy in
# node_modules for lib/auth.js to import. Pure JS, so it is safe to take from
# the deps stage as-is — unlike better-sqlite3, which is native and is already
# present because Next cannot bundle it (see serverExternalPackages).
COPY --from=deps --chown=nextjs:nodejs /app/node_modules/bcryptjs ./node_modules/bcryptjs

# Created up front so the container still starts when the host volume is a bare
# empty directory.
RUN mkdir -p /app/data/uploads /app/data/apk && chown -R nextjs:nodejs /app/data

USER nextjs
EXPOSE 3000
VOLUME ["/app/data"]

HEALTHCHECK --interval=60s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
