# AWS Deployment Guide - MCP Google Drive Server

This guide covers deploying the MCP Google Drive Server to AWS ECS Fargate for remote access by MCP clients like TextQL.

## Overview

The deployment converts the stdio-based MCP server to an HTTP-based server using Server-Sent Events (SSE) transport, containerizes it with Docker, and deploys to AWS ECS Fargate.

**Architecture:**
- **Transport**: SSE over HTTP (stateless, RESTful)
- **Container Platform**: AWS ECS Fargate (serverless containers)
- **Secrets Management**: AWS Secrets Manager
- **Container Registry**: Amazon ECR
- **Networking**: Single task with public IP

**Current Configuration:**
This guide provides a simplified single-instance deployment suitable for initial deployment and testing. For production at scale, consider adding:
- Application Load Balancer with HTTPS/TLS
- Multiple tasks across availability zones
- VPC with private subnets
- CloudWatch alarms and monitoring
- Auto-scaling policies

## Prerequisites

### Local Development Tools
- **Node.js**: v18 or later
- **npm**: Latest version
- **Docker**: For building container images
- **AWS CLI**: Configured with appropriate credentials (`aws configure`)

### AWS Account Setup
- AWS account with permissions for:
  - ECS (Elastic Container Service)
  - ECR (Elastic Container Registry)
  - Secrets Manager
  - IAM (for roles and policies)
  - EC2 (for networking)
  - CloudWatch Logs

### Google Cloud Setup
You should have already completed this (see main README):
- Google Cloud project with Drive API enabled
- OAuth consent screen configured
- OAuth client credentials downloaded as `gcp-oauth.keys.json`

## Step 1: Google Drive Authentication (One-Time)

If you haven't already authenticated with Google Drive:

```bash
# Install dependencies
npm install

# Build the project
npm run build

# Run authentication flow (opens browser)
node dist/index.js auth
```

This creates two files:
- `gcp-oauth.keys.json` (you should already have this)
- `.gdrive-server-credentials.json` (newly created)

**⚠️ IMPORTANT**: Never commit these files to git. They contain sensitive credentials.

## Step 2: AWS Secrets Manager Setup

Store your Google credentials securely in AWS Secrets Manager:

```bash
# Set your AWS region
export AWS_REGION=us-east-1

# Create secret for OAuth keys
aws secretsmanager create-secret \
  --name mcp-gdrive/oauth-keys \
  --secret-string file://gcp-oauth.keys.json \
  --description "Google Cloud OAuth client credentials for MCP GDrive" \
  --region $AWS_REGION

# Create secret for Drive credentials
aws secretsmanager create-secret \
  --name mcp-gdrive/drive-credentials \
  --secret-string file://.gdrive-server-credentials.json \
  --description "Google Drive user credentials for MCP GDrive" \
  --region $AWS_REGION
```

**Note**: These secrets can be updated later if credentials need to be refreshed:

```bash
aws secretsmanager update-secret \
  --secret-id mcp-gdrive/drive-credentials \
  --secret-string file://.gdrive-server-credentials.json
```

## Step 3: Create ECR Repository

```bash
# Create repository for Docker images
aws ecr create-repository \
  --repository-name mcp-gdrive \
  --region $AWS_REGION

# Note the repository URI from output (needed later)
# Format: <account-id>.dkr.ecr.<region>.amazonaws.com/mcp-gdrive
```

## Step 4: Create IAM Roles

### Task Execution Role

This role allows ECS to pull images and access Secrets Manager:

```bash
# Create trust policy
cat > /tmp/ecs-task-execution-trust-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "ecs-tasks.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF

# Create role
aws iam create-role \
  --role-name mcp-gdrive-execution-role \
  --assume-role-policy-document file:///tmp/ecs-task-execution-trust-policy.json

# Attach AWS managed policy for ECS task execution
aws iam attach-role-policy \
  --role-name mcp-gdrive-execution-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy

# Create inline policy for Secrets Manager access
cat > /tmp/secrets-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "secretsmanager:GetSecretValue"
      ],
      "Resource": [
        "arn:aws:secretsmanager:$AWS_REGION:*:secret:mcp-gdrive/*"
      ]
    }
  ]
}
EOF

aws iam put-role-policy \
  --role-name mcp-gdrive-execution-role \
  --policy-name SecretsManagerAccess \
  --policy-document file:///tmp/secrets-policy.json
```

