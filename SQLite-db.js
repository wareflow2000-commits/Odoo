function bootOptionalSQLite(){
/* OW V6 - SQLite WASM + OPFS persistence adapter.
   Functional scope is intentionally aligned to the original project's local entities.
   The UI still consumes a plain JS state object; SQLite is the durable local source.
*/
(function(){
  const DB_FILE='orshap-wms.sqlite';
  const TABLES=['profiles','warehouses','shelves','items','units','item_unit_conversions','stock','transactions','transaction_lines','stocktake_sessions','stocktake_lines','audit_logs','inventory_ledger','system_settings','print_config','display_config','sync_queue'];
  let SQL=null, db=null;
  const schema=`CREATE TABLE IF NOT EXISTS kv_state (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL, updated_at TEXT NOT NULL);`+
    TABLES.map(t=>`CREATE TABLE IF NOT EXISTS ${t.replace(/[^a-z0-9_]/gi,'_')} (id TEXT PRIMARY KEY, payload TEXT NOT NULL);`).join('');
  function arr(v){return Array.isArray(v)?v:[]}
  function exec(sql,params=[]){db.run(sql,params)}
  function read(table){const r=db.exec('SELECT payload FROM '+table);return r.length?r[0].values.map(x=>JSON.parse(x[0])):[]}
  async function opfsRead(){try{if(!navigator.storage?.getDirectory)return null;const root=await navigator.storage.getDirectory();const h=await root.getFileHandle(DB_FILE);const f=await h.getFile();if(!f.size)return null;return new Uint8Array(await f.arrayBuffer())}catch(e){return null}}
  async function opfsWrite(bytes){if(!navigator.storage?.getDirectory)throw new Error('OPFS unavailable');const root=await navigator.storage.getDirectory();const h=await root.getFileHandle(DB_FILE,{create:true});const w=await h.createWritable();await w.write(bytes);await w.close()}
  async function init(){
    if(!window.initSqlJs) throw new Error('SQLite WASM loader unavailable');
    SQL=await window.initSqlJs({locateFile:f=>'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.13.0/'+f});
    const bytes=await opfsRead(); db=bytes?new SQL.Database(bytes):new SQL.Database(); db.run(schema);
    // Retire obsolete local entity tables; historical transaction payloads remain intact.
    db.run('DROP TABLE IF EXISTS zones');
    db.run('DROP TABLE IF EXISTS sections');
    window.orshapSQLite.status='ready';
  }
  let readyPromise;
  async function ensureReady(){ if(db) return; if(!readyPromise) readyPromise=init(); await readyPromise; }
  async function loadState(){
    await ensureReady();
    const r=db.exec('SELECT payload FROM kv_state WHERE id=1');
    if(!r.length)return null;
    try{
      const state=JSON.parse(r[0].values[0][0]);
      if(state&&typeof state==='object'){delete state.zones;delete state.sections;}
      return state;
    }catch(e){return null}
  }
  async function saveState(state){
    await ensureReady();
    const canonicalState={...state};
    delete canonicalState.zones;
    delete canonicalState.sections;
    const now=new Date().toISOString();
    db.run('BEGIN');
    try{
      for(const t of TABLES){exec('DELETE FROM '+t); for(const x of arr(canonicalState[t]||[])){const id=String(x.id||crypto.randomUUID());exec('INSERT OR REPLACE INTO '+t+'(id,payload) VALUES (?,?)',[id,JSON.stringify(x)]);}}
      exec('INSERT OR REPLACE INTO kv_state(id,payload,updated_at) VALUES(1,?,?)',[JSON.stringify(canonicalState),now]);
      db.run('COMMIT');
      const bytes=db.export();
      try{await opfsWrite(bytes); localStorage.setItem('orshap_storage_engine','sqlite-opfs')}catch(e){localStorage.setItem('orshap_storage_engine','sqlite-wasm-memory');}
      return true;
    }catch(e){try{db.run('ROLLBACK')}catch(_){} throw e}
  }
  async function query(table,where){await ensureReady();const rows=read(table);return where?rows.filter(where):rows}
  window.orshapSQLite={status:'loading',loadState,saveState,query,get database(){return db},get engine(){return navigator.storage?.getDirectory?'SQLite WASM + OPFS':'SQLite WASM (memory fallback)'}};
  readyPromise=init().catch(e=>{window.orshapSQLite.status='fallback';throw e});
  window.ORS_SQLITE_READY=readyPromise;
})();

}