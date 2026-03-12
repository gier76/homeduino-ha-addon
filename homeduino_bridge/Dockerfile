ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base:latest
FROM $BUILD_FROM

# Set working directory
WORKDIR /app

# Install nodejs, npm and build dependencies
# Cache break: 2026-03-12-19-45
RUN apk add --no-cache \
    nodejs \
    npm \
    python3 \
    make \
    g++ \
    udev \
    git

# Verify
RUN node --version && npm --version

# Copy package files
COPY package.json .

# Install node dependencies
RUN npm install --production

# Copy all files
COPY . .

# Ensure run.sh is executable
RUN chmod a+x run.sh

# Expose port for ingress
EXPOSE 8080

# Run bridge
CMD [ "./run.sh" ]