### Task Role

This role is used by the container at runtime (currently minimal permissions):

```bash
# Create task role
aws iam create-role \
  --role-name mcp-gdrive-task-role \
  --assume-role-policy-document file:///tmp/ecs-task-execution-trust-policy.json
```

## Step 5: Create ECS Cluster

```bash
aws ecs create-cluster \
  --cluster-name mcp-gdrive-cluster \
  --region $AWS_REGION
```

## Step 6: Create Task Definition

Create a task definition JSON file:

```bash
# Get your AWS account ID
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# Create task definition
cat > /tmp/mcp-gdrive-task-def.json <<EOF
{
  "family": "mcp-gdrive-task",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "256",
  "memory": "512",
  "executionRoleArn": "arn:aws:iam::$AWS_ACCOUNT_ID:role/mcp-gdrive-execution-role",
  "taskRoleArn": "arn:aws:iam::$AWS_ACCOUNT_ID:role/mcp-gdrive-task-role",
  "containerDefinitions": [
    {
      "name": "mcp-gdrive",
      "image": "$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/mcp-gdrive:latest",
      "essential": true,
      "portMappings": [
        {
          "containerPort": 3000,
          "protocol": "tcp"
        }
      ],
      "environment": [
        {
          "name": "PORT",
          "value": "3000"
        },
        {
          "name": "NODE_ENV",
          "value": "production"
        },
        {
          "name": "AWS_REGION",
          "value": "$AWS_REGION"
        }
      ],
      "secrets": [
        {
          "name": "GDRIVE_CREDENTIALS",
          "valueFrom": "arn:aws:secretsmanager:$AWS_REGION:$AWS_ACCOUNT_ID:secret:mcp-gdrive/drive-credentials"
        },
        {
          "name": "GDRIVE_OAUTH",
          "valueFrom": "arn:aws:secretsmanager:$AWS_REGION:$AWS_ACCOUNT_ID:secret:mcp-gdrive/oauth-keys"
        }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/mcp-gdrive",
          "awslogs-region": "$AWS_REGION",
          "awslogs-stream-prefix": "ecs",
          "awslogs-create-group": "true"
        }
      },
      "healthCheck": {
        "command": [
          "CMD-SHELL",
          "node -e \"require('http').get('http://localhost:3000/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1));\""
        ],
        "interval": 30,
        "timeout": 5,
        "retries": 3,
        "startPeriod": 60
      }
    }
  ]
}
EOF

# Register task definition
aws ecs register-task-definition \
  --cli-input-json file:///tmp/mcp-gdrive-task-def.json \
  --region $AWS_REGION
```

## Step 7: Create Security Group

```bash
# Get default VPC ID
VPC_ID=$(aws ec2 describe-vpcs \
  --filters "Name=isDefault,Values=true" \
  --query "Vpcs[0].VpcId" \
  --output text \
  --region $AWS_REGION)

# Create security group
SG_ID=$(aws ec2 create-security-group \
  --group-name mcp-gdrive-sg \
  --description "Security group for MCP GDrive server" \
  --vpc-id $VPC_ID \
  --region $AWS_REGION \
  --query 'GroupId' \
  --output text)

# Allow inbound traffic on port 3000
aws ec2 authorize-security-group-ingress \
  --group-id $SG_ID \
  --protocol tcp \
  --port 3000 \
  --cidr 0.0.0.0/0 \
  --region $AWS_REGION

echo "Security Group ID: $SG_ID"
```

**Security Note**: The above allows access from anywhere (`0.0.0.0/0`). For production, restrict to specific IP ranges:

```bash
# Example: Restrict to specific IP range
aws ec2 authorize-security-group-ingress \
  --group-id $SG_ID \
  --protocol tcp \
  --port 3000 \
  --cidr 203.0.113.0/24 \
  --region $AWS_REGION
```

## Step 8: Create ECS Service

