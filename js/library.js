/* The shelf: books the reader has been given, and where you were in each.
 *
 * iOS gives a web app no filesystem. What it does give is a file picker that
 * reaches into Dropbox, Synology Drive and iCloud alike, and IndexedDB to keep
 * what comes back. So a book is imported once -- copied into the database --
 * and afterwards opens with no network and no cloud app involved.
 *
 * Blobs are stored rather than ArrayBuffers: Safari keeps a Blob on disk and
 * only reads it when asked, so a shelf of several hundred megabytes does not
 * have to be resident to list it.
 */

'use strict';

const DB_NAME = 'epub-reader';
const DB_VERSION = 1;

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export class Library {
  constructor(db) {
    this.db = db;
  }

  static open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('books')) {
          db.createObjectStore('books', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('files')) {
          db.createObjectStore('files');       // id -> Blob
        }
        if (!db.objectStoreNames.contains('kv')) {
          db.createObjectStore('kv');          // settings, background image
        }
      };
      request.onsuccess = () => resolve(new Library(request.result));
      request.onerror = () => reject(request.error);
    });
  }

  _tx(stores, mode) {
    return this.db.transaction(stores, mode);
  }

  _done(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  // -- books ---------------------------------------------------------------

  /** Newest first, but anything opened recently floats to the top. */
  async list() {
    const tx = this._tx(['books'], 'readonly');
    const all = await promisify(tx.objectStore('books').getAll());
    all.sort((a, b) => (b.openedAt || b.addedAt || 0) - (a.openedAt || a.addedAt || 0));
    return all;
  }

  get(id) {
    return promisify(this._tx(['books'], 'readonly').objectStore('books').get(id));
  }

  fileFor(id) {
    return promisify(this._tx(['files'], 'readonly').objectStore('files').get(id));
  }

  /* Name and size together: the same book picked twice from the same cloud
     folder should land on the shelf once, and hashing the bytes would mean
     reading every megabyte back just to find that out. */
  static idFor(file) {
    const name = file.name || 'book.epub';
    return `${name}:${file.size}`;
  }

  async has(id) {
    return (await this.get(id)) !== undefined;
  }

  async add(file, meta) {
    const id = Library.idFor(file);
    const record = Object.assign({
      id,
      fileName: file.name || '',
      size: file.size,
      addedAt: Date.now(),
      openedAt: 0,
      position: null,
    }, meta);

    const tx = this._tx(['books', 'files'], 'readwrite');
    tx.objectStore('books').put(record);
    tx.objectStore('files').put(file, id);
    await this._done(tx);
    return record;
  }

  async remove(id) {
    const tx = this._tx(['books', 'files'], 'readwrite');
    tx.objectStore('books').delete(id);
    tx.objectStore('files').delete(id);
    await this._done(tx);
  }

  /** Remember the page, without rewriting the cover blob each time. */
  async savePosition(id, position) {
    const tx = this._tx(['books'], 'readwrite');
    const store = tx.objectStore('books');
    const record = await promisify(store.get(id));
    if (!record) return;
    record.position = position;
    record.openedAt = Date.now();
    store.put(record);
    await this._done(tx);
  }

  // -- odds and ends --------------------------------------------------------

  getValue(key) {
    return promisify(this._tx(['kv'], 'readonly').objectStore('kv').get(key));
  }

  async setValue(key, value) {
    const tx = this._tx(['kv'], 'readwrite');
    if (value === undefined || value === null) tx.objectStore('kv').delete(key);
    else tx.objectStore('kv').put(value, key);
    await this._done(tx);
  }

  /** How much space the shelf takes, for the settings screen. */
  async usage() {
    if (!navigator.storage || !navigator.storage.estimate) return null;
    try {
      return await navigator.storage.estimate();
    } catch {
      return null;
    }
  }
}
