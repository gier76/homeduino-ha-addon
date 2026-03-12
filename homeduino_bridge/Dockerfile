# CACHE BUST: 2026-03-12-21-00-FINAL-TRY
FROM alpine:3.19

# Set working directory
WORKDIR /app

# Install nodejs, npm and build dependencies
RUN apk add --no-cache \
    nodejs \
    npm \
    python3 \
    make \
    g++ \
    udev \
    git \
    linux-headers

# Copy package files
COPY package.json .

# Install node dependencies
RUN npm install --production --ignore-scripts --unsafe-perm

# Surgical serialport fix
RUN rm -rf node_modules/homeduino/node_modules/serialport \
    && npm install serialport@latest --production --unsafe-perm

# Copy all files
COPY . .

# Ensure run.sh is executable
RUN chmod a+x run.sh

# Expose port for ingress
EXPOSE 8080

# Run bridge
CMD [ "node", "index.js" ]
