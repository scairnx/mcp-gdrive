#!/bin/bash

# Get current MCP GDrive server public IP

AWS_REGION="${AWS_REGION:-us-east-1}"
ECS_CLUSTER="mcp-gdrive-cluster"
ECS_SERVICE="mcp-gdrive-service"

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

ENI_ID=$(aws ecs describe-tasks \
  --cluster $ECS_CLUSTER \
  --tasks $TASK_ARN \
  --region $AWS_REGION \
  --query 'tasks[0].attachments[0].details[?name==`networkInterfaceId`].value' \
  --output text)

PUBLIC_IP=$(aws ec2 describe-network-interfaces \
  --network-interface-ids $ENI_ID \
  --region $AWS_REGION \
  --query 'NetworkInterfaces[0].Association.PublicIp' \
  --output text)

echo ""
echo "Current MCP Server IP: $PUBLIC_IP"
echo ""
echo "MCP Endpoint:"
echo "  http://$PUBLIC_IP:3000/sse?user=scott"
echo ""
echo "TextQL Configuration:"
echo '{'
echo '  "mcpServers": {'
echo '    "gdrive": {'
echo '      "enabled": true,'
echo "      \"url\": \"http://$PUBLIC_IP:3000/sse?user=scott\""
echo '    }'
echo '  }'
echo '}'
echo ""
