#!/bin/sh

echo "Starting Homeduino Bridge (Modernized)..."
echo "Current directory: $(pwd)"
echo "Contents of current directory:"
ls -lA
echo "Checking if index.js exists: "
if [ -f "index.js" ]; then
    echo "index.js found."
else
    echo "index.js NOT found!"
fi
exec node index.js