```bash
# Get default VPC subnets (we need at least 2 for HA)
SUBNET_IDS=$(aws ec2 describe-subnets \
  --filters "Name=vpc-id,Values=$VPC_ID" \
  --query "Subnets[0:2].SubnetId" \
  --output text \
  --region $AWS_REGION | tr '\t' ',')

# Create service
aws ecs create-service \
  --cluster mcp-gdrive-cluster \
  --service-name mcp-gdrive-service \
  --task-definition mcp-gdrive-task \
  --desired-count 1 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNET_IDS],securityGroups=[$SG_ID],assignPublicIp=ENABLED}" \
  --region $AWS_REGION
```

## Step 9: Build and Deploy

Use the provided deployment script:

```bash
# Set configuration (optional, defaults provided)
export AWS_REGION=us-east-1
export ECR_REPOSITORY=mcp-gdrive
export ECS_CLUSTER=mcp-gdrive-cluster
export ECS_SERVICE=mcp-gdrive-service

# Run deployment
./scripts/deploy-aws.sh
```

The script will:
1. Check prerequisites (AWS CLI, Docker)
2. Login to ECR
3. Build Docker image
4. Tag and push to ECR
5. Update ECS service to trigger redeployment
6. Display next steps

## Step 10: Get Public IP Address

After deployment completes:

```bash
# List running tasks
TASK_ARN=$(aws ecs list-tasks \
  --cluster mcp-gdrive-cluster \
  --service-name mcp-gdrive-service \
  --region $AWS_REGION \
  --query 'taskArns[0]' \
  --output text)

# Get network interface ID
ENI_ID=$(aws ecs describe-tasks \
  --cluster mcp-gdrive-cluster \
  --tasks $TASK_ARN \
  --region $AWS_REGION \
  --query 'tasks[0].attachments[0].details[?name==`networkInterfaceId`].value' \
  --output text)

# Get public IP
PUBLIC_IP=$(aws ec2 describe-network-interfaces \
  --network-interface-ids $ENI_ID \
  --region $AWS_REGION \
  --query 'NetworkInterfaces[0].Association.PublicIp' \
  --output text)

echo "Public IP: $PUBLIC_IP"
echo "Health endpoint: http://$PUBLIC_IP:3000/health"
echo "MCP endpoint: http://$PUBLIC_IP:3000/sse"
```

## Step 11: Verify Deployment

Test the health endpoint:

```bash
curl http://$PUBLIC_IP:3000/health
```

Expected response:
```json
{
  "status": "healthy",
  "service": "mcp-gdrive-server",
  "version": "0.6.2",
  "timestamp": "2025-01-XX..."
}
```

Check logs:

```bash
aws logs tail /ecs/mcp-gdrive --follow --region $AWS_REGION
```

## Step 12: Configure MCP Client (TextQL)

Configure your MCP client to connect to the server:

**Endpoint**: `http://<PUBLIC_IP>:3000/sse`

**Example TextQL configuration**:
```json
{
  "mcpServers": {
    "gdrive": {
      "url": "http://YOUR_PUBLIC_IP:3000/sse",
      "transport": "sse"
    }
  }
}
```

## Updating the Deployment

To deploy updates:

```bash
# Make your code changes
# Then run the deployment script again
./scripts/deploy-aws.sh
```

The script automatically:
- Builds a new Docker image
- Pushes to ECR
- Forces ECS to redeploy with new image

## Monitoring

### CloudWatch Logs

View logs:
```bash
aws logs tail /ecs/mcp-gdrive --follow --region $AWS_REGION
```

### ECS Console

Monitor service health:
- Go to ECS Console → Clusters → mcp-gdrive-cluster → mcp-gdrive-service
- Check "Tasks" tab for running tasks
- Check "Metrics" tab for CPU/memory usage

### Cost Monitoring

Current configuration costs approximately:
- **Fargate**: ~$13-15/month (0.25 vCPU, 0.5GB RAM, continuous)
- **Data Transfer**: ~$2-5/month (light usage)
- **Secrets Manager**: ~$0.80/month (2 secrets)
- **ECR Storage**: ~$0.50/month (single image)
- **Total**: ~$16-21/month

## Scaling for Production

### Add Load Balancer + HTTPS

For production, add an Application Load Balancer:

1. **Create ALB** with HTTPS listener
2. **Request SSL certificate** from AWS Certificate Manager
3. **Update security groups** to allow only ALB → ECS traffic
4. **Place ECS tasks in private subnets**
5. **Update task definition** to use container port from ALB target group

### Enable Auto-Scaling

