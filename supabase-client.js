/* OW - robust Supabase browser client bootstrap (v13.9).
 * Loads a pinned UMD SDK in sequence (primary + fallback CDN) instead of an async tag race.
 * Only the anon/public key belongs in the browser. RLS/database policies remain authoritative.
 */
(function(){
  'use strict';
  const URL='https://nyhyoyjznbpilailccof.supabase.co';
  const KEY='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im55aHlveWp6bmJwaWxhaWxjY29mIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk5NjcwODYsImV4cCI6MjA4NTU0MzA4Nn0.JUECyOWyRlzHrmy647xdYGzEKF532i2VgvwtXCQAteI';
  const SDK_URLS=[
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.57.4/dist/umd/supabase.js',
    'https://unpkg.com/@supabase/supabase-js@2.57.4/dist/umd/supabase.js'
  ];
  window.OW_SUPABASE_CONFIG={url:URL,anonKey:KEY};
  function loadSdk(){
    if(window.supabase?.createClient)return Promise.resolve(window.supabase);
    return new Promise((resolve,reject)=>{
      let index=0,settled=false;
      const next=(previousError)=>{
        if(window.supabase?.createClient){settled=true;resolve(window.supabase);return;}
        if(index>=SDK_URLS.length){settled=true;reject(new Error('تعذر تحميل مكتبة Supabase من مزودي CDN. تحقق من اتصال الإنترنت أو جرّب شبكة أخرى. (Supabase SDK failed to load from both CDNs.)'));return;}
        const src=SDK_URLS[index++],script=document.createElement('script');
        let timer=setTimeout(()=>{script.onload=script.onerror=null;script.remove();next(new Error('SDK load timeout'));},12000);
        script.src=src;script.async=true;script.crossOrigin='anonymous';
        script.onload=()=>{clearTimeout(timer);if(window.supabase?.createClient){if(!settled){settled=true;resolve(window.supabase)}}else next(new Error('SDK global missing'))};
        script.onerror=()=>{clearTimeout(timer);script.remove();next(new Error('SDK CDN failed'))};
        document.head.appendChild(script);
      };
      next();
    });
  }
  // Keep Supabase's built-in auth lock. It serializes session reads and auth mutations
  // across startup restoration, sign-in, refresh and sign-out; bypassing it can corrupt/race
  // persisted auth state when these operations overlap.
  window.orshapSupabaseReady=loadSdk().then(sdk=>{
    if(!window.orshapSupabase)window.orshapSupabase=sdk.createClient(URL,KEY,{
      auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true},
      global:{headers:{'X-Client-Info':'orshap-wms-browser/13.9'}}
    });
    return window.orshapSupabase;
  });
  window.orshapSupabaseReady.catch(()=>{});
  async function client(){return await window.orshapSupabaseReady;}
  window.orshapRemote={
    async signIn(email,password){const s=await client();return s.auth.signInWithPassword({email,password});},
    async signUp(email,password,name){const s=await client();return s.auth.signUp({email,password,options:{data:{name}}});},
    async signOut(){const s=await client();return s.auth.signOut();},
    async session(){const s=await client();return s.auth.getSession();},
    async profile(id){const s=await client();return s.from('profiles').select('*').eq('id',id).maybeSingle();},
    async pull(table){const s=await client();return s.from(table).select('*');},
    async upsert(table,rows){if(!rows?.length)return {data:[],error:null};const s=await client();return s.from(table).upsert(rows,{onConflict:'id'});},
    async deleteByIds(table,ids){if(!ids?.length)return {error:null};const s=await client();return s.from(table).delete().in('id',ids);},
    async rpc(name,args){const s=await client();return s.rpc(name,args||{});}
  };
})();
