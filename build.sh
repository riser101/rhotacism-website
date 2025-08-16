#!/bin/bash

# Create dist directory
mkdir -p dist

# Debug: Check if environment variable exists
echo "Environment variable check:"
if [ -z "$NEXT_PUBLIC_OPENAI_API_KEY" ]; then
    echo "ERROR: NEXT_PUBLIC_OPENAI_API_KEY is not set"
else
    echo "NEXT_PUBLIC_OPENAI_API_KEY is set (length: ${#NEXT_PUBLIC_OPENAI_API_KEY})"
fi

# Replace the placeholder with the actual API key
sed "s/__OPENAI_API_KEY__/$NEXT_PUBLIC_OPENAI_API_KEY/g" index.html > dist/index.html

# Verify replacement worked
if grep -q "__OPENAI_API_KEY__" dist/index.html; then
    echo "ERROR: Placeholder was not replaced!"
else
    echo "SUCCESS: API key injected successfully"
fi

echo "Build complete!"