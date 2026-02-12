# Elastic IP with ECS Fargate Limitation

## The Issue

ECS Fargate tasks with **auto-assigned public IPs** (which our setup uses) cannot directly use Elastic IPs because:

1. AWS automatically assigns a public IP to the task
2. This auto-assigned IP is managed by ECS and can't be replaced with an Elastic IP
3. To use an Elastic IP, you'd need to:
   - Disable auto-assign public IP
   - Use a NAT Gateway for outbound connectivity (~$32/month)
   - Manually associate the Elastic IP

## Your Options

### Option 1: Accept Changing IPs (Current - Free)
- **Cost**: Current setup (~$16-21/month)
- **Pros**: Simple, no additional cost
- **Cons**: IP changes when task redeploys
- **Solution**: Update TextQL config when IP changes

**Current IP**: Check with `aws ecs describe-services...`

---

### Option 2: Application Load Balancer (Recommended)
- **Cost**: +$16/month = ~$32-37/month total
- **Pros**:
  - Static DNS name (never changes)
  - HTTPS support with free SSL certificate
  - Better for production
  - Health checks and auto-recovery
- **Cons**: Additional monthly cost

**DNS Example**: `mcp-gdrive-123456.us-east-1.elb.amazonaws.com`

---

### Option 3: NAT Gateway + Elastic IP (Complex)
- **Cost**: +$32/month for NAT + $3/month for EIP = ~$51-56/month total
- **Pros**: True static IP address
- **Cons**: Most expensive, complex setup

---

## Recommendation

**For your use case (team of 3-10 users), I recommend Option 2 (ALB)**:

1. Static DNS name that never changes
2. Can add HTTPS later with free SSL certificate
3. Production-ready architecture
4. Only $16/month additional cost

Would you like me to set up the Application Load Balancer for you?

---

## What I've Done

1. ✅ Allocated Elastic IP: **52.23.117.57** (Allocation: `eipalloc-04a55372507d84fd3`)
2. ⚠️ Cannot associate it with current ECS setup (auto-assigned IP conflict)

**To use this Elastic IP**, we'd need to reconfigure the entire network architecture (NAT Gateway + private subnets).

**To release it** (save $3/month):
```bash
aws ec2 release-address --allocation-id eipalloc-04a55372507d84fd3 --region us-east-1
```

---

## For Now: Use Current IP

**Your current working IP**: `54.158.144.252`

**TextQL Configuration**:
```json
{
  "mcpServers": {
    "gdrive": {
      "enabled": true,
      "url": "http://54.158.144.252:3000/sse?user=scott"
    }
  }
}
```

**To get current IP anytime**:
```bash
./scripts/get-current-ip.sh
```
