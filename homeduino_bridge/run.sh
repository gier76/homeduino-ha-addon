<<<<<<< HEAD
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
=======
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
>>>>>>> a5e7369 (Fix RF send command format, add RF config options, re‑enable receive after send)
