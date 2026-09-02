// api.js — Wrapper de fetch contra la API
// Extraído de index.html (paso 6 de la separación frontend/backend)

async function api(path, opts={}){
  const r=await fetch(path,{headers:{'Content-Type':'application/json'},...opts});
  if(!r.ok) throw new Error(await r.text());
  return r.json();
}
