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

# Command to run the application in daemon mode
CMD ["node", "payment-tracker.js", "--daemon"]