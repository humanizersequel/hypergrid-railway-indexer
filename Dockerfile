# Use an official Node.js LTS version on Alpine Linux for a smaller image
FROM node:20-alpine

# Create app directory
WORKDIR /app

# Install dependencies first to leverage Docker cache
# Copy package.json AND package-lock.json (if available)
COPY package*.json ./
# Install *only* production dependencies
RUN npm install --production

# Copy the rest of the application code
COPY . .

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S payment-tracker -u 1001

# Change ownership of the app directory
RUN chown -R payment-tracker:nodejs /app
USER payment-tracker

# Command to run the application in daemon mode with production optimizations
CMD ["node", "--expose-gc", "payment-tracker.js", "--daemon"]