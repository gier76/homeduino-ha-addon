ARG BUILD_FROM
FROM $BUILD_FROM

# Set working directory
WORKDIR /app

# CACHE BUST: 2026-03-12-21-25-FORCED-REBUILD
# Manually install EVERYTHING since the base image is unreliable
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

# Install node dependencies without running scripts (prevents building old serialport)
RUN npm install --production --ignore-scripts --unsafe-perm

# Surgically remove any nested serialport folders to be 100% sure
RUN find node_modules -name "serialport" -type d -exec rm -rf {} +

# Now install the LATEST serialport at the root and allow IT to build
RUN npm install serialport@latest --production --unsafe-perm

# Copy all files
COPY . .

# Ensure run.sh is executable
RUN chmod a+x run.sh

# Expose port for ingress
EXPOSE 8080

# Run bridge
CMD [ "node", "index.js" ]