```bash
# Register scalable target
aws application-autoscaling register-scalable-target \
  --service-namespace ecs \
  --scalable-dimension ecs:service:DesiredCount \
  --resource-id service/mcp-gdrive-cluster/mcp-gdrive-service \
  --min-capacity 1 \
  --max-capacity 10

# Create scaling policy (target tracking)
aws application-autoscaling put-scaling-policy \
  --service-namespace ecs \
  --scalable-dimension ecs:service:DesiredCount \
  --resource-id service/mcp-gdrive-cluster/mcp-gdrive-service \
  --policy-name cpu-target-tracking \
  --policy-type TargetTrackingScaling \
  --target-tracking-scaling-policy-configuration file://scaling-policy.json
```

### Increase Resources

Update task definition with higher CPU/memory:
- CPU: 512 (0.5 vCPU) or 1024 (1 vCPU)
- Memory: 1024 (1GB) or 2048 (2GB)

## Troubleshooting

### Task Fails to Start

Check logs:
```bash
aws logs tail /ecs/mcp-gdrive --region $AWS_REGION
```

Common issues:
- **Secrets not found**: Verify secret ARNs in task definition
- **No space left on device**: Increase task ephemeral storage
- **Health check failing**: Check if port 3000 is properly exposed

### Cannot Access Public IP

Verify:
- Security group allows inbound on port 3000
- Task has public IP assigned (`assignPublicIp=ENABLED`)
- Task is in RUNNING state

### Credentials Expired

Google OAuth tokens can expire. To refresh:

```bash
# Run auth flow locally
node dist/index.js auth

# Update secret
aws secretsmanager update-secret \
  --secret-id mcp-gdrive/drive-credentials \
  --secret-string file://.gdrive-server-credentials.json
```

## Teardown

To remove all AWS resources:

```bash
# Delete ECS service
aws ecs update-service \
  --cluster mcp-gdrive-cluster \
  --service mcp-gdrive-service \
  --desired-count 0 \
  --region $AWS_REGION

aws ecs delete-service \
  --cluster mcp-gdrive-cluster \
  --service mcp-gdrive-service \
  --force \
  --region $AWS_REGION

# Delete ECS cluster
aws ecs delete-cluster \
  --cluster mcp-gdrive-cluster \
  --region $AWS_REGION

# Delete secrets (optional - keep for redeployment)
aws secretsmanager delete-secret \
  --secret-id mcp-gdrive/oauth-keys \
  --force-delete-without-recovery \
  --region $AWS_REGION

aws secretsmanager delete-secret \
  --secret-id mcp-gdrive/drive-credentials \
  --force-delete-without-recovery \
  --region $AWS_REGION

# Delete ECR images
aws ecr batch-delete-image \
  --repository-name mcp-gdrive \
  --image-ids imageTag=latest \
  --region $AWS_REGION

# Delete security group
aws ec2 delete-security-group \
  --group-id $SG_ID \
  --region $AWS_REGION

# Delete IAM roles (detach policies first)
aws iam detach-role-policy \
  --role-name mcp-gdrive-execution-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy

aws iam delete-role-policy \
  --role-name mcp-gdrive-execution-role \
  --policy-name SecretsManagerAccess

aws iam delete-role --role-name mcp-gdrive-execution-role
aws iam delete-role --role-name mcp-gdrive-task-role
```

## Security Best Practices

1. **Credentials**: Never commit OAuth keys or credentials to git
2. **Secrets Manager**: Rotate secrets periodically
3. **Network**: Restrict security group to specific IP ranges
4. **HTTPS**: Use ALB with SSL/TLS for production
5. **IAM**: Follow principle of least privilege
6. **VPC**: Use private subnets for tasks in production
7. **Logging**: Enable CloudWatch logs and monitor access
8. **Scanning**: Enable ECR image scanning for vulnerabilities

## Next Steps

- Add Application Load Balancer with HTTPS
- Implement authentication/authorization for MCP endpoint
- Set up CloudWatch alarms for monitoring
- Configure auto-scaling based on traffic
- Add VPC with private subnets for enhanced security
- Implement CI/CD pipeline for automated deployments

## Support

For issues or questions:
- Check logs: `aws logs tail /ecs/mcp-gdrive --follow`
- Review ECS service events in AWS Console
- Verify task definition and security group configuration
