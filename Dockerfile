# Use official Node.js LTS image as the build base
FROM node:20-alpine AS base

# set working directory
WORKDIR /usr/src/app

# copy only package manifests first (better cache)
COPY package.json package-lock.json* ./

# install production dependencies
RUN npm ci --only=production --silent || npm install --only=production --silent

# copy app sources
# .dockerignore prevents copying secrets and node_modules
COPY . .

# runtime env: default port
ENV PORT=3000
EXPOSE ${PORT}

# create non-root user and use it
RUN addgroup -S app && adduser -S app -G app
USER app

# container should be started with the runtime env (OPENAI_API_KEY, SUPABASE_*)
CMD ["npm", "start"]
