# Multi-stage build for production MCP Google Drive Server

# Build stage
FROM node:22.12-alpine AS builder

WORKDIR /app

# Copy package files and source code
COPY package*.json ./
COPY tsconfig.json ./
COPY index.ts ./
COPY src ./src
COPY scripts ./scripts
COPY replace_open.sh ./

# Install all dependencies (including dev dependencies for build)
# The prepare script will automatically run npm run build
RUN npm ci

# Production stage
FROM node:22.12-alpine AS release

WORKDIR /app

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Copy package files
COPY --from=builder /app/package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev --ignore-scripts

# Copy built application
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/replace_open.sh ./

# Run replace_open.sh to fix the open command for non-interactive environments
RUN sh ./replace_open.sh && rm ./replace_open.sh

# Change ownership to non-root user
RUN chown -R nodejs:nodejs /app

# Switch to non-root user
USER nodejs

# Expose HTTP port
EXPOSE 3000

# Set production environment
ENV NODE_ENV=production \
    PORT=3000

# Health check (for Docker and ECS)
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1));"

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Default to HTTP server (can be overridden for stdio mode)
CMD ["node", "dist/src/http-server.js"]
