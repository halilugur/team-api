# TeamAPI

TeamAPI is a visually premium, file-system-based HTTP API testing client built on Electron. It runs entirely locally — collections and environments are stored as plain JSON files on disk, so any external tool (editors, sync services, scripts) can read and modify them freely. No cloud, no vendor lock-in, no proprietary database.

---

## 🚀 Key Features

*   **📂 File-System Collections**: Request collections are stored as human-readable `.json` files in a workspace directory. Open, edit, or copy them with any tool you like.
*   **🔑 Multiple Auth Types**: Supports No Auth, Bearer Token, Basic Auth, and API Key header authentication — configurable per request.
*   **📝 Pre & Post Scripts**: Execute sandboxed JavaScript before a request (to set headers or timestamps) and after (to extract values from the response). Uses a `pm` API modelled after Postman's scripting interface.
*   **🌍 Environment Variables**: Create and switch between named environments with key-value variable sets. Use `{{variableName}}` syntax anywhere — URL, headers, body, auth fields.
*   **👁️ Live Variable Preview**: While typing in any input, a tooltip previews the resolved value of `{{variable}}` references in real time.
*   **🔁 URL ↔ Params Sync**: Query parameters in the URL bar and the Params tab stay in sync automatically as you type.
*   **📋 Persistent Error Toasts**: Errors are persistent (no auto-dismissing) and include a copy button so logs are easy to share.
*   **🔍 Response Search**: Full-text search within the response body with highlighted matches and next/previous navigation.
*   **💻 Multi-Language Snippet Generator**: Generate ready-to-use HTTP request code for cURL, Fetch, Axios, Python Requests, Go, and Java `HttpClient`.
*   **📜 Request History**: Every executed request is logged in a sidebar history list for quick reference.
*   **🗂️ Folders in Collections**: Organise requests inside named folders within a collection.
*   **🖱️ Context Menus**: Right-click collections, folders, and requests to rename, duplicate, or delete them.
*   **📦 Cross-Platform Packaging**: Native builds for macOS (DMG), Linux (AppImage), and Windows (NSIS / MSI / ZIP).

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
```bash
npm start
```

---

## 📂 Workspace Structure

When you open or create a workspace, TeamAPI expects (and will create if missing) the following layout:

```
my-workspace/
├── collections/        # One JSON file per collection
├── environments/       # One JSON file per environment
└── .teamapi/
    ├── meta.json       # Workspace name and version
    └── history.json    # Recent request history (last 100)
```

All files are plain JSON and can be edited externally at any time.

---

## 📦 Building Releases

TeamAPI uses `electron-builder` to compile native binaries.

```bash
./release.sh
```

### Output formats:
*   🍏 **macOS**: DMG installer (`release/team-api-mac-1.0.0.dmg`)
*   🐧 **Linux**: AppImage bundle (`release/team-api-linux-1.0.0.AppImage`)
*   🪟 **Windows NSIS**: Setup EXE (`release/team-api-windows-1.0.0.exe`)
*   🪟 **Windows Portable**: ZIP archive (`release/team-api-windows-1.0.0.zip`)
*   🪟 **Windows MSI**: Installer package (`release/team-api-windows-1.0.0.msi` — *Windows build environment only*)

> [!NOTE]
> The `./release.sh` script automatically detects your operating system. When run on macOS, it skips the `.msi` build target to bypass the 32-bit Wine requirement of the WiX toolset, preventing compilation errors.
