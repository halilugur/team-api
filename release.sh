#!/bin/bash

# Exit immediately if a command exits with a non-zero status
set -e

# Fetch app name and version dynamically from package.json
APP_NAME=$(node -p "require('./package.json').name")
VERSION=$(node -p "require('./package.json').version")

echo "Cleaning existing build and release directories..."
rm -rf dist
rm -rf release
mkdir -p release

echo "Building releases for app: $APP_NAME (v$VERSION)"

# Run electron-builder for mac, windows, and linux.
# On macOS, building MSI is not supported because it requires 32-bit Wine for WiX.
# Therefore, on macOS we compile DMG, AppImage, NSIS (.exe), and ZIP, skipping MSI.
if [[ "$OSTYPE" == "darwin"* ]]; then
  echo "Building on macOS. Skipping MSI build since Wine 32-bit is not supported on macOS Catalina+."
  npx electron-builder -m dmg -l AppImage -w nsis zip
else
  npx electron-builder -mwl
fi

# Find and copy macOS DMG
DMG_FILE=$(find dist -maxdepth 1 -name "*.dmg" ! -name "*.blockmap" | head -n 1)
if [ -n "$DMG_FILE" ]; then
  cp "$DMG_FILE" "release/${APP_NAME}-mac-${VERSION}.dmg"
  echo "Organized: $(basename "$DMG_FILE") -> release/${APP_NAME}-mac-${VERSION}.dmg"
else
  echo "Warning: No macOS DMG file found."
fi

# Find and copy Linux AppImage
APPIMAGE_FILE=$(find dist -maxdepth 1 -name "*.AppImage" ! -name "*.blockmap" | head -n 1)
if [ -n "$APPIMAGE_FILE" ]; then
  cp "$APPIMAGE_FILE" "release/${APP_NAME}-linux-${VERSION}.AppImage"
  echo "Organized: $(basename "$APPIMAGE_FILE") -> release/${APP_NAME}-linux-${VERSION}.AppImage"
else
  echo "Warning: No Linux AppImage file found."
fi

# Find and copy Windows Setup EXE
EXE_FILE=$(find dist -maxdepth 1 -name "*Setup*.exe" ! -name "*.blockmap" | head -n 1)
if [ -n "$EXE_FILE" ]; then
  cp "$EXE_FILE" "release/${APP_NAME}-windows-${VERSION}.exe"
  echo "Organized: $(basename "$EXE_FILE") -> release/${APP_NAME}-windows-${VERSION}.exe"
else
  echo "Warning: No Windows Setup EXE file found."
fi

# Find and copy Windows MSI
MSI_FILE=$(find dist -maxdepth 1 -name "*.msi" ! -name "*.blockmap" | head -n 1)
if [ -n "$MSI_FILE" ]; then
  cp "$MSI_FILE" "release/${APP_NAME}-windows-${VERSION}.msi"
  echo "Organized: $(basename "$MSI_FILE") -> release/${APP_NAME}-windows-${VERSION}.msi"
else
  echo "Warning: No Windows MSI file found."
fi

# Find and copy Windows ZIP
ZIP_FILE=$(find dist -maxdepth 1 -name "*.zip" ! -name "*.blockmap" | head -n 1)
if [ -n "$ZIP_FILE" ]; then
  cp "$ZIP_FILE" "release/${APP_NAME}-windows-${VERSION}.zip"
  echo "Organized: $(basename "$ZIP_FILE") -> release/${APP_NAME}-windows-${VERSION}.zip"
else
  echo "Warning: No Windows ZIP file found."
fi

echo "All releases organized successfully under the 'release/' folder!"
ls -la release/
