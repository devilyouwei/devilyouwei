# syntax = docker/dockerfile:1

# Adjust NODE_VERSION as desired
ARG NODE_VERSION=18.20.3
FROM node:${NODE_VERSION}-slim as base

LABEL fly_launch_runtime="Node.js"

# Node.js app lives here
WORKDIR /app

# Set production environment
ENV NODE_ENV="production"
ARG YARN_VERSION=1.22.22
RUN npm install -g yarn@$YARN_VERSION --force

# Install node modules
COPY --link package.json yarn.lock ./
RUN yarn install --frozen-lockfile

# Copy application code
COPY --link . .


# Final stage for app image
FROM base

# Start the server by default, this can be overwritten at runtime
EXPOSE 3000
CMD [ "yarn", "run", "dev" ]
