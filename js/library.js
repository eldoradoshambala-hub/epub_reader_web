/* The shelf: books the reader has been given, how they are arranged, and where
 * you were in each.
 *
 * iOS gives a web app no filesystem. What it does give is a file picker that
 * reaches into Dropbox, Synology Drive and iCloud alike, and IndexedDB to keep
 * what comes back. So a book is imported once -- copied into the database --
 * and afterwards opens with no network and no cloud app involved.
 *
 * Four stores rather than one, and the split matters: the record of a book is
 * small and gets rewritten constantly (every page turn moves the reading
 * position), while its cover and its bytes are large and never change. Keeping
 * them together meant rewriting a picture to save a page number, and WebKit
 * can lose a Blob that is read out of IndexedDB and written straight back --
 * which is why the cover of the book you were reading, and only that one,
 * would quietly disappear.
 */

'use strict';

const DB_NAME = 'epub-reader';
const DB_VERSION = 2;

export const GENRES = [
  ['novel', '小説'],
  ['manga', '漫画'],
  ['other', 'その他'],
];

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
      request.onupgradeneeded = (event) => {
        const db = request.result;
        const tx = request.transaction;
        if (!db.objectStoreNames.contains('books')) {
          db.createObjectStore('books', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('covers')) db.createObjectStore('covers');
        if (!db.objectStoreNames.contains('positions')) db.createObjectStore('positions');
        if (!db.objectStoreNames.contains('folders')) {
          db.createObjectStore('folders', { keyPath: 'id' });
        }

        // Version 1 kept the cover and the position inside the book record.
        if (event.oldVersion < 2) {
          const books = tx.objectStore('books');
          const covers = tx.objectStore('covers');
          const positions = tx.objectStore('positions');
          books.openCursor().onsuccess = (e) => {
            const cursor = e.target.result;
            if (!cursor) return;
            const record = cursor.value;
            if (record.cover) {
              covers.put(record.cover, record.id);
              delete record.cover;
            }
            if (record.position) {
              positions.put(record.position, record.id);
              delete record.position;
            }
            if (record.genre === undefined) record.genre = 'other';
            if (record.folderId === undefined) record.folderId = null;
            if (record.order === undefined) record.order = record.addedAt || 0;
            cursor.update(record);
            cursor.continue();
          };
        }
      };
      request.onsuccess = () => resolve(new Library(request.result));
      request.onerror = () => reject(request.error);
    });
  }

  _done(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  // -- books ---------------------------------------------------------------

  /** Every book, in the order the shelf shows them. */
  async list() {
    const tx = this.db.transaction(['books'], 'readonly');
    const all = await promisify(tx.objectStore('books').getAll());
    all.sort((a, b) => (a.order || 0) - (b.order || 0));
    return all;
  }

  get(id) {
    return promisify(this.db.transaction(['books'], 'readonly').objectStore('books').get(id));
  }

  fileFor(id) {
    return promisify(this.db.transaction(['files'], 'readonly').objectStore('files').get(id));
  }

  coverFor(id) {
    return promisify(this.db.transaction(['covers'], 'readonly').objectStore('covers').get(id));
  }

  /** Every cover in one transaction: the shelf needs them all at once. */
  async covers() {
    const store = this.db.transaction(['covers'], 'readonly').objectStore('covers');
    const [keys, values] = await Promise.all([
      promisify(store.getAllKeys()),
      promisify(store.getAll()),
    ]);
    return new Map(keys.map((key, i) => [key, values[i]]));
  }

  positionFor(id) {
    return promisify(this.db.transaction(['positions'], 'readonly').objectStore('positions').get(id));
  }

  /* Name and size together: the same book picked twice from the same cloud
     folder should land on the shelf once, and hashing the bytes would mean
     reading every megabyte back just to find that out. */
  static idFor(file) {
    return `${file.name || 'book.epub'}:${file.size}`;
  }

  async add(file, meta, { folderId = null } = {}) {
    const id = Library.idFor(file);
    const cover = meta.cover || null;
    const existing = await this.get(id);
    const last = await this.lastOrder();

    const record = {
      id,
      fileName: file.name || '',
      size: file.size,
      title: meta.title || '',
      creator: meta.creator || '',
      genre: meta.genre || 'other',
      folderId: existing ? existing.folderId : folderId,
      order: existing ? existing.order : last + 1,
      addedAt: existing ? existing.addedAt : Date.now(),
      openedAt: existing ? existing.openedAt : 0,
    };

    const tx = this.db.transaction(['books', 'files', 'covers'], 'readwrite');
    tx.objectStore('books').put(record);
    tx.objectStore('files').put(file, id);
    if (cover) tx.objectStore('covers').put(cover, id);
    await this._done(tx);
    return record;
  }

  async lastOrder() {
    const books = await this.list();
    return books.length ? books[books.length - 1].order || 0 : 0;
  }

  async remove(id) {
    const tx = this.db.transaction(
      ['books', 'files', 'covers', 'positions'], 'readwrite'
    );
    for (const name of ['books', 'files', 'covers', 'positions']) {
      tx.objectStore(name).delete(id);
    }
    await this._done(tx);
  }

  /** Change the small fields -- genre, folder, order, title. Never the blobs. */
  async update(id, changes) {
    const tx = this.db.transaction(['books'], 'readwrite');
    const store = tx.objectStore('books');
    const record = await promisify(store.get(id));
    if (record) store.put(Object.assign(record, changes));
    await this._done(tx);
  }

  /** Write the whole order at once, after a move. */
  async reorder(ids) {
    const tx = this.db.transaction(['books'], 'readwrite');
    const store = tx.objectStore('books');
    for (let i = 0; i < ids.length; i++) {
      const record = await promisify(store.get(ids[i]));
      if (record) { record.order = i; store.put(record); }
    }
    await this._done(tx);
  }

  /* Kept apart from the book record on purpose: this is written every few
     seconds while reading, and it must never touch the cover. */
  async savePosition(id, position) {
    const tx = this.db.transaction(['positions', 'books'], 'readwrite');
    tx.objectStore('positions').put(position, id);
    const books = tx.objectStore('books');
    const record = await promisify(books.get(id));
    if (record) { record.openedAt = Date.now(); books.put(record); }
    await this._done(tx);
  }

  // -- folders --------------------------------------------------------------

  async folders() {
    const tx = this.db.transaction(['folders'], 'readonly');
    const all = await promisify(tx.objectStore('folders').getAll());
    all.sort((a, b) => (a.order || 0) - (b.order || 0));
    return all;
  }

  async addFolder(name, parentId = null) {
    const folders = await this.folders();
    const record = {
      id: `f${Date.now()}${Math.floor(Math.random() * 1000)}`,
      name,
      parentId,
      order: folders.length,
    };
    const tx = this.db.transaction(['folders'], 'readwrite');
    tx.objectStore('folders').put(record);
    await this._done(tx);
    return record;
  }

  async renameFolder(id, name) {
    const tx = this.db.transaction(['folders'], 'readwrite');
    const store = tx.objectStore('folders');
    const record = await promisify(store.get(id));
    if (record) { record.name = name; store.put(record); }
    await this._done(tx);
  }

  /** Remove a folder; its books and sub-folders move up to where it was. */
  async removeFolder(id) {
    const folder = await promisify(
      this.db.transaction(['folders'], 'readonly').objectStore('folders').get(id)
    );
    const parent = folder ? folder.parentId : null;

    const tx = this.db.transaction(['folders', 'books'], 'readwrite');
    const folders = tx.objectStore('folders');
    const books = tx.objectStore('books');
    folders.delete(id);
    for (const child of await promisify(folders.getAll())) {
      if (child.parentId === id) { child.parentId = parent; folders.put(child); }
    }
    for (const record of await promisify(books.getAll())) {
      if (record.folderId === id) { record.folderId = parent; books.put(record); }
    }
    await this._done(tx);
  }

  // -- odds and ends --------------------------------------------------------

  getValue(key) {
    return promisify(this.db.transaction(['kv'], 'readonly').objectStore('kv').get(key));
  }

  async setValue(key, value) {
    const tx = this.db.transaction(['kv'], 'readwrite');
    if (value === undefined || value === null) tx.objectStore('kv').delete(key);
    else tx.objectStore('kv').put(value, key);
    await this._done(tx);
  }

  async usage() {
    if (!navigator.storage || !navigator.storage.estimate) return null;
    try {
      return await navigator.storage.estimate();
    } catch {
      return null;
    }
  }
}
