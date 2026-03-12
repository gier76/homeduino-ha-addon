ARG BUILD_FROM
FROM $BUILD_FROM

# Set working directory
WORKDIR /app

# CACHE BUST: 2026-03-12-21-45-SURGICAL-PATCH
RUN apk add --no-cache \
    nodejs \
    npm \
    python3 \
    make \
    g++ \
    udev \
    git \
    linux-headers \
    jq

# Copy package files
COPY package.json .

# Step 1: Install homeduino but PREVENT it from installing its own serialport
# We do this by creating a fake node_modules/homeduino/package.json first?
# No, let's just install ignoring scripts, then patch.
RUN npm install --production --ignore-scripts --unsafe-perm

# Step 2: PATCH homeduino's package.json to remove the old serialport dependency
RUN if [ -f node_modules/homeduino/package.json ]; then \
    jq 'del(.dependencies.serialport)' node_modules/homeduino/package.json > node_modules/homeduino/package.json.tmp \
    && mv node_modules/homeduino/package.json.tmp node_modules/homeduino/package.json; \
    fi

# Step 3: Nuke any existing nested serialport folders
RUN find . -name "serialport" -type d -exec rm -rf {} +

# Step 4: Install the LATEST serialport at the root
RUN npm install serialport@latest --production --unsafe-perm

# Step 5: Verify
RUN ls -R node_modules/homeduino/node_modules || echo "Clean"

# Copy all files
COPY . .

# Ensure run.sh is executable
RUN chmod a+x run.sh

# Expose port for ingress
EXPOSE 8080

# Run bridge
CMD [ "node", "index.js" ]
