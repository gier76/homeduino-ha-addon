ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base-nodejs:latest
FROM $BUILD_FROM

# Set working directory
WORKDIR /app

# Install build dependencies
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    udev \
    git \
    linux-headers

# Copy package files
COPY package.json .

# Install node dependencies but ignore scripts for a moment to prevent building old serialport
RUN npm install --production --ignore-scripts --unsafe-perm

# Now surgically remove any old serialport and install the new one
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
