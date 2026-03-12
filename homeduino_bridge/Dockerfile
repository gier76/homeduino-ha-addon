ARG BUILD_FROM
FROM $BUILD_FROM

# Set working directory
WORKDIR /app

# CACHE BUST: 2026-03-12-21-35-ULTRA-AGGRESSIVE
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

# Step 1: Install EVERYTHING without running any scripts
RUN npm install --production --ignore-scripts --unsafe-perm

# Step 2: Nuke ALL nested serialport directories anywhere in the tree
RUN find . -name "serialport" -type d -exec rm -rf {} +

# Step 3: Install the latest serialport at the root and allow IT to build
RUN npm install serialport@latest --production --unsafe-perm

# Step 4: Verify the structure
RUN ls -R node_modules/homeduino/node_modules || echo "No nested modules"

# Copy all files
COPY . .

# Ensure run.sh is executable
RUN chmod a+x run.sh

# Expose port for ingress
EXPOSE 8080

# Run bridge
CMD [ "node", "index.js" ]
