#!/bin/bash

# Docker Hub Push Script for Alloc8 Budget Calculator

# Configuration - CHANGE THESE
DOCKER_USERNAME="your-dockerhub-username"
IMAGE_NAME="alloc8-budget-calculator"
TAG="latest"

# Full image name
FULL_IMAGE="$DOCKER_USERNAME/$IMAGE_NAME:$TAG"

echo "=== Building Docker Image ==="
docker build -t $IMAGE_NAME .

echo "=== Tagging Image ==="
docker tag $IMAGE_NAME $FULL_IMAGE

echo "=== Logging into Docker Hub ==="
docker login

echo "=== Pushing to Docker Hub ==="
docker push $FULL_IMAGE

echo "=== Done! ==="
echo "Image: $FULL_IMAGE"
echo ""
echo "To pull and run:"
echo "docker pull $FULL_IMAGE"
echo "docker run -p 3000:3000 $FULL_IMAGE"
