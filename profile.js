(()=>{
'use strict';

const cfg=window.CULTIVA_SUPABASE||{};
const SUPABASE_URL=String(cfg.url||'').replace(/\/$/,'');
const SUPABASE_KEY=String(cfg.key||'');
const SESSION_KEY='cultivaSupabaseSession';
let cloudSession=null;
let cloudSyncTimer=null;
let cloudSyncing=false;
let authMode='login';
let accountGate=true;

const $=s=>document.querySelector(s);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function setCloudStatus(text,kind=''){
  const el=$('#cloudStatus'); if(!el)return;
  el.textContent=text;
  el.className='cloud-status '+kind;
}
function setAuthMessage(text,kind=''){
  const el=$('#authMessage'); if(!el)return;
  el.textContent=text||''; el.className='auth-message '+kind;
}
function accountLabel(){
  const btn=$('#accountBtn'); if(!btn)return;
  if(cloudSession?.user){
    const name=cloudSession.user.user_metadata?.username||cloudSession.user.email?.split('@')[0]||'Profil';
    btn.innerHTML=`<span class="account-dot"></span>${esc(name)}`;
    btn.classList.add('connected');
  }else{
    btn.innerHTML='<span class="account-dot"></span>Profil';
    btn.classList.remove('connected');
  }
}

async function api(path,{method='GET',body,token,headers={}}={}){
  const res=await fetch(SUPABASE_URL+path,{
    method,
    headers:{
      apikey:SUPABASE_KEY,
      Authorization:`Bearer ${token||SUPABASE_KEY}`,
      ...(body?{'Content-Type':'application/json'}:{}),
      ...headers
    },
    body:body?JSON.stringify(body):undefined
  });
  const text=await res.text();
  let data=null; try{data=text?JSON.parse(text):null}catch{data=text}
  if(!res.ok){const msg=data?.msg||data?.message||data?.error_description||data?.error||`Erreur ${res.status}`;throw new Error(msg)}
  return data;
}

function saveSession(data){
  if(!data?.access_token){cloudSession=null;localStorage.removeItem(SESSION_KEY);accountLabel();return}
  cloudSession={...data,expires_at:data.expires_at||Math.floor(Date.now()/1000)+(data.expires_in||3600)};
  localStorage.setItem(SESSION_KEY,JSON.stringify(cloudSession));
  accountLabel();
}
function readSession(){
  try{const s=JSON.parse(localStorage.getItem(SESSION_KEY)||'null');return s&&s.access_token?s:null}catch{return null}
}
async function ensureSession(){
  if(!cloudSession)return null;
  if((cloudSession.expires_at||0)>Math.floor(Date.now()/1000)+60)return cloudSession;
  if(!cloudSession.refresh_token){saveSession(null);return null}
  try{
    const data=await api('/auth/v1/token?grant_type=refresh_token',{method:'POST',body:{refresh_token:cloudSession.refresh_token}});
    saveSession(data); return cloudSession;
  }catch{saveSession(null);return null}
}

async function signIn(email,password){
  const data=await api('/auth/v1/token?grant_type=password',{method:'POST',body:{email,password}});
  saveSession(data);
  await afterLogin();
}
async function signUp(email,password,username){
  const data=await api('/auth/v1/signup',{method:'POST',body:{email,password,data:{username:username||email.split('@')[0]}}});
  if(data?.access_token){saveSession(data);await afterLogin();return {confirmed:true}}
  return {confirmed:false};
}
async function signOut(){
  const s=await ensureSession();
  if(s){try{await api('/auth/v1/logout',{method:'POST',token:s.access_token})}catch{}}
  saveSession(null);
  setCloudStatus('Connexion requise');
  setAccountGate(true);
  authMode='login';
  renderAccountView();
  openAccount(true);
}

async function dbGet(table,query=''){
  const s=await ensureSession(); if(!s)throw new Error('Session expirée');
  return api(`/rest/v1/${table}${query}`,{token:s.access_token,headers:{Accept:'application/json'}});
}
async function dbUpsert(table,rows,onConflict){
  const s=await ensureSession(); if(!s)throw new Error('Session expirée');
  if(!rows||!rows.length)return;
  const q=onConflict?`?on_conflict=${encodeURIComponent(onConflict)}`:'';
  return api(`/rest/v1/${table}${q}`,{method:'POST',token:s.access_token,body:rows,headers:{Prefer:'resolution=merge-duplicates,return=minimal'}});
}
async function dbDelete(table,query){
  const s=await ensureSession(); if(!s)throw new Error('Session expirée');
  return api(`/rest/v1/${table}${query}`,{method:'DELETE',token:s.access_token,headers:{Prefer:'return=minimal'}});
}

function localProfile(){try{return JSON.parse(localStorage.getItem('cultivaAssessment')||'null')}catch{return null}}
function localSeen(){try{return JSON.parse(localStorage.getItem('cultivaSeenQuestions')||'[]')}catch{return []}}

async function cloudProfileExists(userId){
  const rows=await dbGet('profiles',`?user_id=eq.${encodeURIComponent(userId)}&select=user_id&limit=1`);
  return Array.isArray(rows)&&rows.length>0;
}

async function uploadLocalToCloud(){
  const s=await ensureSession(); if(!s?.user)return;
  const uid=s.user.id, p=localProfile(); if(!p)return;
  setCloudStatus('Synchro…','busy');
  const username=s.user.user_metadata?.username||s.user.email?.split('@')[0]||null;
  await dbUpsert('profiles',[{
    user_id:uid,username,general_level:Number(p.general)||0,streak:Number(p.streak)||0,best_streak:Number(p.bestStreak)||0,last_active:p.lastActive||null,updated_at:new Date().toISOString()
  }],'user_id');
  const mastery=p.mastery||{};
  await dbUpsert('category_progress',Object.entries(mastery).map(([category,value])=>({user_id:uid,category,mastery:Number(value)||0,updated_at:new Date().toISOString()})),'user_id,category');
  const activity=p.activity||{};
  await dbUpsert('activity_days',Object.entries(activity).map(([activity_date,v])=>({user_id:uid,activity_date,answers:Number(v?.answers)||0,sessions:Number(v?.sessions)||0,general_level:Number(v?.general)||0})),'user_id,activity_date');
  const mistakes=(p.wrongHistory||[]).slice(0,20).filter(x=>x&&x.id&&x.cat&&Array.isArray(x.q));
  await dbDelete('review_mistakes',`?user_id=eq.${encodeURIComponent(uid)}`);
  await dbUpsert('review_mistakes',mistakes.map(x=>({user_id:uid,mistake_key:String(x.id),category:String(x.cat),question:x.q,occurred_at:new Date(Number(x.at)||Date.now()).toISOString()})),'user_id,mistake_key');
  const seen=localSeen().slice(-12000);
  // Seen questions can be large: write in chunks to stay under request limits.
  for(let i=0;i<seen.length;i+=500){
    await dbUpsert('seen_questions',seen.slice(i,i+500).map(id=>({user_id:uid,question_id:String(id),category:String(id).split('|')[0]||'Autre',seen_at:new Date().toISOString()})),'user_id,question_id');
  }
  setCloudStatus('Synchronisé ✓','ok');
}

async function loadCloudToLocal(){
  const s=await ensureSession(); if(!s?.user)return false;
  const uid=s.user.id;
  const [profiles,cats,activity,mistakes,seen]=await Promise.all([
    dbGet('profiles',`?user_id=eq.${encodeURIComponent(uid)}&select=*`),
    dbGet('category_progress',`?user_id=eq.${encodeURIComponent(uid)}&select=category,mastery`),
    dbGet('activity_days',`?user_id=eq.${encodeURIComponent(uid)}&select=*`),
    dbGet('review_mistakes',`?user_id=eq.${encodeURIComponent(uid)}&select=mistake_key,category,question,occurred_at&order=occurred_at.desc&limit=20`),
    dbGet('seen_questions',`?user_id=eq.${encodeURIComponent(uid)}&select=question_id&limit=12000`)
  ]);
  if(!profiles?.length)return false;
  const old=localProfile()||{}; const pr=profiles[0];
  const mastery={}; (cats||[]).forEach(x=>mastery[x.category]=Number(x.mastery)||0);
  const act={}; (activity||[]).forEach(x=>act[x.activity_date]={answers:Number(x.answers)||0,sessions:Number(x.sessions)||0,general:Number(x.general_level)||0});
  const p={
    ...old,
    mastery:Object.keys(mastery).length?mastery:(old.mastery||{}),
    general:Number(pr.general_level)||0,
    streak:Number(pr.streak)||0,
    bestStreak:Number(pr.best_streak)||0,
    lastActive:pr.last_active||old.lastActive||null,
    activity:act,
    wrongHistory:(mistakes||[]).map(x=>({id:x.mistake_key,cat:x.category,q:x.question,at:new Date(x.occurred_at).getTime()}))
  };
  localStorage.setItem('cultivaAssessment',JSON.stringify(p));
  localStorage.setItem('cultivaSeenQuestions',JSON.stringify((seen||[]).map(x=>x.question_id)));
  try{renderProfile()}catch{}
  setCloudStatus('Synchronisé ✓','ok'); return true;
}

function scheduleCloudSync(delay=900){
  if(!cloudSession)return;
  clearTimeout(cloudSyncTimer);
  cloudSyncTimer=setTimeout(async()=>{
    if(cloudSyncing)return; cloudSyncing=true;
    try{await uploadLocalToCloud()}catch(e){setCloudStatus('Hors ligne · local sauvegardé','warn')}finally{cloudSyncing=false}
  },delay);
}

async function afterLogin(){
  const s=await ensureSession(); if(!s?.user)return;
  setCloudStatus('Connexion…','busy');
  const existed=await cloudProfileExists(s.user.id);
  const hadLocal=!!localProfile();
  if(existed) await loadCloudToLocal();
  else if(hadLocal) await uploadLocalToCloud();

  setAccountGate(false);
  accountLabel();
  renderAccountView();
  closeAccount();

  // Profil déjà évalué (cloud ou migration locale) : accès direct à l’app.
  // Compte neuf : on affiche le Level Check seulement après authentification.
  if(existed || hadLocal){
    document.querySelector('#onboarding')?.classList.add('hidden');
    try{renderProfile()}catch{}
  }else{
    document.querySelector('#onboarding')?.classList.remove('hidden');
    const intro=$('#assessmentIntro'), quiz=$('#assessmentQuiz'), result=$('#assessmentResult');
    if(intro)intro.style.display='block';
    if(quiz)quiz.style.display='none';
    if(result)result.style.display='none';
  }
}

function setAccountGate(required){
  accountGate=!!required;
  const modal=$('#accountModal');
  const close=modal?.querySelector('[data-account-action="close"]');
  if(close)close.style.display=accountGate?'none':'';
  modal?.classList.toggle('account-required',accountGate);
}
function openAccount(required=false){
  if(required)setAccountGate(true);
  $('#accountModal')?.classList.add('show');
  renderAccountView();
}
function closeAccount(){
  if(accountGate && !cloudSession?.user)return;
  $('#accountModal')?.classList.remove('show');
}
function renderAccountView(){
  const guest=$('#authGuest'), signed=$('#authSigned'); if(!guest||!signed)return;
  const title=$('#accountTitle'), lead=$('#accountLead');
  if(cloudSession?.user){
    if(title)title.textContent='Ton profil';
    if(lead)lead.textContent='Ta progression Cultiva est liée à ce compte';
    guest.style.display='none'; signed.style.display='block';
    const p=localProfile()||{};
    $('#profileName').textContent=cloudSession.user.user_metadata?.username||cloudSession.user.email?.split('@')[0]||'Cultivator';
    $('#profileEmail').textContent=cloudSession.user.email||'';
    $('#profileLevel').textContent=`${Number(p.general||0).toFixed(1)}/10`;
    $('#profileStreak').textContent=`${Number(p.streak||0)} j`;
    $('#profileBest').textContent=`${Number(p.bestStreak||0)} j`;
  }else{
    if(title)title.textContent=authMode==='signup'?'Crée ton profil':'Connecte-toi';
    if(lead)lead.textContent='Compte requis avant le Level Check';
    guest.style.display='block'; signed.style.display='none';
    updateAuthMode();
  }
}
function updateAuthMode(){
  document.querySelectorAll('.auth-tab').forEach(x=>x.classList.toggle('active',x.dataset.mode===authMode));
  const title=$('#accountTitle'); if(title&&!cloudSession?.user)title.textContent=authMode==='signup'?'Crée ton profil':'Connecte-toi';
  const signup=$('#usernameField'); if(signup)signup.style.display=authMode==='signup'?'block':'none';
  const submit=$('#authSubmit'); if(submit)submit.textContent=authMode==='signup'?'Créer mon profil':'Se connecter';
  const pass=$('#authPassword'); if(pass)pass.autocomplete=authMode==='signup'?'new-password':'current-password';
  setAuthMessage('');
}

async function submitAuth(){
  const email=$('#authEmail')?.value.trim(), pass=$('#authPassword')?.value||'', username=$('#authUsername')?.value.trim();
  if(!email||pass.length<6){setAuthMessage('Email valide + mot de passe de 6 caractères minimum','error');return}
  const btn=$('#authSubmit'); btn.disabled=true; setAuthMessage(authMode==='signup'?'Création…':'Connexion…','');
  try{
    if(authMode==='signup'){
      const r=await signUp(email,pass,username);
      if(!r.confirmed){
        authMode='login'; updateAuthMode();
        setAuthMessage('Compte créé ✦ Confirme ton email, puis connecte-toi ici','ok');
      }else{setAuthMessage('Profil créé ✓','ok');}
    }else{
      await signIn(email,pass); setAuthMessage('Connecté ✓','ok');
    }
  }catch(e){setAuthMessage(e.message||'Impossible de se connecter','error')}
  finally{btn.disabled=false}
}

function bindSyncHooks(){
  const wrap=(name)=>{
    const fn=window[name]; if(typeof fn!=='function')return;
    window[name]=function(...args){const r=fn.apply(this,args);scheduleCloudSync();return r};
  };
  ['saveProfile','recordMistake','touchActivity','updateMastery','markSeen'].forEach(wrap);
}

async function init(){
  if(!SUPABASE_URL||!SUPABASE_KEY){
    setCloudStatus('Profil cloud non configuré','warn');
    setAccountGate(true); openAccount(true); return;
  }
  bindSyncHooks();
  cloudSession=readSession();
  if(cloudSession){
    try{
      await ensureSession();
      if(cloudSession){await afterLogin();return;}
    }catch{saveSession(null)}
  }

  // Aucun accès au Level Check tant qu’un compte n’est pas authentifié.
  setAccountGate(true);
  authMode=localProfile()?'login':'signup';
  accountLabel();
  renderAccountView();
  openAccount(true);
}

document.addEventListener('click',async e=>{
  const a=e.target.closest('[data-account-action]'); if(!a)return;
  const action=a.dataset.accountAction;
  if(action==='open')openAccount();
  else if(action==='close')closeAccount();
  else if(action==='mode'){authMode=a.dataset.mode||'login';updateAuthMode()}
  else if(action==='submit')submitAuth();
  else if(action==='sync'){try{await uploadLocalToCloud()}catch(e){setCloudStatus('Échec synchro','warn')}}
  else if(action==='logout')signOut();
});
$('#accountModal')?.addEventListener('click',e=>{if(e.target.id==='accountModal')closeAccount()});
$('#authPassword')?.addEventListener('keydown',e=>{if(e.key==='Enter')submitAuth()});

init();
})();
