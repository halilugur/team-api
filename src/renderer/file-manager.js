// TeamFolder — workspace file/folder manager (runs in its own BrowserWindow).
// All filesystem access goes through window.teamapi.files (IPC to the main
// process), which confines every operation to inside the workspace.

const api = window.teamapi.files;
let workspace = null;        // { path, name }
let selected = null;         // currently selected node: { name, path, type }
let expanded = new Set();    // absolute folder paths that are expanded
let currentFile = null;      // { path, binary, original } — file loaded in the editor

// ---------- small helpers ----------

// Cross-platform dirname (renderer has no node 'path' module).
function dirname(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(0, i) : p;
}

function basename(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
}

// Workspace-relative display path for the breadcrumb.
function relPath(p) {
  if (!workspace) return p;
  if (p === workspace.path) return workspace.name;
  return p.startsWith(workspace.path + '/') || p.startsWith(workspace.path + '\\')
    ? workspace.name + ' / ' + p.slice(workspace.path.length + 1).replace(/[\\/]+/g, ' / ')
    : p;
}

// Toast — local copy of the main window's helper (separate page, same CSS).
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  const textSpan = document.createElement('span');
  textSpan.style.flex = '1';
  textSpan.textContent = message;
  toast.appendChild(textSpan);
  if (type === 'error' || type === 'warning') {
    const btnClose = document.createElement('span');
    btnClose.innerHTML = '✕';
    btnClose.style.cursor = 'pointer';
    btnClose.style.marginLeft = '8px';
    btnClose.title = 'Close';
    btnClose.onclick = (e) => { e.stopPropagation(); toast.remove(); };
    toast.appendChild(btnClose);
  }
  container.appendChild(toast);
  if (type !== 'error' && type !== 'warning') {
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 200);
    }, 3000);
  }
}

// Electron doesn't support window.prompt(), so we render a tiny modal that
// resolves with the entered value (or null on cancel).
function customPrompt(message, defaultValue = '') {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'fm-modal-overlay';
    const modal = document.createElement('div');
    modal.className = 'fm-modal';
    const title = document.createElement('div');
    title.className = 'fm-modal-title';
    title.textContent = message;
    const input = document.createElement('input');
    input.className = 'fm-modal-input';
    input.type = 'text';
    input.value = defaultValue;
    const actions = document.createElement('div');
    actions.className = 'fm-modal-actions';
    const btnCancel = document.createElement('button');
    btnCancel.className = 'fm-btn fm-btn-sm';
    btnCancel.textContent = 'Cancel';
    const btnOk = document.createElement('button');
    btnOk.className = 'fm-btn fm-btn-sm fm-btn-primary';
    btnOk.textContent = 'OK';
    actions.appendChild(btnCancel);
    actions.appendChild(btnOk);
    modal.appendChild(title);
    modal.appendChild(input);
    modal.appendChild(actions);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const close = (val) => { overlay.remove(); resolve(val); };
    btnCancel.onclick = () => close(null);
    btnOk.onclick = () => close(input.value);
    input.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); close(input.value); }
      else if (e.key === 'Escape') { e.preventDefault(); close(null); }
    };
    overlay.onclick = (e) => { if (e.target === overlay) close(null); };
    setTimeout(() => { input.focus(); input.select(); }, 0);
  });
}

// ---------- tree rendering ----------

function nodeIcon(type, isOpen = false) {
  if (type === 'dir') {
    if (isOpen) {
      return `<svg class="fm-ic folder-icon folder-open" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path><path d="M2 10h20"></path></svg>`;
    }
    return `<svg class="fm-ic folder-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`;
  }
  return `<svg class="fm-ic file-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>`;
}

function twisty(isOpen) {
  return `<svg class="fm-twisty${isOpen ? ' fm-twisty-open' : ''}" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>`;
}

