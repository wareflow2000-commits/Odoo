// تهيئة SDK واستخراج الـ client الجاهز.
// نستورد نسخة OW مباشرة، ونوفّر مساعدًا async يعيد الـ client.

export async function sb() {
  if (!window.orshapSupabaseReady) {
    throw new Error('لم يتم تحميل supabase-client.js. تأكد من وجوده قبل main.js');
  }
  const client = await window.orshapSupabaseReady;
  if (!client) throw new Error('فشل تهيئة عميل Supabase');
  return client;
}

export async function rpc(name, args = {}) {
  const c = await sb();
  const { data, error } = await c.rpc(name, args);
  if (error) throw new Error(error.message || String(error));
  return data;
}

export async function from(table) {
  return (await sb()).from(table);
}