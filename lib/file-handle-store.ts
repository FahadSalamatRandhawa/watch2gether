// IndexedDB helper for persisting FileSystemFileHandles across reloads.
// FileSystemFileHandles are the only way to keep a reference to a user's
// local file across page loads — they can't be JSON-serialized to localStorage,
// but IndexedDB can store them as structured-cloned objects.

const DB_NAME = 'w2g-handles';
const STORE = 'handles';
const VERSION = 1;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveHandle(key: string, handle: FileSystemFileHandle): Promise<void> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(handle, key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

export async function loadHandle(key: string): Promise<FileSystemFileHandle | null> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => { db.close(); resolve((req.result as FileSystemFileHandle) ?? null); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

export async function clearHandle(key: string): Promise<void> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

export function hasFileSystemAccess(): boolean {
  return typeof window !== 'undefined' && 'showOpenFilePicker' in window;
}

type FilePickerOpts = { types?: { description: string; accept: Record<string, string[]> }[]; multiple?: boolean };

declare global {
  interface Window {
    showOpenFilePicker?: (opts?: FilePickerOpts) => Promise<FileSystemFileHandle[]>;
  }
  // FileSystem Access API permission methods aren't in standard lib.dom yet.
  interface FileSystemFileHandle {
    requestPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<'granted' | 'denied' | 'prompt'>;
    queryPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<'granted' | 'denied' | 'prompt'>;
  }
}

export async function pickVideoFile(): Promise<{ file: File; handle: FileSystemFileHandle | null }> {
  if (window.showOpenFilePicker) {
    const [handle] = await window.showOpenFilePicker({
      types: [{
        description: 'Video',
        accept: { 'video/*': ['.mp4', '.webm', '.mkv', '.mov', '.m4v'] },
      }],
      multiple: false,
    });
    const file = await handle.getFile();
    return { file, handle };
  }
  // Fallback: trigger a hidden <input type=file>
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'video/*';
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) { reject(new Error('no file selected')); return; }
      resolve({ file: f, handle: null });
    };
    input.oncancel = () => reject(new Error('cancelled'));
    input.click();
  });
}
