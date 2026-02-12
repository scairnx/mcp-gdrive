#!/bin/bash
set -e

# Associate Elastic IP with MCP GDrive ECS Task
# Run this after each ECS service deployment

AWS_REGION="${AWS_REGION:-us-east-1}"
EIP_ALLOCATION_ID="eipalloc-04a55372507d84fd3"
ELASTIC_IP="52.23.117.57"
ECS_CLUSTER="mcp-gdrive-cluster"
ECS_SERVICE="mcp-gdrive-service"

echo "==========================================="
echo "  Associating Elastic IP with ECS Task"
echo "==========================================="
echo ""
echo "Elastic IP: $ELASTIC_IP"
echo ""

# Get running task
echo "Finding running task..."
TASK_ARN=$(aws ecs list-tasks \
  --cluster $ECS_CLUSTER \
  --service-name $ECS_SERVICE \
  --region $AWS_REGION \
  --desired-status RUNNING \
  --query 'taskArns[0]' \
  --output text)

if [ "$TASK_ARN" == "None" ] || [ -z "$TASK_ARN" ]; then
  echo "❌ No running task found"
  exit 1
fi

echo "✓ Task found: $TASK_ARN"
echo ""

# Get network interface
echo "Getting network interface..."
ENI_ID=$(aws ecs describe-tasks \
  --cluster $ECS_CLUSTER \
  --tasks $TASK_ARN \
  --region $AWS_REGION \
  --query 'tasks[0].attachments[0].details[?name==`networkInterfaceId`].value' \
  --output text)

echo "✓ Network Interface: $ENI_ID"
echo ""

# Disassociate from any previous ENI
echo "Checking if EIP is associated elsewhere..."
CURRENT_ENI=$(aws ec2 describe-addresses \
  --allocation-ids $EIP_ALLOCATION_ID \
  --region $AWS_REGION \
  --query 'Addresses[0].NetworkInterfaceId' \
  --output text 2>/dev/null || echo "None")

if [ "$CURRENT_ENI" != "None" ] && [ "$CURRENT_ENI" != "$ENI_ID" ] && [ -n "$CURRENT_ENI" ]; then
  echo "Disassociating EIP from old interface $CURRENT_ENI..."
  ASSOCIATION_ID=$(aws ec2 describe-addresses \
    --allocation-ids $EIP_ALLOCATION_ID \
    --region $AWS_REGION \
    --query 'Addresses[0].AssociationId' \
    --output text)

  aws ec2 disassociate-address \
    --association-id $ASSOCIATION_ID \
    --region $AWS_REGION

  echo "✓ Disassociated from old interface"
  sleep 2
fi

# Associate with new task
echo "Associating Elastic IP with new task..."
aws ec2 associate-address \
  --allocation-id $EIP_ALLOCATION_ID \
  --network-interface-id $ENI_ID \
  --region $AWS_REGION \
  --allow-reassociation

echo ""
echo "==========================================="
echo "  ✅ SUCCESS!"
echo "==========================================="
echo ""
echo "Your MCP server is now accessible at:"
echo "  http://$ELASTIC_IP:3000/sse?user=scott"
echo ""
echo "Test it:"
echo "  curl http://$ELASTIC_IP:3000/health"
echo ""
