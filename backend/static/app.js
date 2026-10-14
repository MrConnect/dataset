"use strict";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const state = {dataset: [], jobs: [], health: null, view: "overview", category: "all", jobFilter: "all", search: "", sort: "newest", selected: new Set(), anchorKey: null, focusedKey: null, moveFiles: [], cutFiles: [], sourceJob: null, confirmResolve: null};
const labels = {overview:["OPERATIONS","Overview"],library:["DATA MANAGEMENT","Dataset library"],jobs:["PIPELINE","Processing jobs"],system:["CONFIGURATION","System & connection"]};
const systemNames = {_downloads:"Source downloads",_temp:"Temporary files",_database:"System files"};

function escapeHtml(value="") { const node=document.createElement("div"); node.textContent=String(value); return node.innerHTML; }
function apiKey(){ return localStorage.getItem("frameforge_api_key") || ""; }
function headers(json=false){ const h={}; if(apiKey()) h["X-API-Key"]=apiKey(); if(json) h["Content-Type"]="application/json"; return h; }
function bytes(value=0){ if(!value) return "0 B"; const units=["B","KB","MB","GB","TB"],i=Math.min(Math.floor(Math.log(value)/Math.log(1024)),4); return `${(value/1024**i).toFixed(i?1:0)} ${units[i]}`; }
function date(value){ if(!value) return "—"; return new Intl.DateTimeFormat(undefined,{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"}).format(new Date(value)); }
function categoryName(name){ return systemNames[name] || name.replace(/[-_]/g," ").replace(/\b\w/g,c=>c.toUpperCase()); }
function fileKey(file){ return `${encodeURIComponent(file.category)}/${encodeURIComponent(file.filename)}`; }
function fileUrl(file){ return file.url || `/media/${encodeURIComponent(file.category)}/${encodeURIComponent(file.filename)}`; }
function isVideo(file){ return /\.(mp4|mkv|webm|ts|avi|mov|m4v)$/i.test(file.filename); }
function statusName(status){ return ({awaiting_source:"Needs source",processing:"Processing",completed:"Completed",failed:"Failed",queued:"Queued",cancelled:"Cancelled"})[status] || status; }

async function request(url, options={}){
  const response=await fetch(url,options); let body=null; const type=response.headers.get("content-type")||"";
  if(type.includes("json")) body=await response.json();
  if(!response.ok) throw Object.assign(new Error(body?.detail || `Request failed (${response.status})`),{status:response.status});
  return body;
}
function toast(message,kind="ok"){ const el=document.createElement("div"); el.className=`toast ${kind}`; el.textContent=message; $("#toastStack").append(el); setTimeout(()=>el.remove(),3600); }
function empty(title,message){ return `<div class="empty"><strong>${escapeHtml(title)}</strong>${escapeHtml(message)}</div>`; }
function progress(value=0){ const safe=Math.max(0,Math.min(100,value)); return `<div class="progress" title="${safe}%"><i style="width:${safe}%"></i></div>`; }
function pill(status){ return `<span class="pill ${escapeHtml(status)}">${escapeHtml(statusName(status))}</span>`; }

function setView(view){
  state.view=view; $$(".view").forEach(el=>el.classList.toggle("active",el.id===`view-${view}`)); $$(".nav").forEach(el=>el.classList.toggle("active",el.dataset.view===view));
  $("#pageEyebrow").textContent=labels[view][0]; $("#pageTitle").textContent=labels[view][1]; location.hash=view; $(".sidebar").classList.remove("open");
  if(view==="jobs") loadJobs();
}
function allFiles(){ return state.dataset.flatMap(cat=>cat.videos.map(v=>({...v,category:cat.name,displayCategory:cat.display_name||categoryName(cat.name)}))); }

async function loadAll(showToast=false){
  $("#refreshButton").disabled=true;
  const [datasetResult,healthResult]=await Promise.allSettled([request("/api/v1/dataset/"),request("/api/v1/health")]);
  if(datasetResult.status==="fulfilled") state.dataset=datasetResult.value.categories||[]; else toast(datasetResult.reason.message,"error");
  if(healthResult.status==="fulfilled") state.health=healthResult.value;
  await loadJobs(false); renderAll(); $("#lastSync").textContent=`Synced ${new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}`; $("#refreshButton").disabled=false;
  if(showToast) toast("Dashboard refreshed");
}
async function loadDataset(){
  const data=await request("/api/v1/dataset/"); state.dataset=data.categories||[]; renderOverview(); renderCategories(); renderLibrary();
}
async function loadJobs(render=true){
  if(!apiKey()){ state.jobs=[]; $("#authNotice").hidden=false; if(render) renderAll(); return; }
  try{ state.jobs=await request("/api/v1/jobs?limit=100",{headers:headers()}); $("#authNotice").hidden=true; }
  catch(error){ state.jobs=[]; $("#authNotice").hidden=false; if(error.status!==401) toast(error.message,"error"); }
  if(render) renderAll();
}
function renderAll(){ renderConnection(); renderOverview(); renderCategories(); renderLibrary(); renderJobs(); renderHealth(); }
function renderConnection(){
  const healthy=state.health?.status==="healthy"; $("#connectionDot").className=healthy?"healthy":state.health?"degraded":"";
  $("#connectionLabel").textContent=healthy?"Service online":state.health?"Service degraded":"Service unavailable";
  $("#connectionDetail").textContent=healthy?"Pipeline is responding":state.health?"Review runtime checks":"Connection failed";
}
function renderOverview(){
  const files=allFiles(), datasetFiles=files.filter(f=>!f.category.startsWith("_")), active=state.jobs.filter(j=>["queued","processing"].includes(j.status)).length, needs=state.jobs.filter(j=>j.status==="awaiting_source").length;
  $("#navLibraryCount").textContent=datasetFiles.length; $("#navJobsCount").textContent=active+needs;
  const cards=[["Dataset clips",datasetFiles.length,"▦"],["Categories",state.dataset.filter(c=>!c.name.startsWith("_")).length,"◎"],["Active jobs",active,"↻"],["Needs attention",needs,"! "]];
  $("#metricGrid").innerHTML=cards.map(([name,value,icon])=>`<article class="metric"><span><small>${name}</small><strong>${value}</strong></span><i>${icon}</i></article>`).join("");
  const recent=state.jobs.slice(0,5); $("#recentJobs").innerHTML=recent.length?recent.map(j=>`<div class="job-row"><div><strong>${escapeHtml(j.job_id)}</strong><small>${escapeHtml(sourceLabel(j))}</small></div>${pill(j.status)}${progress(j.progress)}<small>${date(j.created_at)}</small></div>`).join(""):empty(apiKey()?"No jobs yet":"Jobs are not connected",apiKey()?"New processing jobs will appear here.":"Add the API key to see pipeline activity.");
  const cats=state.dataset.filter(c=>!c.name.startsWith("_")).sort((a,b)=>b.videos.length-a.videos.length).slice(0,6),max=Math.max(...cats.map(c=>c.videos.length),1);
  $("#categorySummary").innerHTML=cats.length?cats.map(c=>`<div class="category-line"><div><span>${escapeHtml(c.display_name||categoryName(c.name))}</span><small>${c.videos.length} clips</small></div><i style="width:${c.videos.length/max*100}%"></i></div>`).join(""):empty("No output yet","Completed segments will be grouped here.");
}
function renderCategories(){
  const select=$("#categoryFilter"),options=[`<option value="all">All categories</option>`]; state.dataset.forEach(c=>options.push(`<option value="${escapeHtml(c.name)}">${escapeHtml(c.display_name||categoryName(c.name))}</option>`)); select.innerHTML=options.join(""); select.value=state.category;
  $("#categoryRail").innerHTML=[`<button class="category-button ${state.category==="all"?"active":""}" data-category="all"><span>▦ All files</span><span>${allFiles().length}</span></button>`,...state.dataset.map(c=>`<button class="category-button ${state.category===c.name?"active":""}" data-category="${escapeHtml(c.name)}"><span>${c.name.startsWith("_")?"◈":"□"} ${escapeHtml(c.display_name||categoryName(c.name))}</span><span>${c.videos.length}</span></button>`)].join("");
  $("#categoryOptions").innerHTML=state.dataset.filter(c=>!c.name.startsWith("_")).map(c=>`<option value="${escapeHtml(c.name)}">${escapeHtml(c.display_name||categoryName(c.name))}</option>`).join("");
}
function filteredFiles(){
  let files=allFiles().filter(f=>(state.category==="all"||f.category===state.category)&&(!state.search||`${f.filename} ${f.displayCategory}`.toLowerCase().includes(state.search)));
  return files.sort((a,b)=>state.sort==="oldest"?a.created_at-b.created_at:state.sort==="largest"?b.size-a.size:state.sort==="name"?a.filename.localeCompare(b.filename):b.created_at-a.created_at);
}
function renderLibrary(){
  const files=filteredFiles(); $("#libraryHeading").textContent=state.category==="all"?"All files":state.dataset.find(c=>c.name===state.category)?.display_name||categoryName(state.category); $("#libraryCount").textContent=`${files.length} item${files.length===1?"":"s"}`;
  if(!state.focusedKey&&files.length)state.focusedKey=fileKey(files[0]);
  $("#fileGrid").innerHTML=files.length?files.map(file=>{const key=fileKey(file); return `<article class="file-card ${state.selected.has(key)?"selected":""}" data-key="${escapeHtml(key)}" tabindex="${state.focusedKey===key?"0":"-1"}" aria-selected="${state.selected.has(key)}"><input class="file-select" type="checkbox" data-action="select" ${state.selected.has(key)?"checked":""} aria-label="Select ${escapeHtml(file.filename)}"><div class="file-thumb" data-action="preview"><span class="file-placeholder"><b>${isVideo(file)?"▶":"◇"}</b><small>${isVideo(file)?"VIDEO":"FILE"}</small></span></div><div class="file-info"><strong title="${escapeHtml(file.filename)}">${escapeHtml(file.filename)}</strong><small>${escapeHtml(file.displayCategory)} · ${bytes(file.size)} · ${date(file.created_at)}</small></div><div class="file-actions"><button data-action="preview">Preview</button><button data-action="download">Download</button>${file.category!=="_database"?`<button data-action="move">Move</button><button data-action="delete">Delete</button>`:""}</div></article>`}).join(""):empty("Nothing matches this view","Try another category or clear your search.");
  $("#selectionBar").hidden=!state.selected.size; $("#selectionCount").textContent=`${state.selected.size} selected`;
}
function sourceLabel(job){ try{return new URL(job.page_url||job.media_url).hostname;}catch{return job.media_type||"Media source";} }
function renderJobs(){
  const jobs=state.jobs.filter(j=>state.jobFilter==="all"||(state.jobFilter==="processing"?["queued","processing"].includes(j.status):j.status===state.jobFilter));
  $("#jobsTable").innerHTML=jobs.length?jobs.map(j=>`<tr data-job="${escapeHtml(j.job_id)}"><td class="source-cell"><strong>${escapeHtml(j.job_id)}</strong><small title="${escapeHtml(j.page_url)}">${escapeHtml(sourceLabel(j))} · ${escapeHtml(j.media_type)}</small></td><td>${pill(j.status)}</td><td>${j.segments_count}</td><td>${progress(j.progress)}<small>${j.progress}%</small></td><td>${date(j.created_at)}</td><td><div class="row-actions">${j.source_required?`<button data-job-action="source">Upload source</button>`:""}${["queued","processing"].includes(j.status)?`<button data-job-action="cancel">Cancel</button>`:""}<button data-job-action="delete">Delete</button></div></td></tr>`).join(""):`<tr><td colspan="6">${empty(apiKey()?"No matching jobs":"Connection required",apiKey()?"Try a different status filter.":"Add the API key under System & connection.")}</td></tr>`;
}
function renderHealth(){ const health=state.health||{}; const checks=[["API service",health.status||"unavailable"],["Database",health.database||"unknown"],["FFmpeg",health.ffmpeg||"unknown"],["FFprobe",health.ffprobe||"unknown"],["Storage",health.storage||"unknown"],["Accurate cutting",health.accurate_cutting===true?"enabled":health.accurate_cutting===false?"disabled":"unknown"]]; $("#healthChecks").innerHTML=checks.map(([a,b])=>`<div class="health-item"><span>${a}</span><span>${b}</span></div>`).join(""); }

function findFile(key){ const split=key.indexOf("/"); if(split<0)return undefined; const category=decodeURIComponent(key.slice(0,split)),filename=decodeURIComponent(key.slice(split+1)); return allFiles().find(f=>f.category===category&&f.filename===filename); }
function previewFile(file){ if(!isVideo(file)){ downloadFile(file); return; } $("#previewCategory").textContent=file.displayCategory; $("#previewTitle").textContent=file.filename; $("#previewVideo").src=fileUrl(file); $("#previewMeta").innerHTML=`<span>${bytes(file.size)}</span><span>${date(file.created_at)}</span>`; $("#previewModal").hidden=false; }
function downloadFile(file){ const a=document.createElement("a"); a.href=fileUrl(file); a.download=file.filename; document.body.append(a); a.click(); a.remove(); }
function closeModal(id){ if(id==="previewModal"){ $("#previewVideo").pause(); $("#previewVideo").removeAttribute("src"); } $("#"+id).hidden=true; }
function confirmAction(title,message){ $("#confirmTitle").textContent=title; $("#confirmMessage").textContent=message; $("#confirmModal").hidden=false; return new Promise(resolve=>state.confirmResolve=resolve); }
function mutableFiles(files){ return files.filter(file=>file&&file.category!=="_database"); }
function selectAllVisible(){ state.selected=new Set(filteredFiles().filter(file=>file.category!=="_database").map(fileKey)); state.anchorKey=[...state.selected].at(-1)||null; renderLibrary(); }
function openMove(files){
  files=mutableFiles(files); if(!files.length)return; state.moveFiles=files;
  const multiple=files.length>1; $("#moveTitle").textContent=multiple?`Move ${files.length} files`:"Move or rename file"; $("#moveCategory").value=files[0].category;
  $("#moveFilenameLabel").hidden=multiple; $("#moveFilename").required=!multiple; $("#moveFilename").value=multiple?"":files[0].filename; $("#moveModal").hidden=false; $("#moveCategory").focus();
}
function removeFromLocalDataset(files){ const keys=new Set(files.map(fileKey)); state.dataset.forEach(cat=>cat.videos=cat.videos.filter(video=>!keys.has(fileKey({...video,category:cat.name})))); }
async function deleteFiles(files){
  files=mutableFiles(files); if(!files.length)return; if(!await confirmAction("Delete files?",`${files.length} item${files.length===1?"":"s"} will be permanently removed.`))return;
  files.forEach(file=>document.querySelector(`[data-key="${CSS.escape(fileKey(file))}"]`)?.classList.add("busy"));
  try{
    await request("/api/v1/dataset/bulk/delete",{method:"POST",headers:headers(true),body:JSON.stringify({files:files.map(({category,filename})=>({category,filename}))})});
    removeFromLocalDataset(files); state.selected.clear(); state.focusedKey=null; renderOverview(); renderCategories(); renderLibrary(); toast(`Deleted ${files.length} item${files.length===1?"":"s"}`); loadDataset().catch(()=>{});
  }catch(error){renderLibrary();toast(error.message,"error");}
}
async function moveFiles(files,newCategory,newFilename=null){
  files=mutableFiles(files); if(!files.length)return;
  const payload=files.length===1?{old_category:files[0].category,old_filename:files[0].filename,new_category:newCategory,new_filename:newFilename||files[0].filename}:{files:files.map(({category,filename})=>({category,filename})),new_category:newCategory};
  const endpoint=files.length===1?"/api/v1/dataset/move":"/api/v1/dataset/bulk/move";
  await request(endpoint,{method:"POST",headers:headers(true),body:JSON.stringify(payload)}); state.selected.clear(); state.cutFiles=[]; state.focusedKey=null; await loadDataset();
}
async function uploadVideo(file){ if(!file)return; const form=new FormData(); form.append("file",file); toast(`Uploading ${file.name}…`); try{await request("/api/v1/dataset/upload_video",{method:"POST",body:form}); await loadDataset(); state.category="_downloads"; setView("library"); renderCategories(); renderLibrary(); toast("Video uploaded to source downloads");}catch(e){toast(e.message,"error");} }
async function jobAction(jobId,action){
  if(action==="source"){state.sourceJob=jobId; $("#jobSourceUpload").click(); return;}
  const verb=action==="delete"?"delete":"cancel", past=action==="delete"?"deleted":"cancelled"; if(!await confirmAction(`${verb[0].toUpperCase()+verb.slice(1)} job?`,`Job ${jobId} will be ${past}.`))return;
  try{await request(`/api/v1/jobs/${encodeURIComponent(jobId)}${action==="cancel"?"/cancel":""}`,{method:action==="cancel"?"POST":"DELETE",headers:headers()}); await loadJobs(); toast(`Job ${past}`);}catch(e){toast(e.message,"error");}
}

document.addEventListener("click",async event=>{
  const nav=event.target.closest("[data-view],[data-go]"); if(nav){setView(nav.dataset.view||nav.dataset.go);return;}
  if(event.target.closest("#mobileMenu")){$(".sidebar").classList.toggle("open");return;}
  const category=event.target.closest("[data-category]"); if(category){state.category=category.dataset.category; $("#categoryFilter").value=state.category; state.selected.clear();state.focusedKey=null;renderCategories();renderLibrary();return;}
  const close=event.target.closest("[data-close]"); if(close){closeModal(close.dataset.close);return;}
  const card=event.target.closest(".file-card"),action=event.target.closest("[data-action]")?.dataset.action;
  if(card&&action){const file=findFile(card.dataset.key); if(action==="select"){state.selected.has(card.dataset.key)?state.selected.delete(card.dataset.key):state.selected.add(card.dataset.key);state.anchorKey=card.dataset.key;state.focusedKey=card.dataset.key;renderLibrary();} if(action==="preview")previewFile(file); if(action==="download")downloadFile(file); if(action==="delete")deleteFiles([file]); if(action==="move")openMove([file]); return;}
  if(card){
    const keys=filteredFiles().map(fileKey),key=card.dataset.key;
    if(event.shiftKey&&state.anchorKey){const a=keys.indexOf(state.anchorKey),b=keys.indexOf(key);if(a>=0)for(let i=Math.min(a,b);i<=Math.max(a,b);i++)if(findFile(keys[i])?.category!=="_database")state.selected.add(keys[i]);}
    else if(event.ctrlKey||event.metaKey){state.selected.has(key)?state.selected.delete(key):findFile(key)?.category!=="_database"&&state.selected.add(key);state.anchorKey=key;}
    else{state.selected.clear();if(findFile(key)?.category!=="_database")state.selected.add(key);state.anchorKey=key;}
    state.focusedKey=key;renderLibrary();document.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus();return;
  }
  const bulk=event.target.closest("[data-bulk]")?.dataset.bulk; if(bulk){const files=[...state.selected].map(findFile).filter(Boolean); if(bulk==="select-all")selectAllVisible();if(bulk==="clear"){state.selected.clear();renderLibrary();}if(bulk==="download")files.forEach(downloadFile);if(bulk==="move")openMove(files);if(bulk==="delete")deleteFiles(files);return;}
  const jf=event.target.closest("[data-status]"); if(jf){state.jobFilter=jf.dataset.status; $$("#jobFilters button").forEach(b=>b.classList.toggle("active",b===jf));renderJobs();return;}
  const ja=event.target.closest("[data-job-action]"); if(ja){jobAction(ja.closest("tr").dataset.job,ja.dataset.jobAction);return;}
  const confirmation=event.target.closest("[data-confirm]"); if(confirmation){const ok=confirmation.dataset.confirm==="ok";closeModal("confirmModal");state.confirmResolve?.(ok);state.confirmResolve=null;}
});
$("#fileGrid").addEventListener("dblclick",event=>{const card=event.target.closest(".file-card");if(card)previewFile(findFile(card.dataset.key));});
$("#refreshButton").addEventListener("click",()=>loadAll(true)); $("#jobsRefresh").addEventListener("click",()=>loadJobs());
$("#librarySearch").addEventListener("input",e=>{state.search=e.target.value.trim().toLowerCase();renderLibrary();});
$("#categoryFilter").addEventListener("change",e=>{state.category=e.target.value;state.selected.clear();state.focusedKey=null;renderCategories();renderLibrary();});
$("#sortLibrary").addEventListener("change",e=>{state.sort=e.target.value;renderLibrary();});
$("#globalUpload").addEventListener("change",e=>{uploadVideo(e.target.files[0]);e.target.value="";});
$("#moveForm").addEventListener("submit",async e=>{e.preventDefault();const files=state.moveFiles;try{await moveFiles(files,$("#moveCategory").value.trim(),files.length===1?$("#moveFilename").value.trim():null);closeModal("moveModal");toast(`${files.length} file${files.length===1?"":"s"} moved`);}catch(err){toast(err.message,"error");}});
$("#connectionForm").addEventListener("submit",async e=>{e.preventDefault();localStorage.setItem("frameforge_api_key",$("#apiKeyInput").value.trim());await loadJobs();toast(state.jobs.length||$("#authNotice").hidden?"Connection saved":"Could not authenticate",$("#authNotice").hidden?"ok":"error");});
$("#toggleKey").addEventListener("click",()=>{const input=$("#apiKeyInput");input.type=input.type==="password"?"text":"password";$("#toggleKey").textContent=input.type==="password"?"Show":"Hide";});
$("#jobSourceUpload").addEventListener("change",async e=>{const file=e.target.files[0];if(!file||!state.sourceJob)return;const form=new FormData();form.append("file",file);toast("Uploading source and resuming job…");try{await request(`/api/v1/jobs/${encodeURIComponent(state.sourceJob)}/source`,{method:"POST",headers:headers(),body:form});await loadJobs();toast("Source uploaded; job resumed");}catch(err){toast(err.message,"error");}e.target.value="";state.sourceJob=null;});
document.addEventListener("keydown",async e=>{
  if(e.key==="Escape"){$$(".modal:not([hidden])").forEach(m=>closeModal(m.id));if(state.view==="library"){state.selected.clear();renderLibrary();}return;}
  if(state.view!=="library"||$(".modal:not([hidden])")||/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName||""))return;
  const selected=[...state.selected].map(findFile).filter(Boolean),ctrl=e.ctrlKey||e.metaKey;
  if(ctrl&&e.key.toLowerCase()==="a"){e.preventDefault();selectAllVisible();return;}
  if(ctrl&&e.key.toLowerCase()==="x"&&selected.length){e.preventDefault();state.cutFiles=mutableFiles(selected);toast(`${state.cutFiles.length} item(s) ready to move`);return;}
  if(ctrl&&e.key.toLowerCase()==="v"&&state.cutFiles.length){e.preventDefault();if(state.category==="all"||state.category.startsWith("_")){toast("Choose a dataset category first","error");return;}try{await moveFiles(state.cutFiles,state.category);toast("Items moved here");}catch(err){toast(err.message,"error");}return;}
  if(e.key==="Delete"&&selected.length){e.preventDefault();deleteFiles(selected);return;}
  if(e.key==="Enter"&&selected.length){e.preventDefault();previewFile(selected[0]);return;}
  if(e.key.toLowerCase()==="m"&&selected.length){e.preventDefault();openMove(selected);return;}
  if(["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(e.key)){
    e.preventDefault();const keys=filteredFiles().map(fileKey);if(!keys.length)return;let i=Math.max(0,keys.indexOf(state.focusedKey));const columns=Math.max(1,Math.round($("#fileGrid").clientWidth/220));i+=e.key==="ArrowLeft"?-1:e.key==="ArrowRight"?1:e.key==="ArrowUp"?-columns:columns;i=Math.max(0,Math.min(keys.length-1,i));state.focusedKey=keys[i];if(!ctrl){state.selected.clear();if(findFile(keys[i])?.category!=="_database")state.selected.add(keys[i]);}renderLibrary();document.querySelector(`[data-key="${CSS.escape(keys[i])}"]`)?.focus();
  }
});

$("#apiKeyInput").value=apiKey(); setView(location.hash.slice(1) in labels?location.hash.slice(1):"overview"); loadAll(); setInterval(()=>{if(apiKey())loadJobs();},15000);
