// Run: node --test tests/regression.cjs (no dependencies or real Drive requests).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
function source(name) {
  const start = html.search(new RegExp(`        (?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  const end = html.indexOf('\n        }', start) + '\n        }'.length;
  return html.slice(start, end);
}
const functions = ['serializedByteSize', 'serializedFingerprint', 'makeCloudNotebookPayload',
  'getNotebookCloudUpdatedAt', 'getNotebookCloudFileName', 'makeCloudManifest',
  'normalizeCloudNotebook', 'validateCloudNotebook', 'readDeletedIds', 'mergeCloudNotebookIntoState',
  'ensureValidLibrarySelection', 'mergeCloudLibrary', 'driveFetch', 'listInkNoteCloudFiles',
  'newestCloudFileNamed', 'getCloudFilesTotalSize', 'downloadCloudJson', 'createCloudJsonFile',
  'uploadCloudJson', 'deleteCloudFile', 'renameCloudFile', 'runGoogleDriveSync',
  'waitForLibrarySync', 'syncWithGoogleDrive'];
function book(id = 'a', time = 10) {
  return { id, title: id, coverColor: '#315f72', updatedAt: 1,
    pages: [{ id: `${id}-page`, updatedAt: time, strokes: [], thumbnail: null, undoStack: [], redoStack: [] }] };
}
function fixture(books = [book()]) {
  const records = new Map(), calls = [];
  let sequence = 0;
  const api = { records, calls, hook: null };
  function add(name, content, id = `file-${++sequence}`) {
    records.set(id, { id, name, content: clone(content), version: '1', modifiedTime: '2026-09-11T00:00:00Z' });
    return metadata(records.get(id));
  }
  function metadata(file) {
    return { id: file.id, name: file.name, version: file.version, modifiedTime: file.modifiedTime,
      size: String(Buffer.byteLength(JSON.stringify(file.content))), quotaBytesUsed: String(Buffer.byteLength(JSON.stringify(file.content))) };
  }
  const context = vm.createContext({
    console, Blob, URL, URLSearchParams, setTimeout, clearTimeout,
    state: { notebooks: clone(books), currentNotebookId: books[0].id, currentPageId: books[0].pages[0].id,
      viewMode: 'home', get currentNotebook() { return this.notebooks.find(n => n.id === this.currentNotebookId); } },
    deletedNotebookIds: new Set(), deletedPageIds: new Set(),
    LEGACY_DRIVE_FILE_NAME: 'InkNote.backup.json', LEGACY_ARCHIVE_FILE_NAME: 'InkNote.backup.migrated.json',
    DRIVE_MANIFEST_FILE_NAME: 'InkNote.library.json', DRIVE_NOTEBOOK_FILE_PREFIX: 'InkNote.notebook.',
    API_KEY: 'mock', googleAccessToken: 'mock', cloudSyncInFlight: null, syncRequestedAgain: false, libraryLoadFailed: false,
    COVER_COLORS: ['#315f72'], makeId: () => `new-${++sequence}`, makePage: () => book(`new-${++sequence}`).pages[0],
    setCloudButtonState() {}, captureCurrentPageThumbnail() {}, saveLibraryNow() {}, renderHome() {},
    renderNotebook() {}, updateCloudStorageSummary() {}, scheduleAuthorizedAutoSync() {},
    fetch: async (url, options = {}) => {
      const u = new URL(url), method = options.method || 'GET';
      const id = u.pathname.split('/').pop();
      const request = { id, method, media: u.searchParams.get('alt') === 'media', body: options.body && JSON.parse(options.body), url: u };
      calls.push(request);
      if (api.hook) await api.hook(request);
      const response = (data, status = 200, version) => ({ ok: status >= 200 && status < 300, status,
        headers: { get: name => name === 'ETag' && version ? `"${version}"` : null }, json: async () => clone(data) });
      if (method === 'GET' && id === 'files') return response({ files: [...records.values()].map(metadata) });
      if (method === 'POST') return response(add(request.body.name, {}));
      const file = records.get(id);
      if (!file) return response({ error: { message: 'missing' } }, 404);
      if (method === 'GET') return response(request.media ? file.content : metadata(file), 200, file.version);
      if (method === 'DELETE') { records.delete(id); return response({}); }
      if (options.headers?.['If-Match'] && options.headers['If-Match'] !== `"${file.version}"`) return response({}, 412);
      if (u.pathname.startsWith('/upload/')) file.content = request.body;
      else file.name = request.body.name;
      file.version = String(Number(file.version) + 1);
      file.modifiedTime = '2026-09-11T01:00:00Z';
      return response(metadata(file));
    }
  });
  vm.runInContext(functions.map(source).join('\n'), context);
  function seed() {
    const files = new Map();
    for (const notebook of books) {
      const payload = context.makeCloudNotebookPayload(notebook);
      const file = add(context.getNotebookCloudFileName(notebook.id), payload, `note-${notebook.id}`);
      files.set(notebook.id, { ...file, payload });
    }
    add('InkNote.library.json', context.makeCloudManifest(files), 'library');
  }
  Object.assign(api, { context, add, seed, sync: () => context.syncWithGoogleDrive({ silent: true }),
    uploads: () => calls.filter(r => r.method === 'PATCH' && r.url.pathname.startsWith('/upload/')) });
  return api;
}

test('all inline JavaScript parses', () => {
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
});
test('unchanged notebooks have no body transfer', async () => {
  const f = fixture([book('a'), book('b')]); f.seed(); await f.sync();
  assert.deepEqual(f.calls.filter(r => r.media).map(r => r.id), ['library']);
  assert.deepEqual(f.uploads().map(r => r.id), ['library']);
});
test('editing one notebook leaves the other untouched', async () => {
  const f = fixture([book('a'), book('b')]); f.seed();
  f.context.state.notebooks[0].pages[0].updatedAt = 20;
  await f.sync();
  assert.deepEqual(f.uploads().map(r => r.id), ['note-a', 'library']);
});
test('remote-only change is downloaded without re-upload', async () => {
  const f = fixture(); f.seed(); f.records.get('note-a').content.pages[0].updatedAt = 20;
  f.records.get('note-a').version = '2';
  await f.sync();
  assert.equal(f.context.state.notebooks[0].pages[0].updatedAt, 20);
  assert.deepEqual(f.uploads().map(r => r.id), ['library']);
});
test('selection made during network request is retained', async () => {
  const f = fixture([book('a'), book('b')]); f.seed();
  f.hook = r => { if (r.media) { f.context.state.currentNotebookId = 'b'; f.context.state.currentPageId = 'b-page'; } };
  await f.sync(); assert.equal(f.context.state.currentNotebookId, 'b');
});
test('manifest describes uploaded snapshot, not editing during upload', async () => {
  const f = fixture(); f.seed(); f.context.state.notebooks[0].pages[0].updatedAt = 20;
  f.hook = r => { if (r.method === 'PATCH' && r.id === 'note-a') f.context.state.notebooks[0].pages[0].updatedAt = 30; };
  await f.sync();
  const saved = f.records.get('note-a').content;
  assert.equal(saved.pages[0].updatedAt, 20);
  assert.equal(f.records.get('library').content.notebooks[0].contentHash, f.context.serializedFingerprint(saved));
  assert.equal(f.context.syncRequestedAgain, true);
});
test('body saved before a failed index update is recovered', async () => {
  const f = fixture(); f.seed(); f.add('InkNote.notebook.b.json', f.context.makeCloudNotebookPayload(book('b')), 'note-b');
  await f.sync(); assert.ok(f.context.state.notebooks.some(n => n.id === 'b'));
  assert.ok(f.records.get('library').content.notebooks.some(n => n.id === 'b'));
});
test('missing referenced notebook aborts without overwriting index', async () => {
  const f = fixture([book('a'), book('b')]); f.seed(); f.context.state.notebooks.pop(); f.records.delete('note-b');
  await assert.rejects(f.sync(), /本体/); assert.equal(f.uploads().length, 0);
});
test('invalid stroke is rejected before replacing local notebook', async () => {
  const f = fixture(); f.seed(); const remote = f.records.get('note-a'); remote.version = '2';
  remote.content.pages[0].strokes = [{ points: [{ x: null, y: 5 }] }];
  await assert.rejects(f.sync(), /描画データ/); assert.equal(f.context.state.notebooks[0].pages[0].strokes.length, 0);
});
test('failed manifest save never deletes notebook body', async () => {
  const f = fixture([book('a'), book('b')]); f.seed(); f.context.deletedNotebookIds.add('b');
  f.hook = r => { if (r.method === 'PATCH' && r.id === 'library') throw new Error('network failed'); };
  await assert.rejects(f.sync(), /network failed/); assert.ok(f.records.has('note-b'));
});
test('concurrent update detected before body overwrite', async () => {
  const f = fixture(); f.seed(); f.context.state.notebooks[0].pages[0].updatedAt = 20;
  f.hook = r => { if (r.method === 'GET' && r.id === 'note-a' && !r.media) f.records.get('note-a').version = '2'; };
  await assert.rejects(f.sync(), error => error.status === 412);
  assert.equal(f.records.get('note-a').content.pages[0].updatedAt, 10);
});
test('legacy migration preserves original backup', async () => {
  const f = fixture(); f.add('InkNote.backup.json', { notebooks: [book('b')], deletedNotebookIds: [], deletedPageIds: [] }, 'old');
  await f.sync(); assert.equal(f.records.get('old').name, 'InkNote.backup.migrated.json');
  assert.ok([...f.records.values()].some(r => r.name === 'InkNote.notebook.b.json'));
});
test('fling stops after switching into editing', () => {
  const f = fixture(); let calls = 0;
  Object.assign(f.context, { pageFlingTimer: null, selectPage: () => calls++ });
  vm.runInContext(source('animatePageFling'), f.context);
  f.context.state.viewMode = 'editing'; f.context.animatePageFling(3);
  assert.equal(calls, 0);
});
test('rectangle shape coordinates stay finite and axis aligned', () => {
  const f = fixture(); f.context.performance = { now: () => 1 };
  vm.runInContext(source('transformPoint') + source('generateShapePoints'), f.context);
  const pts = f.context.generateShapePoints({ type: 'rectangle', bbox: { minX: 0, minY: 0, maxX: 100, maxY: 50 }, center: { x: 50, y: 25 } }, 1, 0);
  assert.equal(pts.length, 5); assert.ok(pts.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)));
  assert.equal(pts[0].y, pts[1].y); assert.equal(pts[1].x, pts[2].x);
});
test('shape path remains straight with pressure off', () => {
  const f = fixture(); vm.runInContext(source('drawStrokePath'), f.context);
  let lines = 0, curves = 0;
  const ctx = { moveTo() {}, lineTo() { lines++; }, quadraticCurveTo() { curves++; } };
  f.context.drawStrokePath(ctx, [{x:0,y:0},{x:100,y:0},{x:100,y:50},{x:0,y:50},{x:0,y:0}], true);
  assert.equal(lines, 4); assert.equal(curves, 0);
});
test('Drive pagination retrieves files beyond first response', async () => {
  const f = fixture(); let count = 0;
  f.context.fetch = async url => {
    const page = new URL(url).searchParams.get('pageToken'); count++;
    return {ok:true, json:async () => page ? {files:[{name:'InkNote.notebook.b.json'}]} : {files:[{name:'InkNote.library.json'}],nextPageToken:'next'}};
  };
  assert.equal((await f.context.listInkNoteCloudFiles()).length, 2); assert.equal(count, 2);
});
test('invalid local JSON is retained rather than overwritten at startup', () => {
  const f = fixture(); let writes = 0;
  Object.assign(f.context, { console:{warn(){}}, localStorage:{getItem:()=>'{broken',setItem:()=>writes++}, STORAGE_KEY:'test', showToast(){} });
  vm.runInContext(source('loadLibrary') + source('saveLibraryNow'), f.context);
  f.context.loadLibrary(); f.context.saveLibraryNow();
  assert.equal(writes,0); assert.equal(f.context.libraryLoadFailed,true);
});
test('edits within one millisecond still advance page revision', () => {
  const f = fixture(); f.context.state.currentPage = f.context.state.notebooks[0].pages[0];
  vm.runInContext(source('markCurrentPageUpdated'), f.context);
  f.context.markCurrentPageUpdated(); const first=f.context.state.currentPage.updatedAt;
  f.context.markCurrentPageUpdated(); assert.ok(f.context.state.currentPage.updatedAt>first);
});
test('service worker falls back on HTTP errors and tolerates full cache', async () => {
  let full = false, status = 503;
  const cached = { cached:true };
  const context = vm.createContext({ URL, self:{location:{href:'https://example.com/inknote/sw.js'},addEventListener(){}},
    caches:{open:async()=>({put:async()=>{if(full)throw new Error('quota');},match:async()=>cached})},
    fetch:async()=>({ok:status===200,status,type:'basic',clone(){return this;}}) });
  vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../sw.js'),'utf8'),context);
  const req={url:'https://example.com/inknote/index.html?test=1',mode:'navigate'};
  assert.equal(await context.networkFirst(req),cached);
  status=200; full=true;
  assert.equal((await context.networkFirst(req)).status,200);
});
test('duplicate cloud names stop sync without choosing and overwriting one', async () => {
  const f = fixture(); f.seed();
  f.add('InkNote.notebook.a.json', f.context.makeCloudNotebookPayload(book()), 'duplicate');
  await assert.rejects(f.sync(), /同名/); assert.equal(f.uploads().length,0);
});
test('undo and redo stay isolated to the current page', () => {
  const f = fixture([book('a'),book('b')]);
  Object.defineProperties(f.context.state, {
    currentPage:{get(){return this.currentNotebook.pages[0];}},
    strokes:{get(){return this.currentPage.strokes;},set(v){this.currentPage.strokes=v;}},
    undoStack:{get(){return this.currentPage.undoStack;}},
    redoStack:{get(){return this.currentPage.redoStack;},set(v){this.currentPage.redoStack=v;}}
  });
  Object.assign(f.context,{updateUndoRedoUI(){},scheduleLibrarySave(){},updateSelectionUI(){},redrawInkCanvas(){},renderOverlay(){}});
  f.context.state.selectedStrokeIds=new Set();
  vm.runInContext(['executeAction','undo','redo','markCurrentPageUpdated'].map(source).join('\n'),f.context);
  const stroke={id:'line',points:[{x:1,y:2},{x:5,y:6}]};
  f.context.state.strokes.push(stroke); f.context.executeAction({type:'add_stroke',stroke});
  f.context.undo(); assert.equal(f.context.state.strokes.length,0);
  f.context.state.currentNotebookId='b'; f.context.redo(); assert.equal(f.context.state.strokes.length,0);
  f.context.state.currentNotebookId='a'; f.context.redo(); assert.equal(f.context.state.strokes.length,1);
});
test('sync waits for editor to close before merging', async () => {
  const f = fixture(); f.context.document = new EventTarget(); f.context.state.viewMode='editing';
  let completed=false;
  const waiting=f.context.waitForLibrarySync().then(()=>{completed=true;});
  await Promise.resolve(); assert.equal(completed,false);
  f.context.state.viewMode='notebook';
  f.context.document.dispatchEvent(new Event('inknote:library-ready'));
  await waiting; assert.equal(completed,true);
});
