# Use standard Node.js Alpine image for reliability
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Install build dependencies for serialport
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    udev \
    git \
    linux-headers

# Copy package files
COPY package.json .

# Install node dependencies
RUN npm install --production --unsafe-perm

# Copy all files
COPY . .

# Ensure run.sh is executable
RUN chmod a+x run.sh

# Expose port for ingress
EXPOSE 8080

# Run bridge
CMD [ "./run.sh" ]
