# Deterministic build for the GridZone game server.
#
# Why a Dockerfile rather than relying on a PaaS buildpack: Railway's and
# Render's auto-detection runs a single `npm install` at the repo root and then
# `npm start`, and neither reliably performs a nested install for server/ nor
# honours a root-directory setting for both the build and the start phase. That
# produced ERR_MODULE_NOT_FOUND for express no matter which combination of
# root-directory / build-command / start-command / postinstall hook was used.
# Declaring the build explicitly removes the guesswork entirely.
FROM node:20-slim

WORKDIR /app

# Copy only the manifests first so a dependency layer can be cached and is not
# invalidated by every source edit.
COPY server/package.json server/package-lock.json ./server/

# `npm ci` rather than `npm install`: it installs exactly the lockfile contents
# and fails loudly on a mismatch, which is what you want in a deploy.
RUN cd server && npm ci --omit=dev

# The server reads contracts/deployments/<chainId>.json as a fallback when
# ARENA_ADDRESS / USDC_ADDRESS are not set, so that directory has to exist.
COPY contracts/deployments ./contracts/deployments
COPY server ./server

WORKDIR /app/server

# Railway and Render both inject PORT; the server already honours it
# (config.js: Number(process.env.PORT ?? 3001)).
EXPOSE 3001

CMD ["node", "src/index.js"]
