# TeamAPI

TeamAPI is a visually premium, modern, file-system-based HTTP API testing client. It is designed to run locally, loading and saving request collections directly as human-readable JSON files, allowing developers to use their own external version control tools (like Git, Mercurial, or folder sync services) without proprietary vendor lock-in.

---

## 🚀 Key Features

*   **📂 Pure File-System Sync**: No cloud sync dependencies or internal databases. Directories are scanned and updated in real-time, allowing you to edit collections with your favorite tools.
*   **⚠️ Git Conflict Helper**: If a JSON file contains Git merge conflict markers (`<<<<<<< HEAD`), TeamAPI flags the conflict in the sidebar list with a warning label and displays an interactive conflict resolution panel inside the Request Editor.
*   **📋 Persistent Error Toasts**: Built for debuggability. Connection, parse, and validation errors are persistent (no auto-dismissing) and come with an explicit copy button (`📋`) and clipboard interface so logs are easily copy-pasteable.
*   **☕ Multi-Language Snippet Generator**: Instantly generate HTTP request snippets for multiple languages, including native Java 11+ `java.net.http.HttpClient` blocks, Python, JavaScript, and shell commands.
*   **📦 Cross-Platform Packaging**: Build scripts to package native executable builds for macOS, Linux, and Windows.

---

## 🛠️ Getting Started

### Prerequisites
*   [Node.js](https://nodejs.org) (v18 or higher recommended)
*   npm (installed automatically with Node.js)

### Installation
Clone the repository and install the project dependencies:
```bash
git clone https://github.com/<your-username>/team-api.git
cd team-api
npm install
```

### Run Locally (Development)
To start the Electron application in development mode:
```bash
npm start
```

---

## 📦 Building Releases

TeamAPI uses `electron-builder` to compile native binaries for macOS, Linux, and Windows.

To trigger the clean packaging workflow:
```bash
./release.sh
```

### Output Formats Organized by `./release.sh`:
*   🍏 **macOS**: DMG installer (`release/team-api-mac-1.0.0.dmg`)
*   🐧 **Linux**: AppImage bundle (`release/team-api-linux-1.0.0.AppImage`)
*   🪟 **Windows NSIS Installer**: Setup EXE (`release/team-api-windows-1.0.0.exe`)
*   🪟 **Windows Portable**: ZIP archive (`release/team-api-windows-1.0.0.zip`)
*   🪟 **Windows MSI**: Installer package (`release/team-api-windows-1.0.0.msi` - *compiles when build is executed on Windows platforms*)

> [!NOTE]
> The `./release.sh` script automatically detects your operating system. When run on macOS, it skips the `.msi` build target to bypass the 32-bit Wine requirement of the WiX toolset, preventing compilation errors.
