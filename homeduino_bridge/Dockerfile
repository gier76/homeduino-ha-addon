FROM node:16-bullseye-slim

# Set working directory
WORKDIR /app

# Install build dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    udev \
    git \
    && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package.json .

# Install node dependencies
# We install serialport first to ensure it's built correctly
RUN npm install serialport@10.5.0 --production --unsafe-perm
RUN npm install --production --unsafe-perm

# Copy all files
COPY . .

# Ensure run.sh is executable
RUN chmod a+x run.sh

# Expose port for ingress
EXPOSE 8080

# Run bridge
CMD [ "node", "index.js" ]
