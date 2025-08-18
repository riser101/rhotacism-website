#!/bin/bash

# Deploy to Google Cloud Functions
# Make sure you have gcloud CLI installed and authenticated

echo "🚀 Deploying rhotacism speech analyzer to Google Cloud Functions..."

# Set your project ID here
PROJECT_ID="detache-platform"
FUNCTION_NAME="analyzeSpeech"
REGION="us-central1"

# Deploy the function
gcloud functions deploy $FUNCTION_NAME \
  --gen2 \
  --runtime=nodejs18 \
  --region=$REGION \
  --source=. \
  --entry-point=analyzeSpeech \
  --trigger-http \
  --allow-unauthenticated \
  --set-env-vars="OPENAI_API_KEY=$OPENAI_API_KEY" \
  --memory=1GiB \
  --timeout=300s \
  --project=$PROJECT_ID

echo "✅ Deployment complete!"
echo "Function URL: https://$REGION-$PROJECT_ID.cloudfunctions.net/$FUNCTION_NAME"