function renderNodes(nodes, depth, container) {
  for (const node of nodes) {
    const row = document.createElement('div');
    row.className = 'fm-node';
    row.dataset.path = node.path;
    row.dataset.type = node.type;

    if (node.type === 'dir') {
      const folderNode = document.createElement('div');
      folderNode.className = 'fm-folder-node';

      const isOpen = expanded.has(node.path);
      row.innerHTML = `${twisty(isOpen)}${nodeIcon('dir', isOpen)}<span class="fm-node-name">${node.name}</span>`;
      folderNode.appendChild(row);

      row.onclick = (e) => {
        e.stopPropagation();
        if (expanded.has(node.path)) expanded.delete(node.path);
        else expanded.add(node.path);
        selectNode(node);
        renderTree();
      };

      if (isOpen) {
        const childWrap = document.createElement('div');
        childWrap.className = 'fm-tree-branch tree-node';
        if (node.children && node.children.length) {
          renderNodes(node.children, depth + 1, childWrap);
        } else {
          const empty = document.createElement('div');
          empty.className = 'fm-node fm-node-empty';
          empty.textContent = 'empty';
          childWrap.appendChild(empty);
        }
        folderNode.appendChild(childWrap);
      }
      container.appendChild(folderNode);
    } else {
      row.innerHTML = `<span class="fm-twisty-spacer"></span>${nodeIcon('file')}<span class="fm-node-name">${node.name}</span>`;
      container.appendChild(row);
      row.onclick = (e) => {
        e.stopPropagation();
        selectNode(node);
      };
      row.ondblclick = () => openExternal(node.path, false);
    }

    if (selected && selected.path === node.path) row.classList.add('fm-selected');
  }
}

async function renderTree() {
  const treeEl = document.getElementById('fmTree');
  if (!workspace) return;
  treeEl.innerHTML = '';
  let nodes = [];
  try {
    nodes = await api.listTree();
  } catch (err) {
    showToast('Failed to read folder: ' + err.message, 'error');
    return;
  }
  if (!nodes.length) {
    const empty = document.createElement('div');
    empty.className = 'fm-node fm-node-empty';
    empty.style.paddingLeft = '8px';
    empty.textContent = 'This workspace folder is empty';
    treeEl.appendChild(empty);
    return;
  }
  renderNodes(nodes, 0, treeEl);
  updateBreadcrumb();
}

// ---------- selection ----------

function selectNode(node) {
  selected = node;
  document.querySelectorAll('.fm-node.fm-selected').forEach((el) => el.classList.remove('fm-selected'));
  document.querySelectorAll(`.fm-node[data-path="${cssEscape(node.path)}"]`).forEach((el) => el.classList.add('fm-selected'));
  // Enable the per-node toolbar actions (the workspace root itself can't be
  // renamed/deleted — but the root is never a tree node here, so it's safe).
  document.getElementById('fmRename').disabled = false;
  document.getElementById('fmDelete').disabled = false;
  if (node.type === 'file') {
    openFile(node);
  } else {
    clearEditor();
    setEditorPath(relPath(node.path) + '  (folder)');
  }
  updateBreadcrumb();
}

