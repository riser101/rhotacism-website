#!/bin/bash

# Replace the placeholder with the actual API key
sed "s/__OPENAI_API_KEY__/$NEXT_PUBLIC_OPENAI_API_KEY/g" index.html > dist/index.html

echo "Build complete! API key injected."