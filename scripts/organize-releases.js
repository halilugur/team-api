const fs = require('fs');
const path = require('path');
const pkg = require('../package.json');

const appName = pkg.name; // "team-api"
const version = pkg.version; // "1.0.0"

const releaseDir = path.join(__dirname, '../release');
const distDir = path.join(__dirname, '../dist');

// Recreate clean release folder
if (fs.existsSync(releaseDir)) {
  fs.rmSync(releaseDir, { recursive: true, force: true });
}
fs.mkdirSync(releaseDir);

console.log('Organizing and renaming build artifacts...');

const files = fs.readdirSync(distDir);

// Find and copy macOS DMG
const dmgFile = files.find(f => f.endsWith('.dmg') && !f.endsWith('.blockmap'));
if (dmgFile) {
  const src = path.join(distDir, dmgFile);
  const dest = path.join(releaseDir, `${appName}-mac-${version}.dmg`);
  fs.copyFileSync(src, dest);
  console.log(`Copied: ${dmgFile} -> ${path.basename(dest)}`);
} else {
  console.warn('Warning: No macOS DMG file found in dist/');
}

// Find and copy Linux AppImage
const appImageFile = files.find(f => f.endsWith('.AppImage') && !f.endsWith('.blockmap'));
if (appImageFile) {
  const src = path.join(distDir, appImageFile);
  const dest = path.join(releaseDir, `${appName}-linux-${version}.AppImage`);
  fs.copyFileSync(src, dest);
  console.log(`Copied: ${appImageFile} -> ${path.basename(dest)}`);
} else {
  console.warn('Warning: No Linux AppImage file found in dist/');
}

// Find and copy Windows Installer EXE
const exeFile = files.find(f => f.endsWith('.exe') && !f.endsWith('.blockmap') && f.includes('Setup'));
if (exeFile) {
  const src = path.join(distDir, exeFile);
  const dest = path.join(releaseDir, `${appName}-windows-${version}.exe`);
  fs.copyFileSync(src, dest);
  console.log(`Copied: ${exeFile} -> ${path.basename(dest)}`);
} else {
  console.warn('Warning: No Windows Setup EXE file found in dist/');
}

// Find and copy Windows MSI
const msiFile = files.find(f => f.endsWith('.msi') && !f.endsWith('.blockmap'));
if (msiFile) {
  const src = path.join(distDir, msiFile);
  const dest = path.join(releaseDir, `${appName}-windows-${version}.msi`);
  fs.copyFileSync(src, dest);
  console.log(`Copied: ${msiFile} -> ${path.basename(dest)}`);
} else {
  console.warn('Warning: No Windows MSI file found in dist/');
}

// Find and copy Windows ZIP
const zipFile = files.find(f => f.endsWith('.zip') && !f.endsWith('.blockmap') && f.includes('win'));
if (zipFile) {
  const src = path.join(distDir, zipFile);
  const dest = path.join(releaseDir, `${appName}-windows-${version}.zip`);
  fs.copyFileSync(src, dest);
  console.log(`Copied: ${zipFile} -> ${path.basename(dest)}`);
} else {
  console.warn('Warning: No Windows ZIP file found in dist/');
}

console.log('Releases organized successfully!');
