#!/bin/bash
set -e

# MCP Google Drive Server - AWS Deployment Script
# This script builds, tags, and deploys the Docker image to AWS ECS

# Configuration
AWS_REGION="${AWS_REGION:-us-east-1}"
AWS_ACCOUNT_ID="${AWS_ACCOUNT_ID:-}"
ECR_REPOSITORY="${ECR_REPOSITORY:-mcp-gdrive}"
ECS_CLUSTER="${ECS_CLUSTER:-mcp-gdrive-cluster}"
ECS_SERVICE="${ECS_SERVICE:-mcp-gdrive-service}"
IMAGE_TAG="${IMAGE_TAG:-latest}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Helper functions
log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check prerequisites
check_prerequisites() {
    log_info "Checking prerequisites..."

    if ! command -v aws &> /dev/null; then
        log_error "AWS CLI is not installed. Please install it first."
        exit 1
    fi

    if ! command -v docker &> /dev/null; then
        log_error "Docker is not installed. Please install it first."
        exit 1
    fi

    if [ -z "$AWS_ACCOUNT_ID" ]; then
        log_info "Detecting AWS account ID..."
        AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
        if [ -z "$AWS_ACCOUNT_ID" ]; then
            log_error "Failed to detect AWS account ID. Please set AWS_ACCOUNT_ID environment variable."
            exit 1
        fi
        log_info "Detected AWS account ID: $AWS_ACCOUNT_ID"
    fi

    log_info "Prerequisites check passed ✓"
}

# Login to ECR
ecr_login() {
    log_info "Logging in to Amazon ECR..."
    aws ecr get-login-password --region "$AWS_REGION" | \
        docker login --username AWS --password-stdin \
        "$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"
    log_info "ECR login successful ✓"
}

# Build Docker image
build_image() {
    log_info "Building Docker image..."
    docker build -t "$ECR_REPOSITORY" .
    log_info "Docker build successful ✓"
}

# Tag image
tag_image() {
    local ecr_uri="$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPOSITORY:$IMAGE_TAG"
    log_info "Tagging image as: $ecr_uri"
    docker tag "$ECR_REPOSITORY:latest" "$ecr_uri"
    log_info "Image tagged successfully ✓"
}

# Push to ECR
push_image() {
    local ecr_uri="$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPOSITORY:$IMAGE_TAG"
    log_info "Pushing image to ECR: $ecr_uri"
    docker push "$ecr_uri"
    log_info "Image pushed successfully ✓"
}

# Update ECS service
update_service() {
    log_info "Updating ECS service: $ECS_SERVICE in cluster: $ECS_CLUSTER"
    aws ecs update-service \
        --cluster "$ECS_CLUSTER" \
        --service "$ECS_SERVICE" \
        --force-new-deployment \
        --region "$AWS_REGION" > /dev/null
    log_info "ECS service update initiated ✓"
    log_warn "Deployment is in progress. Check ECS console for status."
}

# Get service status
get_service_status() {
    log_info "Checking service status..."
    local tasks=$(aws ecs list-tasks \
        --cluster "$ECS_CLUSTER" \
        --service-name "$ECS_SERVICE" \
        --region "$AWS_REGION" \
        --query 'taskArns[0]' \
        --output text)

    if [ "$tasks" != "None" ] && [ -n "$tasks" ]; then
        log_info "Task ARN: $tasks"
        log_info "To get public IP, run:"
        echo "  aws ecs describe-tasks --cluster $ECS_CLUSTER --tasks $tasks --region $AWS_REGION --query 'tasks[0].attachments[0].details[?name==\`networkInterfaceId\`].value' --output text | xargs -I {} aws ec2 describe-network-interfaces --network-interface-ids {} --region $AWS_REGION --query 'NetworkInterfaces[0].Association.PublicIp' --output text"
    else
        log_warn "No running tasks found. Service may still be deploying."
    fi
}

# Main deployment flow
main() {
    log_info "Starting MCP Google Drive Server deployment..."
    log_info "Configuration:"
    echo "  AWS Region: $AWS_REGION"
    echo "  ECR Repository: $ECR_REPOSITORY"
    echo "  ECS Cluster: $ECS_CLUSTER"
    echo "  ECS Service: $ECS_SERVICE"
    echo "  Image Tag: $IMAGE_TAG"
    echo ""

    check_prerequisites
    ecr_login
    build_image
    tag_image
    push_image
    update_service

    echo ""
    log_info "Deployment completed successfully! 🚀"
    echo ""
    get_service_status
    echo ""
    log_info "Next steps:"
    echo "  1. Monitor deployment in ECS console"
    echo "  2. Get public IP using the command above"
    echo "  3. Test health endpoint: curl http://<PUBLIC-IP>:3000/health"
    echo "  4. Configure TextQL with endpoint: http://<PUBLIC-IP>:3000"
}

# Run main function
main
