FROM node:14-bullseye-slim

# Set working directory
WORKDIR /app

# Install build dependencies for serialport
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    udev \
    git \
    && rm -rf /var/lib/apt/lists/*

# Set python path for node-gyp
RUN npm config set python python3

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
CMD [ "node", "index.js" ]
