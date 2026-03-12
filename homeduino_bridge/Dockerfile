FROM node:14-alpine

# Set working directory
WORKDIR /app

# Install build dependencies for serialport
RUN apk add --no-cache \
    python2 \
    make \
    g++ \
    udev \
    git \
    linux-headers

# Copy package files
COPY package.json .

# Install node dependencies
# We use --unsafe-perm to allow serialport to build as root if needed
RUN npm install --production --unsafe-perm

# Copy all files
COPY . .

# Ensure run.sh is executable
RUN chmod a+x run.sh

# Expose port for ingress
EXPOSE 8080

# Run bridge
# Note: Since we are not using HA base image, we might miss bashio features,
# but for index.js we only need env vars.
CMD [ "node", "index.js" ]