function cssEscape(s) {
  return String(s).replace(/["\\]/g, '\\$&');
}

function updateBreadcrumb() {
  const el = document.getElementById('fmBreadcrumb');
  if (!el) return;
  el.textContent = selected ? relPath(selected.path) : (workspace ? workspace.name : '');
}

// ---------- editor ----------

function clearEditor() {
  currentFile = null;
  const editor = document.getElementById('fmEditor');
  editor.value = '';
  editor.disabled = true;
  document.getElementById('fmEditorPath').textContent = 'Select a file to view or edit';
  document.getElementById('fmSave').disabled = true;
  document.getElementById('fmOpenExternal').disabled = true;
  document.getElementById('fmReveal').disabled = true;
  document.getElementById('fmEditorFooter').textContent = '';
}

function setEditorPath(text) {
  document.getElementById('fmEditorPath').textContent = text;
}

async function openFile(node) {
  try {
    const res = await api.read({ path: node.path });
    const editor = document.getElementById('fmEditor');
    currentFile = { path: node.path, binary: !!res.binary, original: res.content };
    setEditorPath(relPath(node.path) + (res.binary ? '  (binary)' : ''));
    document.getElementById('fmEditorFooter').textContent = res.binary ? 'Binary file — editing disabled. Use Open to launch in the system app.' : (formatSize(res.size));
    if (res.binary) {
      editor.value = '';
      editor.disabled = true;
      editor.placeholder = 'Binary file — cannot edit text';
    } else {
      editor.value = res.content || '';
      editor.disabled = false;
      editor.placeholder = '';
    }
    document.getElementById('fmSave').disabled = true;
    document.getElementById('fmOpenExternal').disabled = false;
    document.getElementById('fmReveal').disabled = false;
  } catch (err) {
    showToast('Failed to open file: ' + err.message, 'error');
    clearEditor();
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

async function saveFile() {
  if (!currentFile || currentFile.binary) return;
  const editor = document.getElementById('fmEditor');
  try {
    await api.write({ path: currentFile.path, content: editor.value });
    currentFile.original = editor.value;
    document.getElementById('fmSave').disabled = true;
    showToast('Saved', 'success');
  } catch (err) {
    showToast('Save failed: ' + err.message, 'error');
  }
}

// ---------- mutations ----------

// Where new files/folders are created: inside the selected folder, or the
// parent folder of a selected file, or the workspace root.
function targetParentPath() {
  if (!selected) return workspace.path;
  if (selected.type === 'dir') return selected.path;
  return dirname(selected.path);
}

async function createNode(type) {
  const name = await customPrompt(type === 'dir' ? 'New folder name:' : 'New file name:', '');
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed) { showToast('Name cannot be empty', 'warning'); return; }
  const parent = targetParentPath();
  try {
    await api.create({ parentPath: parent, name: trimmed, type });
    expanded.add(parent);
    showToast((type === 'dir' ? 'Folder' : 'File') + ' created', 'success');
    await renderTree();
  } catch (err) {
    showToast('Create failed: ' + err.message, 'error');
  }
}

async function renameNode() {
  if (!selected) return;
  const newName = await customPrompt('Rename to:', selected.name);
  if (newName === null) return;
  const trimmed = newName.trim();
  if (!trimmed || trimmed === selected.name) return;
  try {
    const res = await api.rename({ path: selected.path, newName: trimmed });
    const wasCurrent = currentFile && currentFile.path === selected.path;
    selected = { name: res.name, path: res.path, type: selected.type };
    if (wasCurrent) {
      currentFile.path = res.path;
      setEditorPath(relPath(res.path) + (currentFile.binary ? '  (binary)' : ''));
    }
    showToast('Renamed', 'success');
    await renderTree();
  } catch (err) {
    showToast('Rename failed: ' + err.message, 'error');
  }
}

async function deleteNode() {
  if (!selected) return;
  const label = selected.type === 'dir' ? 'folder' : 'file';
  // confirm() is supported by Electron (prompt() is not).
  if (!confirm(`Delete the ${label} "${selected.name}"?\n${selected.type === 'dir' ? 'This will remove everything inside it.' : 'This cannot be undone.'}`)) return;
  const target = selected;
  try {
    await api.delete({ path: target.path });
    if (currentFile && currentFile.path === target.path) clearEditor();
    if (selected && selected.path === target.path) selected = null;
    document.getElementById('fmRename').disabled = true;
    document.getElementById('fmDelete').disabled = true;
    showToast('Deleted', 'success');
    await renderTree();
  } catch (err) {
    showToast('Delete failed: ' + err.message, 'error');
  }
}

async function openExternal(path, reveal) {
  try {
    await api.openExternal({ path, reveal });
  } catch (err) {
    showToast('Open failed: ' + err.message, 'error');
  }
}

// ---------- init ----------

async function init() {
  const editor = document.getElementById('fmEditor');
  editor.addEventListener('input', () => {
    if (!currentFile || currentFile.binary) return;
    document.getElementById('fmSave').disabled = (editor.value === currentFile.original);
  });

  document.getElementById('fmNewFile').onclick = () => createNode('file');
  document.getElementById('fmNewFolder').onclick = () => createNode('dir');
  document.getElementById('fmRename').onclick = () => renameNode();
  document.getElementById('fmDelete').onclick = () => deleteNode();
  document.getElementById('fmRefresh').onclick = () => renderTree();
  document.getElementById('fmSave').onclick = () => saveFile();
  document.getElementById('fmOpenExternal').onclick = () => { if (currentFile) openExternal(currentFile.path, false); };
  document.getElementById('fmReveal').onclick = () => { if (currentFile) openExternal(currentFile.path, true); };

  // Editor: keep the breadcrumb in sync with the selected node.
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      if (!document.getElementById('fmSave').disabled) saveFile();
    }
    if (e.key === 'Delete' && selected && !document.getElementById('fmDelete').disabled) {
      deleteNode();
    }
  });

  try {
    workspace = await api.getWorkspace();
  } catch (err) {
    workspace = null;
  }

  if (!workspace) {
    document.getElementById('fmNoWorkspace').style.display = 'flex';
    document.getElementById('fmApp').style.display = 'none';
    return;
  }

  document.title = 'TeamFolder — ' + workspace.name;
  document.getElementById('fmTitle').textContent = 'TeamFolder — ' + workspace.name;
  document.getElementById('fmApp').style.display = 'flex';
  document.getElementById('fmNoWorkspace').style.display = 'none';
  await renderTree();
}

document.addEventListener('DOMContentLoaded', init);
