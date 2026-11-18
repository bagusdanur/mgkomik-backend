"use strict";
const axios = require("axios");
const MD = "https://api.mangadex.org";
const UP = "https://uploads.mangadex.org";
const HOSTS = new Set(["uploads.mangadex.org", "api.mangadex.org"]);
const clean = (v) => String(v ?? "").trim();
const img = (h, f) => `${UP}/data/${h}/${f}`;
async function get(path, params) {
  let last;
  for (let i = 0; i < 3; i += 1) {
    try {
      const r = await axios.get(MD + path, { params, timeout: 30000, headers: { Accept: "application/json", "User-Agent": "Ryukomik/1.0 (+https://api.ryukomik.com)" } });
      return r.data;
    } catch (e) { last = e; if (e.response && e.response.status < 500) break; await new Promise((resolve) => setTimeout(resolve, 500 * (i + 1))); }
  }
  throw last;
}
function mapManga(m) { const a=m.attributes||{}, rel=m.relationships||[], c=rel.find(x=>x.type==='cover_art'); const alt=(a.altTitles||[]).find(x=>x.en)?.en; const title=a.title?.en||alt||Object.values(a.title||{})[0]||""; return { source:"mangadex", title, original_title:Object.values(a.title||{})[0]||title, alternative_titles:(a.altTitles||[]).flatMap(x=>Object.values(x)).filter(Boolean), slug:m.id, image:c?.attributes?.fileName?img(m.id,c.attributes.fileName):"", detail_link:`https://mangadex.org/title/${m.id}`, description:a.description?.en||Object.values(a.description||{})[0]||"", type_genre:"manga", status:a.status||"", year:a.year||"", genres:(a.tags||[]).map(t=>t.attributes?.name?.en).filter(Boolean) }; }
async function detail(id) { const m=(await get(`/manga/${encodeURIComponent(id)}`,{includes:["cover_art","author","artist"]})).data; let ch=[]; try { ch=(await get(`/manga/${encodeURIComponent(m.id)}/feed`,{limit:500,order:{chapter:'asc'},includes:['scanlation_group']})).data||[]; } catch (_) {} const chapters=ch.map(x=>({title:x.attributes?.title?`Chapter ${x.attributes.chapter}: ${x.attributes.title}`:`Chapter ${x.attributes?.chapter||x.id}`,slug:x.id,link:`chapter/${m.id}/${x.id}`,date:x.attributes?.publishAt||"",locked:false,language:x.attributes?.translatedLanguage||""})); return {success:true,source:'mangadex',data:{...mapManga(m),slug:m.id,synopsis:mapManga(m).description,total_chapter:chapters.length,chapters}}; }
async function chapter(id) { const d=(await get(`/at-home/server/${encodeURIComponent(id)}`)); const b=d.baseUrl, c=d.chapter||{}, pages=[...(c.data||[])]; const seen=new Set(), images=[]; for(const f of pages){const u=`${b}/data/${c.hash}/${f}`;if(!seen.has(u)){seen.add(u);images.push(u);}} let meta={}; try { meta=(await get(`/chapter/${encodeURIComponent(id)}`)).data||{}; } catch (_) {} const rel=(meta.relationships||[]).find(x=>x.type==='manga'); const a=meta.attributes||{}; const label=a.chapter?`Chapter ${a.chapter}${a.title?`: ${a.title}`:''}`:id; return {success:true,source:'mangadex',mangaId:rel?.id||null,chapterSlug:id,currentChapter:label,chapterTitle:a.title||'',prev:null,next:null,back_to_detail:rel?.id||null,totalImages:images.length,images}; }
module.exports=(app,{getCache,setCache,coalescedScrape,getImageCache,setImageCache})=>{
 app.get('/mangadex/image',async(req,res)=>{try{const u=new URL(clean(req.query.url));if(u.protocol!=='https:'||!HOSTS.has(u.hostname))return res.status(400).send('URL MangaDex tidak valid');const r=await axios.get(u.href,{responseType:'arraybuffer',timeout:30000,headers:{Referer:'https://mangadex.org/'}});res.set('Content-Type',r.headers['content-type']||'image/jpeg').send(r.data);}catch(e){res.status(502).send('Gambar MangaDex tidak tersedia');}});
 app.get('/mangadex/search',async(req,res)=>{const q=clean(req.query.q);if(!q)return res.status(400).json({success:false,message:'Parameter q wajib diisi'});try{const d=await get('/manga',{title:q,limit:20,includes:['cover_art']});res.json({success:true,source:'mangadex',query:q,total:d.data.length,data:d.data.map(mapManga)});}catch(e){res.status(502).json({success:false,message:e.message});}});
 app.get('/mangadex/detail/:slug',async(req,res)=>{if(!clean(req.params.slug))return res.status(400).json({success:false,message:'Slug tidak valid'});try{res.json(await detail(req.params.slug));}catch(e){res.status(502).json({success:false,message:e.message});}});
 app.get('/mangadex/chapter/:slug',async(req,res)=>{try{res.json(await chapter(req.params.slug));}catch(e){res.status(502).json({success:false,message:e.message});}});
 app.get('/mangadex/chapter/:series/:slug',async(req,res)=>{try{res.json(await chapter(req.params.slug));}catch(e){res.status(502).json({success:false,message:e.message});}});
 app.get('/mangadex/pustaka',async(req,res)=>{try{const d=await get('/manga',{limit:20,offset:(Math.max(1,Number(req.query.page)||1)-1)*20,order:{latestUploadedChapter:'desc'},includes:['cover_art']});res.json({success:true,source:'mangadex',page:Number(req.query.page)||1,total:d.data.length,data:d.data.map(mapManga)});}catch(e){res.status(502).json({success:false,message:e.message});}});
};
