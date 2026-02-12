# 🎉 AWS Deployment Successful!

## Your MCP Google Drive Server is Live

**Public IP**: `54.237.120.216`
**Region**: `us-east-1`
**Status**: ✅ Running

---

## Quick Links

### MCP Endpoints

**For user "scott":**
```
http://54.237.120.216:3000/sse?user=scott
```

**Using default user:**
```
http://54.237.120.216:3000/sse
```

**Health Check:**
```
http://54.237.120.216:3000/health
```

**List Available Users:**
```
http://54.237.120.216:3000/users
```

---

## Test Your Deployment

```bash
# Health check
curl http://54.237.120.216:3000/health

# List users
curl http://54.237.120.216:3000/users

# Use with TextQL or any MCP client
# Connect to: http://54.237.120.216:3000/sse?user=scott
```

---

## Add More Team Members

### 1. Authenticate Locally

```bash
# Authenticate new team member
node dist/index.js auth-user alice

# Or use interactive menu
npm run auth-users
```

### 2. Upload to AWS Secrets Manager

```bash
aws secretsmanager create-secret \
  --name mcp-gdrive/users/alice \
  --secret-string file://credentials/user-alice.json \
  --region us-east-1
```

### 3. Restart ECS Service

```bash
aws ecs update-service \
  --cluster mcp-gdrive-cluster \
  --service mcp-gdrive-service \
  --force-new-deployment \
  --region us-east-1
```

Wait ~1 minute for the new deployment to complete.

---

## AWS Resources Created

### Secrets Manager
- `mcp-gdrive/oauth-keys` - Google OAuth credentials
- `mcp-gdrive/users/scott` - Your Google Drive credentials

### ECR
- Repository: `mcp-gdrive`
- Image: `844595997041.dkr.ecr.us-east-1.amazonaws.com/mcp-gdrive:latest`

### ECS
- Cluster: `mcp-gdrive-cluster`
- Service: `mcp-gdrive-service`
- Task Definition: `mcp-gdrive-task`

### IAM Roles
- Execution Role: `mcp-gdrive-execution-role`
- Task Role: `mcp-gdrive-task-role`

### Networking
- VPC: `vpc-08dc3871fe1bb25c4`
- Security Group: `sg-0d9183992746e9b00` (Port 3000 open)
- Subnets: Public subnets with auto-assign public IP

---

## Monthly Costs

**Estimated AWS costs:**
- ECS Fargate (0.25 vCPU, 0.5GB): ~$13-15/month
- Data transfer: ~$2-5/month (light usage)
- Secrets Manager: ~$0.80/month (2 secrets)
- ECR storage: ~$0.50/month

**Total**: ~$16-21/month

---

## Update Deployment

### Rebuild and Deploy Changes

```bash
# Build new Docker image (AMD64 for AWS)
docker buildx build --platform linux/amd64 -t mcp-gdrive .

# Tag for ECR
docker tag mcp-gdrive:latest 844595997041.dkr.ecr.us-east-1.amazonaws.com/mcp-gdrive:latest

# Login to ECR
aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin 844595997041.dkr.ecr.us-east-1.amazonaws.com

# Push to ECR
docker push 844595997041.dkr.ecr.us-east-1.amazonaws.com/mcp-gdrive:latest

# Force new deployment
aws ecs update-service \
  --cluster mcp-gdrive-cluster \
  --service mcp-gdrive-service \
  --force-new-deployment \
  --region us-east-1
```

---

## Monitoring

### View Logs

```bash
# Tail recent logs
aws logs tail /ecs/mcp-gdrive --region us-east-1 --follow

# View last 30 minutes
aws logs tail /ecs/mcp-gdrive --region us-east-1 --since 30m
```

### Check Service Status

```bash
# List running tasks
aws ecs list-tasks \
  --cluster mcp-gdrive-cluster \
  --service-name mcp-gdrive-service \
  --region us-east-1

# Describe service
aws ecs describe-services \
  --cluster mcp-gdrive-cluster \
  --services mcp-gdrive-service \
  --region us-east-1
```

---

## Troubleshooting

### Service Won't Start

1. Check logs: `aws logs tail /ecs/mcp-gdrive --region us-east-1 --since 5m`
2. Verify secrets exist: `aws secretsmanager list-secrets --region us-east-1 | grep mcp-gdrive`
3. Check task definition: `aws ecs describe-task-definition --task-definition mcp-gdrive-task --region us-east-1`

### Can't Connect to Server

1. Verify security group allows port 3000: `aws ec2 describe-security-groups --group-ids sg-0d9183992746e9b00 --region us-east-1`
2. Check public IP is assigned: Task must have `assignPublicIp=ENABLED`
3. Wait 1-2 minutes for task to fully start

### User Not Found

1. Verify secret exists: `aws secretsmanager describe-secret --secret-id mcp-gdrive/users/<username> --region us-east-1`
2. Check task role has `secretsmanager:ListSecrets` permission
3. Force redeploy to pick up new credentials

---

## Cleanup (When Done)

To remove all AWS resources and stop billing:

```bash
# Delete ECS service
aws ecs delete-service \
  --cluster mcp-gdrive-cluster \
  --service mcp-gdrive-service \
  --force \
  --region us-east-1

# Delete ECS cluster
aws ecs delete-cluster \
  --cluster mcp-gdrive-cluster \
  --region us-east-1

# Delete secrets
aws secretsmanager delete-secret \
  --secret-id mcp-gdrive/oauth-keys \
  --force-delete-without-recovery \
  --region us-east-1

aws secretsmanager delete-secret \
  --secret-id mcp-gdrive/users/scott \
  --force-delete-without-recovery \
  --region us-east-1

# Delete ECR images
aws ecr batch-delete-image \
  --repository-name mcp-gdrive \
  --image-ids imageTag=latest \
  --region us-east-1

# Delete security group
aws ec2 delete-security-group \
  --group-id sg-0d9183992746e9b00 \
  --region us-east-1

# Delete IAM roles
aws iam delete-role-policy \
  --role-name mcp-gdrive-execution-role \
  --policy-name SecretsManagerAccess

aws iam delete-role-policy \
  --role-name mcp-gdrive-execution-role \
  --policy-name CloudWatchLogsAccess

aws iam detach-role-policy \
  --role-name mcp-gdrive-execution-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy

aws iam delete-role --role-name mcp-gdrive-execution-role

aws iam delete-role-policy \
  --role-name mcp-gdrive-task-role \
  --policy-name SecretsManagerAccess

aws iam delete-role --role-name mcp-gdrive-task-role
```

---

## Next Steps

1. **Test with TextQL**: Configure TextQL to connect to `http://54.237.120.216:3000/sse?user=scott`
2. **Add team members**: Follow the "Add More Team Members" section above
3. **Monitor usage**: Check CloudWatch logs and metrics
4. **Enhance security** (optional):
   - Add Application Load Balancer with HTTPS
   - Restrict security group to specific IP ranges
   - Move to private subnets with NAT gateway

---

## Support

For issues or questions:
- Check logs: `aws logs tail /ecs/mcp-gdrive --follow`
- Review ECS service events in AWS Console
- Verify task definition and IAM permissions

**Success!** Your multi-user MCP Google Drive server is now running in production on AWS! 🚀
