ARG BUILD_FROM
FROM $BUILD_FROM

# Set working directory
WORKDIR /app

# Install native dependencies for serialport
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    udev \
    git

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
