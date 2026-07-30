/* ═══════════════════════════════════════════════════
   WHISPR — script.js  v4
   • "Messages" tab with search by To: name
   • Cinematic reveal animation per delivery style
   • Background objects clickable anywhere on canvas
   • iTunes API song search (no auth needed)
═══════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════
   DATABASE (Supabase)
   1. Create a project at https://supabase.com
   2. Run the SQL below in the Supabase SQL Editor
   3. Paste your Project URL + anon public key here

   ---------------------------------------------------
   create extension if not exists pgcrypto;

   create table messages (
     id         uuid primary key default gen_random_uuid(),
     to_name    text not null,
     message    text not null,
     style      text not null,
     song       jsonb,
     opened     boolean not null default false,
     created_at timestamptz not null default now()
   );

   alter table messages enable row level security;

   -- Anonymous app: anyone can send, read, and mark opened.
   create policy "anyone can read"   on messages for select using (true);
   create policy "anyone can insert" on messages for insert with check (true);
   create policy "anyone can update" on messages for update using (true);

   -- Realtime (lets other open tabs see new messages live)
   alter publication supabase_realtime add table messages;
   ---------------------------------------------------
═══════════════════════════════════════════════ */


const SUPABASE_URL      = 'https://jsivookqnunyafuknsqf.supabase.co';

const SUPABASE_ANON_KEY = 'sb_publishable_owFavaiw2bAybR-fpeZ2xA_DWjK3PxX';


const supabaseClient = (SUPABASE_URL.startsWith('http'))
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

if(!supabaseClient){
  console.warn('Whispr: Supabase is not configured yet — set SUPABASE_URL and SUPABASE_ANON_KEY at the top of script.js. Messages will not be saved or shared.');
}

/* Map a DB row <-> the in-memory message shape the UI already uses */
function rowToItem(row){
  return {
    id:      row.id,
    to:      row.to_name,
    message: row.message,
    style:   row.style,
    song:    row.song || null,
    opened:  row.opened,
  };
}

/* ─── STATE ─── */
let selectedStyle = 'bottle';
let inbox         = [];      // {id, to, message, style, song, opened}
let bgObjects     = [];      // live canvas sprites
let bgRaf         = null;
let bgT           = 0;
let currentTab    = 'send';
let selectedSong  = null;
let songDebounce  = null;
let hoveredObj    = null;
let revealAnim    = null;    // RAF for reveal canvas animation
let revealPhase   = 0;       // time counter for reveal animation

const STYLE_META = {
  bottle:  { emoji:'🌊', label:'Floating Bottle'  },
  letter:  { emoji:'✉️', label:'Flying Letter'    },
  dove:    { emoji:'🕊️', label:'Messenger Dove'   },
  star:    { emoji:'⭐', label:'Shooting Star'    },
  lantern: { emoji:'🏮', label:'Lantern Wish'     },
  scroll:  { emoji:'📜', label:'Magic Scroll'     },
  space:   { emoji:'🚀', label:'Space Delivery'   },
};

/* ─── UTILS ─── */
const lerp  = (a,b,t)   => a+(b-a)*t;
const clamp = (v,a,b)   => Math.max(a,Math.min(b,v));
const rand  = (a,b)     => a+Math.random()*(b-a);
const randI = (a,b)     => Math.floor(rand(a,b+1));
const ease  = t          => 1-Math.pow(1-t,3);
const easeIO= t          => t<.5 ? 4*t*t*t : 1-Math.pow(-2*t+2,3)/2;

/* ─── DOM PARTICLES ─── */
(function(){
  const c=document.getElementById('particles');
  for(let i=0;i<28;i++){
    const p=document.createElement('div');
    p.className='particle';
    const sz=rand(1.5,4), hue=randI(220,280);
    p.style.cssText=`left:${rand(0,100)}%;width:${sz}px;height:${sz}px;
      background:hsla(${hue},70%,70%,.7);
      animation-name:drift;animation-duration:${rand(8,18)}s;
      animation-delay:${rand(0,10)}s;filter:blur(${rand(0,1)}px);`;
    c.appendChild(p);
  }
})();

/* ═══════════════════════════════════════════════
   TABS
═══════════════════════════════════════════════ */
function switchTab(tab){
  currentTab = tab;
  document.getElementById('sendPanel').classList.toggle('hidden', tab!=='send');
  document.getElementById('messagesPanel').classList.toggle('hidden', tab!=='messages');
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));
  if(tab==='messages') renderMessages();
}

/* ═══════════════════════════════════════════════
   SEND FORM
═══════════════════════════════════════════════ */
function updateCount(){
  const len = document.getElementById('msgField').value.length;
  const el  = document.getElementById('charCount');
  el.textContent = `${len} / 500`;
  el.classList.toggle('warn', len>450);
}

function livePreview(){
  const to  = document.getElementById('toField').value.trim();
  const msg = document.getElementById('msgField').value.trim();
  document.getElementById('previewTo').innerHTML = `For <em>${to||'someone special'}</em>`;
  document.getElementById('previewMsg').textContent = msg||'Your message will appear here…';
  const ps = document.getElementById('previewSong');
  if(selectedSong){
    ps.style.display='flex';
    ps.innerHTML=`<img class="preview-song-art" src="${selectedSong.art}" alt=""/> ♫ ${selectedSong.title} — ${selectedSong.artist}`;
  } else {
    ps.style.display='none';
  }
}

function selectStyle(el){
  document.querySelectorAll('.style-card').forEach(b=>{b.classList.remove('active');b.setAttribute('aria-checked','false');});
  el.classList.add('active'); el.setAttribute('aria-checked','true');
  selectedStyle = el.dataset.style;
}
document.querySelectorAll('.style-card').forEach(btn=>{
  btn.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();selectStyle(btn);}});
});

async function sendMsg(){
  const to  = document.getElementById('toField').value.trim();
  const msg = document.getElementById('msgField').value.trim();
  const btn = document.getElementById('sendBtn');
  if(!to){  showBtnErr(btn,'Who is this for?'); return; }
  if(!msg){ showBtnErr(btn,'Write something first'); return; }

  if(!supabaseClient){ showBtnErr(btn,'Database not configured'); return; }

  const song = selectedSong ? {...selectedSong} : null;
  btn.classList.add('loading');
  btn.disabled = true;

  const { data, error } = await supabaseClient
    .from('messages')
    .insert({ to_name: to, message: msg, style: selectedStyle, song, opened: false })
    .select()
    .single();

  btn.classList.remove('loading');
  btn.disabled = false;

  if(error){
    console.error(error);
    showBtnErr(btn,'Send failed — try again');
    return;
  }

  const item = rowToItem(data);
  inbox.unshift(item);
  spawnBgObj(item);
  updateBadge();

  btn.classList.add('sent');
  btn.querySelector('.send-inner').innerHTML =
    `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Delivered ✦`;

  const meta = STYLE_META[selectedStyle];
  const songLine = selectedSong ? ` With ♫ "${selectedSong.title}".` : '';
  document.getElementById('successSub').textContent = `${meta.emoji} "${to}" will receive it via ${meta.label}.${songLine}`;

  setTimeout(()=>{
    document.getElementById('formArea').style.display='none';
    document.getElementById('successScreen').classList.add('visible');
  },700);
}

function showBtnErr(btn,text){
  btn.classList.add('error');
  btn.querySelector('.send-inner').textContent = '⚠ '+text;
  setTimeout(()=>{
    btn.classList.remove('error');
    btn.querySelector('.send-inner').innerHTML =
      `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> Send Anonymously`;
  },2200);
}

function resetForm(){
  document.getElementById('toField').value='';
  document.getElementById('msgField').value='';
  updateCount(); livePreview();
  document.querySelectorAll('.style-card').forEach(b=>{b.classList.remove('active');b.setAttribute('aria-checked','false');});
  const f = document.querySelector('[data-style="bottle"]');
  f.classList.add('active'); f.setAttribute('aria-checked','true');
  selectedStyle='bottle';
  const btn = document.getElementById('sendBtn');
  btn.classList.remove('sent','error');
  btn.querySelector('.send-inner').innerHTML =
    `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> Send Anonymously`;
  document.getElementById('successScreen').classList.remove('visible');
  document.getElementById('formArea').style.display='';
  clearSong();
}

/* ═══════════════════════════════════════════════
   SONG SEARCH (iTunes API — no auth)
═══════════════════════════════════════════════ */
function debounceSongSearch(){
  clearTimeout(songDebounce);
  songDebounce = setTimeout(doSongSearch, 340);
}

function onSongFocus(){
  const q = document.getElementById('songSearch').value.trim();
  if(q.length>1) showSongResults(document.getElementById('songResults').__lastData||[]);
}

async function doSongSearch(){
  const q  = document.getElementById('songSearch').value.trim();
  const el = document.getElementById('songResults');
  if(!q||q.length<2){ el.classList.remove('open'); return; }
  el.classList.add('open');
  el.innerHTML=`<div class="song-result-loading"><div class="spin"></div>Searching…</div>`;
  try{
    const url  = `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=song&limit=6&media=music`;
    const data = await (await fetch(url)).json();
    el.__lastData = data.results||[];
    showSongResults(data.results||[]);
  }catch{
    el.innerHTML=`<div class="song-no-results">Search unavailable. Try again.</div>`;
  }
}

function showSongResults(tracks){
  const el = document.getElementById('songResults');
  if(!tracks.length){ el.innerHTML=`<div class="song-no-results">No results found.</div>`; return; }
  el.innerHTML = tracks.map((t,i)=>{
    const art  = t.artworkUrl60||'';
    const mins = Math.floor(t.trackTimeMillis/60000);
    const secs = String(Math.floor((t.trackTimeMillis%60000)/1000)).padStart(2,'0');
    return `<div class="song-result-item" onclick="pickSong(${i})">
      <img class="sri-art" src="${art}" alt=""/>
      <div class="sri-info">
        <div class="sri-title">${t.trackName}</div>
        <div class="sri-sub">${t.artistName} · ${t.collectionName||''}</div>
      </div>
      <span class="sri-dur">${mins}:${secs}</span>
    </div>`;
  }).join('');
  el.__trackData = tracks;
}

function pickSong(idx){
  const tracks = document.getElementById('songResults').__trackData;
  if(!tracks||!tracks[idx]) return;
  const t = tracks[idx];
  selectedSong = {
    title:  t.trackName,
    artist: t.artistName,
    album:  t.collectionName||'',
    art:    t.artworkUrl100||t.artworkUrl60||'',
    spotUrl:`https://open.spotify.com/search/${encodeURIComponent(t.trackName+' '+t.artistName)}`,
  };
  document.getElementById('songSearch').value = `${t.trackName} — ${t.artistName}`;
  document.getElementById('songResults').classList.remove('open');
  document.getElementById('songClearBtn').style.display='flex';
  const ss = document.getElementById('songSelected');
  ss.style.display='flex';
  ss.innerHTML=`<img class="ss-art" src="${selectedSong.art}" alt=""/>
    <div class="ss-info"><div class="ss-title">${selectedSong.title}</div><div class="ss-artist">${selectedSong.artist}</div></div>
    <button class="ss-remove" onclick="clearSong()">✕</button>`;
  livePreview();
}

function clearSong(){
  selectedSong=null;
  document.getElementById('songSearch').value='';
  document.getElementById('songResults').classList.remove('open');
  document.getElementById('songResults').innerHTML='';
  document.getElementById('songSelected').style.display='none';
  document.getElementById('songClearBtn').style.display='none';
  livePreview();
}

document.addEventListener('click',e=>{
  if(!e.target.closest('.song-search-wrap'))
    document.getElementById('songResults').classList.remove('open');
});

/* ═══════════════════════════════════════════════
   MESSAGES PANEL
═══════════════════════════════════════════════ */
function updateBadge(){
  const n = inbox.filter(m=>!m.opened).length;
  const b = document.getElementById('msgBadge');
  b.textContent=n; b.classList.toggle('show',n>0);
}

function filterMessages(){
  const q   = document.getElementById('msgSearch').value.trim().toLowerCase();
  const clr = document.getElementById('msgSearchClear');
  clr.style.display = q ? 'block' : 'none';
  renderMessages(q);
}

function clearMsgSearch(){
  document.getElementById('msgSearch').value='';
  document.getElementById('msgSearchClear').style.display='none';
  renderMessages();
}

function renderMessages(filter=''){
  const list    = document.getElementById('msgList');
  const empty   = document.getElementById('msgEmpty');
  const noRes   = document.getElementById('msgNoResults');

  const filtered = filter
    ? inbox.filter(m=>m.to.toLowerCase().includes(filter))
    : inbox;

  noRes.classList.toggle('hidden', true);
  if(!inbox.length){ list.innerHTML=''; empty.style.display='block'; return; }
  empty.style.display='none';

  if(!filtered.length){
    list.innerHTML='';
    noRes.classList.remove('hidden');
    return;
  }

  list.innerHTML = filtered.map((m,i)=>{
    const meta = STYLE_META[m.style];
    const prev = m.message.length>44 ? m.message.slice(0,44)+'…' : m.message;
    const origIdx = inbox.indexOf(m);
    const songLine = m.song
      ? `<div class="msg-has-song"><svg width="10" height="10" viewBox="0 0 24 24" fill="#1DB954"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg>♫ ${m.song.title}</div>`
      : '';
    return `<div class="msg-item${m.opened?' opened':''}" onclick="openMessage(${origIdx})"
               style="animation:slideIn .3s ease ${i*.06}s both;">
      <span class="msg-emoji">${meta.emoji}</span>
      <div class="msg-meta">
        <div class="msg-to-lbl">For <span class="msg-to-name">${m.to}</span> · ${meta.label}</div>
        <div class="msg-preview${m.opened?'':' blur'}">${prev}</div>
        ${songLine}
      </div>
      <span class="msg-arrow">›</span>
      ${!m.opened?'<span class="msg-dot"></span>':''}
    </div>`;
  }).join('');
}

function openMessage(idx){
  const item = inbox[idx];
  if(!item.opened){
    item.opened = true;
    updateBadge();
    if(currentTab==='messages') renderMessages(document.getElementById('msgSearch').value.trim().toLowerCase());
    if(supabaseClient){
      supabaseClient.from('messages').update({opened:true}).eq('id', item.id)
        .then(({error})=>{ if(error) console.error(error); });
    }
  }
  showReveal(item);
}

/* ═══════════════════════════════════════════════
   REVEAL MODAL — cinematic entrance per style
═══════════════════════════════════════════════ */
const revealCanvas  = document.getElementById('revealCanvas');
const revealCtx     = revealCanvas.getContext('2d');
const revealOverlay = document.getElementById('revealOverlay');
const revealCardEl  = document.getElementById('revealCard');

function resizeRevealCanvas(){
  revealCanvas.width  = window.innerWidth;
  revealCanvas.height = window.innerHeight;
}
resizeRevealCanvas();
window.addEventListener('resize', resizeRevealCanvas);

function showReveal(msg){
  const meta = STYLE_META[msg.style];

  // Fill card content
  document.getElementById('revealEmoji').textContent    = meta.emoji;
  document.getElementById('revealTo').innerHTML         = `For <strong>${msg.to}</strong>`;
  document.getElementById('revealText').textContent     = msg.message;
  document.getElementById('revealDelivery').textContent = `${meta.emoji} Delivered via ${meta.label}`;

  const sc = document.getElementById('revealSongCard');
  if(msg.song){
    sc.style.display='flex';
    document.getElementById('revealSongArt').src         = msg.song.art;
    document.getElementById('revealSongTitle').textContent  = msg.song.title;
    document.getElementById('revealSongArtist').textContent = msg.song.artist;
    document.getElementById('revealSongLink').href       = msg.song.spotUrl;
  } else {
    sc.style.display='none';
  }

  // Show overlay
  revealOverlay.classList.add('open');
  document.body.style.overflow='hidden';
  revealCardEl.classList.remove('card-in');

  // Run cinematic animation, then show card
  revealPhase=0;
  cancelAnimationFrame(revealAnim);
  runRevealAnim(msg.style, ()=>{
    revealCardEl.classList.add('card-in');
  });
}

function closeReveal(){
  cancelAnimationFrame(revealAnim);
  revealOverlay.classList.remove('open');
  revealCardEl.classList.remove('card-in');
  document.body.style.overflow='';
  revealCtx.clearRect(0,0,revealCanvas.width,revealCanvas.height);
  if(currentTab==='messages') renderMessages(document.getElementById('msgSearch').value.trim().toLowerCase());
}
document.addEventListener('keydown',e=>{ if(e.key==='Escape') closeReveal(); });

/* ─── Reveal animation dispatcher ─── */
function runRevealAnim(style, onDone){
  const anims = {
    bottle:  revealAnimBottle,
    letter:  revealAnimLetter,
    dove:    revealAnimDove,
    star:    revealAnimStar,
    lantern: revealAnimLantern,
    scroll:  revealAnimScroll,
    space:   revealAnimSpace,
  };
  (anims[style]||revealAnimStar)(onDone);
}

function revealAnimBase(drawFn, totalFrames, onDone){
  let t=0;
  function tick(){
    const W=revealCanvas.width, H=revealCanvas.height;
    revealCtx.clearRect(0,0,W,H);
    const p=clamp(t/totalFrames,0,1);
    drawFn(revealCtx,W,H,p,t);
    t++;
    if(t<totalFrames+20){ revealAnim=requestAnimationFrame(tick); }
    else { onDone(); }
  }
  revealAnim=requestAnimationFrame(tick);
}

/* 🌊 BOTTLE reveal — ocean rises from bottom */
function revealAnimBottle(onDone){
  revealAnimBase((ctx,W,H,p,t)=>{
    // Dark overlay fades in
    ctx.fillStyle=`rgba(2,20,40,${p*.85})`;
    ctx.fillRect(0,0,W,H);
    // Waves fill up
    const waveTop=lerp(H,H*.35,ease(p));
    for(let layer=0;layer<4;layer++){
      ctx.beginPath(); ctx.moveTo(0,H);
      for(let x=0;x<=W;x+=6){
        const y=waveTop+layer*28+Math.sin((x/W)*Math.PI*4+t*.07+layer)*(18-layer*3)+Math.sin((x/W)*Math.PI*7+t*.11)*8;
        ctx.lineTo(x,y);
      }
      ctx.lineTo(W,H); ctx.closePath();
      ctx.fillStyle=`rgba(${layer===0?'7,89,133':'14,116,144'},${.18+layer*.06})`;
      ctx.fill();
    }
    // Glitter on water
    if(t%4===0) for(let i=0;i<6;i++){
      const gx=rand(0,W), gy=waveTop+rand(-10,40);
      ctx.beginPath(); ctx.arc(gx,gy,rand(.5,2),0,Math.PI*2);
      ctx.fillStyle=`rgba(125,211,252,${rand(.3,.8)})`; ctx.fill();
    }
    // Giant bottle rising from water
    const bottleY=lerp(H+80,H*.35,ease(p));
    ctx.save(); ctx.translate(W*.5,bottleY);
    ctx.rotate(Math.sin(t*.04)*.06);
    ctx.scale(3,3);
    drawMiniBottle(ctx,0,0);
    ctx.restore();
  }, 90, onDone);
}

/* ✉️ LETTER reveal — envelope zips in from right */
function revealAnimLetter(onDone){
  const sparks=Array.from({length:20},()=>({x:0,y:0,vx:rand(-4,4),vy:rand(-5,-1),life:0,maxLife:rand(40,70),born:60}));
  revealAnimBase((ctx,W,H,p,t)=>{
    ctx.fillStyle=`rgba(10,5,30,${p*.88})`; ctx.fillRect(0,0,W,H);
    // Stars
    for(let i=0;i<60;i++){
      const a=.3+Math.sin(t*.04+i)*.2;
      ctx.beginPath(); ctx.arc((i*137.5)%W,(i*89.3)%(H*.6),.8,0,Math.PI*2);
      ctx.fillStyle=`rgba(255,255,255,${a})`; ctx.fill();
    }
    const ex=lerp(W+120,W*.5,ease(Math.min(p/.6,1)));
    const ey=lerp(H*.2,H*.38,ease(Math.min(p/.6,1)));
    // Motion lines
    if(p<.6) for(let l=1;l<=4;l++){
      ctx.beginPath(); ctx.moveTo(ex-l*28,ey-l*7); ctx.lineTo(ex-l*28+22,ey-l*7);
      ctx.strokeStyle=`rgba(165,180,252,${.25-l*.05})`; ctx.lineWidth=2; ctx.stroke();
    }
    // Burst sparks at arrival
    if(t>=60){
      sparks.forEach(s=>{
        const age=t-s.born; if(age<0||age>s.maxLife) return;
        const lf=age/s.maxLife;
        ctx.beginPath(); ctx.arc(W*.5+s.vx*age,H*.38+s.vy*age+.03*age*age,2*(1-lf),0,Math.PI*2);
        ctx.fillStyle=`rgba(196,181,253,${1-lf})`; ctx.fill();
      });
    }
    ctx.save(); ctx.translate(ex,ey); ctx.scale(4,4);
    drawMiniLetter(ctx,0,0,t);
    ctx.restore();
  }, 90, onDone);
}

/* 🕊️ DOVE reveal — dove glides diagonally */
function revealAnimDove(onDone){
  revealAnimBase((ctx,W,H,p,t)=>{
    // Dawn sky
    const sky=ctx.createLinearGradient(0,0,0,H);
    sky.addColorStop(0,`rgba(5,46,22,${p*.9})`);
    sky.addColorStop(1,`rgba(2,20,10,${p*.9})`);
    ctx.fillStyle=sky; ctx.fillRect(0,0,W,H);
    // Clouds
    [[.2,.15],[.7,.1],[.5,.22]].forEach(([cx,cy],i)=>{
      ctx.save(); ctx.translate(W*cx+Math.sin(t*.01+i)*10,H*cy);
      ctx.scale(1+i*.4,1); ctx.globalAlpha=p*.3;
      ctx.beginPath(); ctx.arc(0,0,30,0,Math.PI*2);
      ctx.arc(24,-10,22,0,Math.PI*2); ctx.arc(-22,-5,18,0,Math.PI*2);
      ctx.fillStyle='rgba(255,255,255,1)'; ctx.fill();
      ctx.restore();
    });
    const dx=lerp(-80,W*.5,ease(Math.min(p/.7,1)));
    const dy=lerp(H*.1,H*.38,ease(Math.min(p/.7,1)));
    // Feather trail
    if(p<.7&&t%8===0){
      ctx.save(); ctx.translate(dx-20,dy-5); ctx.rotate(rand(-.3,.3));
      ctx.fillStyle='rgba(255,255,255,.4)';
      ctx.beginPath(); ctx.ellipse(0,0,3,10,0,0,Math.PI*2); ctx.fill();
      ctx.restore();
    }
    ctx.save(); ctx.translate(dx,dy); ctx.scale(4,4);
    drawMiniDove(ctx,0,0,t*.18);
    ctx.restore();
  }, 90, onDone);
}

/* ⭐ STAR reveal — shooting star streaks screen */
function revealAnimStar(onDone){
  const stars=Array.from({length:140},()=>({
    x:rand(0,1),y:rand(0,1),r:rand(.5,1.8),twinkle:rand(0,Math.PI*2)
  }));
  revealAnimBase((ctx,W,H,p,t)=>{
    ctx.fillStyle=`rgba(4,2,20,${p*.95})`; ctx.fillRect(0,0,W,H);
    // Star field
    stars.forEach(s=>{
      const a=.4+Math.sin(t*.05+s.twinkle)*.3;
      ctx.beginPath(); ctx.arc(s.x*W,s.y*H,s.r,0,Math.PI*2);
      ctx.fillStyle=`rgba(255,255,255,${a*p})`; ctx.fill();
    });
    // Shooting star streaks across
    const streakP=clamp(p/.55,0,1);
    if(streakP<1){
      const sx=lerp(-60,W+60,streakP);
      const sy=lerp(H*.1,H*.55,streakP);
      const tail=100;
      const grad=ctx.createLinearGradient(sx-tail,sy-tail*.5,sx,sy);
      grad.addColorStop(0,'rgba(196,132,252,0)');
      grad.addColorStop(1,'rgba(253,224,71,.95)');
      ctx.beginPath(); ctx.moveTo(sx-tail,sy-tail*.5); ctx.lineTo(sx,sy);
      ctx.strokeStyle=grad; ctx.lineWidth=3; ctx.stroke();
      ctx.beginPath(); ctx.arc(sx,sy,6,0,Math.PI*2);
      ctx.fillStyle='#fef08a'; ctx.fill();
    }
    // Burst when streak ends (p>.55)
    const burstP=clamp((p-.55)/.35,0,1);
    if(burstP>0){
      const cx=W*.5+60,cy=H*.4;
      for(let i=0;i<16;i++){
        const angle=(i/16)*Math.PI*2;
        const len=burstP*80;
        ctx.beginPath(); ctx.moveTo(cx,cy);
        ctx.lineTo(cx+Math.cos(angle)*len,cy+Math.sin(angle)*len);
        ctx.strokeStyle=`rgba(253,224,71,${(1-burstP)*.8})`; ctx.lineWidth=2; ctx.stroke();
      }
      const g=ctx.createRadialGradient(cx,cy,0,cx,cy,60*burstP);
      g.addColorStop(0,'rgba(254,240,138,.85)'); g.addColorStop(1,'transparent');
      ctx.beginPath(); ctx.arc(cx,cy,60*burstP,0,Math.PI*2);
      ctx.fillStyle=g; ctx.fill();
    }
  }, 95, onDone);
}

/* 🏮 LANTERN reveal — glowing lantern descends */
function revealAnimLantern(onDone){
  const motes=Array.from({length:30},()=>({x:rand(0,1),vy:rand(-.5,-.15),vx:rand(-.2,.2),life:rand(0,1),size:rand(1,3)}));
  revealAnimBase((ctx,W,H,p,t)=>{
    const night=ctx.createLinearGradient(0,0,0,H);
    night.addColorStop(0,`rgba(10,3,0,${p*.95})`);
    night.addColorStop(1,`rgba(28,10,0,${p*.95})`);
    ctx.fillStyle=night; ctx.fillRect(0,0,W,H);
    // Stars
    for(let i=0;i<80;i++){
      const a=.3+Math.sin(t*.03+i)*.2;
      ctx.beginPath(); ctx.arc((i*137.5)%W,(i*89.3)%(H*.7),.7,0,Math.PI*2);
      ctx.fillStyle=`rgba(255,255,200,${a*p})`; ctx.fill();
    }
    // Motes
    motes.forEach(m=>{
      m.life+=.012; if(m.life>1) m.life=0;
      const a=Math.sin(m.life*Math.PI)*p;
      ctx.beginPath(); ctx.arc(m.x*W,H-(m.life*H*.6),m.size,0,Math.PI*2);
      ctx.fillStyle=`rgba(251,191,36,${a*.6})`; ctx.fill();
    });
    const ly=lerp(-80,H*.35,ease(p));
    const glow=.5+Math.sin(t*.1)*.3;
    // Halo
    const halo=ctx.createRadialGradient(W*.5,ly,0,W*.5,ly,120);
    halo.addColorStop(0,`rgba(251,146,60,${glow*.4*p})`); halo.addColorStop(1,'transparent');
    ctx.beginPath(); ctx.arc(W*.5,ly,120,0,Math.PI*2); ctx.fillStyle=halo; ctx.fill();
    ctx.save(); ctx.translate(W*.5,ly); ctx.scale(5,5); ctx.rotate(Math.sin(t*.03)*.1);
    drawMiniLantern(ctx,0,0,glow);
    ctx.restore();
  }, 90, onDone);
}

/* 📜 SCROLL reveal — scroll unrolls from center */
function revealAnimScroll(onDone){
  revealAnimBase((ctx,W,H,p,t)=>{
    const bg=ctx.createLinearGradient(0,0,W,H);
    bg.addColorStop(0,`rgba(20,14,0,${p*.92})`);
    bg.addColorStop(1,`rgba(40,28,0,${p*.92})`);
    ctx.fillStyle=bg; ctx.fillRect(0,0,W,H);
    // Magical motes
    for(let i=0;i<30;i++){
      const mx=(i*173.5)%W, my=(H*.5)+Math.sin(t*.04+i)*60;
      const a=.2+Math.sin(t*.06+i)*.15;
      ctx.beginPath(); ctx.arc(mx,my,rand(1,3),0,Math.PI*2);
      ctx.fillStyle=`rgba(202,138,4,${a*p})`; ctx.fill();
    }
    // Scroll unrolling
    const openH=lerp(0,H*.55,ease(p));
    const sw=Math.min(W*.6,320), sx=W*.5-sw*.5, sy=H*.5-openH*.5;
    ctx.save();
    // Parchment
    ctx.fillStyle=`rgba(254,249,195,${p*.85})`;
    ctx.strokeStyle=`rgba(202,138,4,${p*.7})`; ctx.lineWidth=2;
    rrect(ctx,sx,sy,sw,openH,5); ctx.fill(); ctx.stroke();
    // Lines on parchment
    for(let l=0;l<8;l++){
      const ly=sy+20+l*30; if(ly>sy+openH-18) break;
      ctx.beginPath(); ctx.moveTo(sx+16,ly); ctx.lineTo(sx+sw-16,ly);
      ctx.strokeStyle=`rgba(161,116,10,${p*.25})`; ctx.lineWidth=.8; ctx.stroke();
    }
    // Rollers
    ctx.fillStyle=`rgba(146,64,14,${p*.9})`;
    rrect(ctx,sx-6,sy-8,sw+12,16,7); ctx.fill();
    rrect(ctx,sx-6,sy+openH-8,sw+12,16,7); ctx.fill();
    ctx.restore();
    // Glow shimmer
    const shimmer=ctx.createRadialGradient(W*.5,H*.5,0,W*.5,H*.5,120);
    shimmer.addColorStop(0,`rgba(202,138,4,${p*.15})`); shimmer.addColorStop(1,'transparent');
    ctx.fillStyle=shimmer; ctx.beginPath(); ctx.arc(W*.5,H*.5,120,0,Math.PI*2); ctx.fill();
  }, 90, onDone);
}

/* 🚀 SPACE reveal — rocket descends and lands */
function revealAnimSpace(onDone){
  const stars=Array.from({length:100},()=>({
    x:rand(0,1),y:rand(0,1),r:rand(.5,1.8),c:['255,255,255','180,180,255','255,220,180'][randI(0,2)],tw:rand(0,Math.PI*2)
  }));
  revealAnimBase((ctx,W,H,p,t)=>{
    const space=ctx.createLinearGradient(0,0,0,H);
    space.addColorStop(0,`rgba(2,6,23,${p*.95})`);
    space.addColorStop(1,`rgba(10,18,40,${p*.95})`);
    ctx.fillStyle=space; ctx.fillRect(0,0,W,H);
    stars.forEach(s=>{
      const a=.4+Math.sin(t*.04+s.tw)*.3;
      ctx.beginPath(); ctx.arc(s.x*W,s.y*H,s.r,0,Math.PI*2);
      ctx.fillStyle=`rgba(${s.c},${a*p})`; ctx.fill();
    });
    // Landing pad
    const padY=H*.72;
    ctx.fillStyle=`rgba(100,116,139,${p*.4})`;
    ctx.fillRect(W*.3,padY,W*.4,8);
    ctx.strokeStyle=`rgba(148,163,184,${p*.4})`; ctx.lineWidth=1;
    ctx.beginPath(); ctx.arc(W*.5,padY+4,40,0,Math.PI*2); ctx.stroke();
    // Rocket descent
    const ry=lerp(-80,padY-65,ease(p));
    const rx=W*.5+Math.sin(t*.015)*10;
    const flame=.5+Math.sin(t*.2)*.35;
    // Exhaust plume
    if(t%2===0&&p<.9){
      const fg=ctx.createRadialGradient(rx,ry+45,0,rx,ry+45,25*flame);
      fg.addColorStop(0,'rgba(255,180,40,.8)'); fg.addColorStop(1,'transparent');
      ctx.beginPath(); ctx.ellipse(rx,ry+45,10,22*flame,0,0,Math.PI*2);
      ctx.fillStyle=fg; ctx.fill();
    }
    ctx.save(); ctx.translate(rx,ry); ctx.scale(4.5,4.5);
    drawMiniRocket(ctx,0,0,flame*(1-p*.9));
    ctx.restore();
  }, 100, onDone);
}

/* ─── Mini sprite helpers for reveal animations ─── */
function drawMiniBottle(ctx,x,y){
  const bob=0;
  ctx.fillStyle='rgba(125,211,252,.6)'; ctx.strokeStyle='rgba(186,230,253,.8)'; ctx.lineWidth=.8;
  rrect(ctx,x-5,y+bob-11,10,17,3); ctx.fill(); ctx.stroke();
  ctx.fillStyle='rgba(103,196,245,.7)'; rrect(ctx,x-3,y+bob-16,6,6,2); ctx.fill();
  ctx.fillStyle='#c8a96e'; rrect(ctx,x-3,y+bob-19,6,4,2); ctx.fill();
  ctx.fillStyle='rgba(255,252,220,.7)'; rrect(ctx,x-3,y+bob-7,6,6,1); ctx.fill();
}
function drawMiniLetter(ctx,x,y,t){
  const ew=22,eh=15,flapAmt=(Math.sin((t||0)*.08)+1)/2;
  ctx.fillStyle='rgba(224,231,255,.8)'; ctx.strokeStyle='rgba(165,180,252,.7)'; ctx.lineWidth=.7;
  rrect(ctx,x-ew/2,y-eh/2,ew,eh,3); ctx.fill(); ctx.stroke();
  ctx.save(); ctx.translate(0,y-eh/2); ctx.rotate(-flapAmt*.7); ctx.translate(0,-(y-eh/2));
  ctx.beginPath(); ctx.moveTo(x-ew/2,y-eh/2); ctx.lineTo(x,y-eh/2+eh*.42); ctx.lineTo(x+ew/2,y-eh/2);
  ctx.closePath(); ctx.fillStyle=`rgba(196,181,253,${.5+flapAmt*.3})`; ctx.fill(); ctx.stroke();
  ctx.restore();
}
function drawMiniDove(ctx,x,y,wingPhase){
  const wf=Math.sin(wingPhase)*7;
  ctx.fillStyle='rgba(240,253,244,.8)'; ctx.strokeStyle='rgba(187,247,208,.5)'; ctx.lineWidth=.7;
  ctx.beginPath(); ctx.ellipse(x-8,y-1+wf,9,4,-.3,0,Math.PI*2); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.ellipse(x+8,y-1+wf,9,4,.3,0,Math.PI*2); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.ellipse(x,y,10,6,0,0,Math.PI*2); ctx.fillStyle='rgba(240,253,244,.9)'; ctx.fill();
  ctx.beginPath(); ctx.arc(x+10,y-2,4,0,Math.PI*2); ctx.fill();
  ctx.fillStyle='#1e293b'; ctx.beginPath(); ctx.arc(x+12,y-3,1,0,Math.PI*2); ctx.fill();
  ctx.fillStyle='#f59e0b'; ctx.beginPath(); ctx.moveTo(x+14,y-2); ctx.lineTo(x+17,y-1); ctx.lineTo(x+14,y); ctx.fill();
}
function drawMiniLantern(ctx,x,y,glow){
  ctx.strokeStyle='rgba(251,191,36,.5)'; ctx.lineWidth=.7;
  ctx.beginPath(); ctx.moveTo(x,y-15); ctx.lineTo(x,y-22); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x-7,y-14); ctx.bezierCurveTo(x-11,y-5,x-11,y+5,x-7,y+14);
  ctx.lineTo(x+7,y+14); ctx.bezierCurveTo(x+11,y+5,x+11,y-5,x+7,y-14);
  ctx.closePath(); ctx.fillStyle='rgba(220,38,38,.85)'; ctx.fill();
  const core=ctx.createRadialGradient(x,y,0,x,y,8);
  core.addColorStop(0,`rgba(251,191,36,${glow*.9})`); core.addColorStop(1,'transparent');
  ctx.beginPath(); ctx.ellipse(x,y,7,10,0,0,Math.PI*2); ctx.fillStyle=core; ctx.fill();
  ctx.fillStyle='rgba(251,191,36,.8)';
  ctx.beginPath(); ctx.ellipse(x,y-14,4,2,0,0,Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(x,y+14,4,2,0,0,Math.PI*2); ctx.fill();
}
function drawMiniRocket(ctx,x,y,flame){
  if(flame>.05){
    const fl=ctx.createRadialGradient(x,y+14,0,x,y+14,10*flame);
    fl.addColorStop(0,'rgba(255,200,50,.9)'); fl.addColorStop(1,'transparent');
    ctx.beginPath(); ctx.ellipse(x,y+14,5,10*flame,0,0,Math.PI*2); ctx.fillStyle=fl; ctx.fill();
  }
  ctx.beginPath(); ctx.moveTo(x,y-14); ctx.lineTo(x+5,y+7); ctx.lineTo(x+3,y+10); ctx.lineTo(x-3,y+10); ctx.lineTo(x-5,y+7); ctx.closePath();
  ctx.fillStyle='rgba(226,232,240,.85)'; ctx.strokeStyle='rgba(148,163,184,.5)'; ctx.lineWidth=.6; ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x,y-14); ctx.lineTo(x+4.5,y-4); ctx.lineTo(x-4.5,y-4); ctx.closePath();
  ctx.fillStyle='rgba(239,68,68,.85)'; ctx.fill();
  ctx.beginPath(); ctx.arc(x,y+1,3,0,Math.PI*2);
  ctx.fillStyle='rgba(186,230,254,.85)'; ctx.fill();
  ctx.fillStyle='rgba(203,213,225,.75)';
  ctx.beginPath(); ctx.moveTo(x+5,y+3); ctx.lineTo(x+12,y+10); ctx.lineTo(x+5,y+10); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.moveTo(x-5,y+3); ctx.lineTo(x-12,y+10); ctx.lineTo(x-5,y+10); ctx.closePath(); ctx.fill();
}

/* helper: rounded rect path */
function rrect(ctx,x,y,w,h,r){
  ctx.beginPath();
  ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y); ctx.quadraticCurveTo(x+w,y,x+w,y+r);
  ctx.lineTo(x+w,y+h-r); ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
  ctx.lineTo(x+r,y+h); ctx.quadraticCurveTo(x,y+h,x,y+h-r);
  ctx.lineTo(x,y+r); ctx.quadraticCurveTo(x,y,x+r,y); ctx.closePath();
}

/* ═══════════════════════════════════════════════
   BACKGROUND CANVAS
   All inbox items float + glow + click to open
═══════════════════════════════════════════════ */
const bgCanvas  = document.getElementById('bgCanvas');
const bgCtx     = bgCanvas.getContext('2d');
const bgTooltip = document.getElementById('bgTooltip');

function resizeBg(){ bgCanvas.width=window.innerWidth; bgCanvas.height=window.innerHeight; }
resizeBg(); window.addEventListener('resize',resizeBg);

/* Mouse / touch tracking */
let mouseX=0, mouseY=0;

document.addEventListener('mousemove',e=>{
  mouseX=e.clientX; mouseY=e.clientY;
  handleBgHover(e.clientX,e.clientY);
});
document.addEventListener('touchmove',e=>{
  if(e.touches.length){ mouseX=e.touches[0].clientX; mouseY=e.touches[0].clientY; }
},{passive:true});

/* Click detection — fires on document, ignored if panel/modal was target */
document.addEventListener('click',e=>{
  // Ignore clicks that land on any UI element above the canvas
  if(e.target.closest('.app-wrapper,.reveal-overlay,.bg-tooltip')) return;
  const hit=bgObjAt(mouseX,mouseY);
  if(hit){
    const idx=inbox.indexOf(hit.msgRef);
    if(idx!==-1) openMessage(idx);
  }
});

/* Touch tap on canvas area */
document.addEventListener('touchend',e=>{
  if(e.target.closest('.app-wrapper,.reveal-overlay,.bg-tooltip')) return;
  if(e.changedTouches.length){
    const tx=e.changedTouches[0].clientX, ty=e.changedTouches[0].clientY;
    const hit=bgObjAt(tx,ty);
    if(hit){ const idx=inbox.indexOf(hit.msgRef); if(idx!==-1) openMessage(idx); }
  }
},{passive:true});

function bgObjAt(mx,my){
  for(let i=bgObjects.length-1;i>=0;i--){
    const o=bgObjects[i];
    const dx=mx-o.x, dy=my-o.y;
    if(Math.sqrt(dx*dx+dy*dy)<o.hitRadius) return o;
  }
  return null;
}

function handleBgHover(mx,my){
  const hit=bgObjAt(mx,my);
  if(hit){
    if(hit!==hoveredObj){
      hoveredObj=hit;
      bgTooltip.textContent=`${hit.meta.emoji} Tap to open — for ${hit.msgRef.to}`;
      bgTooltip.classList.add('show');
    }
    bgTooltip.style.left=mx+'px';
    bgTooltip.style.top=(my-46)+'px';
    document.body.style.cursor='pointer';
  } else {
    if(hoveredObj){ hoveredObj=null; bgTooltip.classList.remove('show'); document.body.style.cursor=''; }
  }
}

/* Spawn bg sprite */
function spawnBgObj(msg){
  const W=bgCanvas.width, H=bgCanvas.height;
  bgObjects.push({
    msgRef:   msg,
    style:    msg.style,
    meta:     STYLE_META[msg.style],
    x:        rand(W*.15,W*.85),
    y:        rand(H*.15,H*.85),
    phase:    rand(0,Math.PI*2),
    speed:    rand(.005,.012),
    driftX:   rand(-.35,.35),
    driftY:   rand(-.35,.35),
    scale:    rand(.85,1.15),
    hitRadius:50,
    age:      0,
    wingPhase:0,
    waveT:    0,
    sparkles: Array.from({length:6},()=>({angle:rand(0,Math.PI*2),dist:rand(20,45),speed:rand(.02,.06),size:rand(1,2.5),alpha:rand(.3,.8)})),
    particles:Array.from({length:4},()=>({vy:rand(-.4,-.15),vx:rand(-.2,.2),y:0,x:0,life:rand(0,1),size:rand(1.5,3)})),
    label:    `For ${msg.to}`,
  });
}

/* BG draw loop */
function drawBg(){
  const W=bgCanvas.width, H=bgCanvas.height;
  bgCtx.clearRect(0,0,W,H);
  // Cosmos base
  const base=bgCtx.createLinearGradient(0,0,W,H);
  base.addColorStop(0,'#06060f'); base.addColorStop(.5,'#0d0916'); base.addColorStop(1,'#06060f');
  bgCtx.fillStyle=base; bgCtx.fillRect(0,0,W,H);
  drawNebula(W,H);

  bgObjects.forEach(obj=>{
    obj.age++; obj.phase+=obj.speed; obj.wingPhase+=.12; obj.waveT+=.04;
    obj.x+=obj.driftX*Math.sin(obj.phase*.7)*.45;
    obj.y+=obj.driftY*Math.cos(obj.phase*.5)*.45;
    if(obj.x<70)   obj.driftX= Math.abs(obj.driftX);
    if(obj.x>W-70) obj.driftX=-Math.abs(obj.driftX);
    if(obj.y<70)   obj.driftY= Math.abs(obj.driftY);
    if(obj.y>H-70) obj.driftY=-Math.abs(obj.driftY);

    const fadeIn=clamp(obj.age/60,0,1);
    const isHov=(obj===hoveredObj);
    const baseAlpha=obj.msgRef.opened?.35:.88;
    bgCtx.globalAlpha=fadeIn*(isHov?Math.min(baseAlpha*1.25,1):baseAlpha);
    bgCtx.save();
    bgCtx.translate(obj.x,obj.y);
    const hoverPulse=isHov?1+Math.sin(Date.now()*.006)*.05:1;
    bgCtx.scale(obj.scale*hoverPulse, obj.scale*hoverPulse);

    switch(obj.style){
      case 'bottle':  drawBgBottle(obj);  break;
      case 'letter':  drawBgLetter(obj);  break;
      case 'dove':    drawBgDove(obj);    break;
      case 'star':    drawBgStar(obj);    break;
      case 'lantern': drawBgLantern(obj); break;
      case 'scroll':  drawBgScroll(obj);  break;
      case 'space':   drawBgSpace(obj);   break;
    }
    bgCtx.restore();

    // Label pill
    bgCtx.globalAlpha=fadeIn*(obj.msgRef.opened?.22:.75);
    const lbl=obj.label+(obj.msgRef.song?' ♫':'');
    bgCtx.font='600 11px Sora,sans-serif';
    bgCtx.textAlign='center';
    const lw=bgCtx.measureText(lbl).width;
    bgCtx.fillStyle=isHov?'rgba(20,12,50,.78)':'rgba(8,5,22,.65)';
    rrect(bgCtx,obj.x-lw/2-9,obj.y-44*obj.scale-14,lw+18,21,11); bgCtx.fill();
    if(isHov){ bgCtx.strokeStyle='rgba(139,124,248,.55)'; bgCtx.lineWidth=1; rrect(bgCtx,obj.x-lw/2-9,obj.y-44*obj.scale-14,lw+18,21,11); bgCtx.stroke(); }
    bgCtx.fillStyle=isHov?'#d8d0ff':'rgba(184,169,255,.92)';
    bgCtx.fillText(lbl,obj.x,obj.y-44*obj.scale+2);
  });

  bgCtx.globalAlpha=1; bgCtx.textAlign='left';
  bgT++;
  bgRaf=requestAnimationFrame(drawBg);
}
drawBg();

function drawNebula(W,H){
  [{x:.15,y:.2,r:.28,c:'rgba(88,28,235,.04)'},{x:.8,y:.7,r:.3,c:'rgba(192,38,211,.04)'},{x:.5,y:.5,r:.22,c:'rgba(14,165,233,.03)'}]
  .forEach(b=>{
    const g=bgCtx.createRadialGradient(W*b.x,H*b.y,0,W*b.x,H*b.y,W*b.r);
    g.addColorStop(0,b.c); g.addColorStop(1,'transparent');
    bgCtx.fillStyle=g; bgCtx.beginPath(); bgCtx.arc(W*b.x,H*b.y,W*b.r,0,Math.PI*2); bgCtx.fill();
  });
}

/* ─── BG sprite drawers ─── */
function drawBgBottle(obj){
  const ctx=bgCtx, bob=Math.sin(obj.phase)*5, tilt=Math.sin(obj.phase*.7)*.18;
  ctx.save(); ctx.rotate(tilt);
  const halo=ctx.createRadialGradient(0,bob,0,0,bob,36);
  halo.addColorStop(0,'rgba(14,165,233,.2)'); halo.addColorStop(1,'transparent');
  ctx.fillStyle=halo; ctx.beginPath(); ctx.arc(0,bob,36,0,Math.PI*2); ctx.fill();
  ctx.fillStyle='rgba(125,211,252,.55)'; ctx.strokeStyle='rgba(186,230,253,.7)'; ctx.lineWidth=1.2;
  rrect(ctx,-10,bob-22,20,34,5); ctx.fill(); ctx.stroke();
  ctx.fillStyle='rgba(103,196,245,.6)'; rrect(ctx,-5.5,bob-32,11,13,3); ctx.fill(); ctx.stroke();
  ctx.fillStyle='#c8a96e'; rrect(ctx,-5,bob-37,10,7,3); ctx.fill();
  ctx.fillStyle='rgba(255,252,220,.7)'; rrect(ctx,-5.5,bob-14,11,12,2); ctx.fill();
  ctx.strokeStyle='rgba(255,255,255,.35)'; ctx.lineWidth=1.5;
  ctx.beginPath(); ctx.moveTo(-4,bob-18); ctx.lineTo(-4,bob-6); ctx.stroke();
  ctx.restore();
  ctx.strokeStyle='rgba(125,211,252,.18)'; ctx.lineWidth=1;
  for(let w=0;w<2;w++){
    ctx.beginPath();
    for(let px=-24;px<=24;px+=3){ const py=10+w*6+Math.sin((px/8)+obj.waveT+w)*3; px===-24?ctx.moveTo(px,py):ctx.lineTo(px,py); }
    ctx.stroke();
  }
}
function drawBgLetter(obj){
  const ctx=bgCtx, bob=Math.sin(obj.phase)*4, tilt=Math.sin(obj.phase*.6)*.1, ew=44, eh=30;
  ctx.save(); ctx.rotate(tilt); ctx.translate(0,bob);
  const g=ctx.createRadialGradient(0,0,0,0,0,40); g.addColorStop(0,'rgba(99,102,241,.18)'); g.addColorStop(1,'transparent');
  ctx.fillStyle=g; ctx.beginPath(); ctx.arc(0,0,40,0,Math.PI*2); ctx.fill();
  ctx.fillStyle='rgba(224,231,255,.7)'; ctx.strokeStyle='rgba(165,180,252,.6)'; ctx.lineWidth=1.2;
  rrect(ctx,-ew/2,-eh/2,ew,eh,4); ctx.fill(); ctx.stroke();
  const fa=(Math.sin(obj.phase*.8)+1)/2;
  ctx.save(); ctx.translate(0,-eh/2); ctx.rotate(-fa*.7); ctx.translate(0,eh/2);
  ctx.beginPath(); ctx.moveTo(-ew/2,-eh/2); ctx.lineTo(0,-eh/2+eh*.42); ctx.lineTo(ew/2,-eh/2);
  ctx.closePath(); ctx.fillStyle=`rgba(196,181,253,${.5+fa*.3})`; ctx.strokeStyle='rgba(165,180,252,.5)'; ctx.fill(); ctx.stroke();
  ctx.restore();
  for(let l=0;l<3;l++){ ctx.beginPath(); ctx.moveTo(-ew/2+6,-eh/2+8+l*7); ctx.lineTo(ew/2-6,-eh/2+8+l*7); ctx.strokeStyle='rgba(165,180,252,.3)'; ctx.lineWidth=.8; ctx.stroke(); }
  ctx.restore();
}
function drawBgDove(obj){
  const ctx=bgCtx, bob=Math.sin(obj.phase)*5, wf=Math.sin(obj.wingPhase)*8;
  ctx.save(); ctx.translate(0,bob);
  const g=ctx.createRadialGradient(0,0,0,0,0,38); g.addColorStop(0,'rgba(134,239,172,.15)'); g.addColorStop(1,'transparent');
  ctx.fillStyle=g; ctx.beginPath(); ctx.arc(0,0,38,0,Math.PI*2); ctx.fill();
  ctx.fillStyle='rgba(240,253,244,.7)'; ctx.strokeStyle='rgba(187,247,208,.5)'; ctx.lineWidth=1;
  ctx.beginPath(); ctx.ellipse(-14,-2+wf,16,7,-.3,0,Math.PI*2); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.ellipse(14,-2+wf,16,7,.3,0,Math.PI*2);   ctx.fill(); ctx.stroke();
  ctx.fillStyle='rgba(240,253,244,.85)'; ctx.beginPath(); ctx.ellipse(0,0,18,10,0,0,Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.arc(18,-4,7,0,Math.PI*2); ctx.fill();
  ctx.fillStyle='#1e293b'; ctx.beginPath(); ctx.arc(21,-5,1.5,0,Math.PI*2); ctx.fill();
  ctx.fillStyle='#f59e0b'; ctx.beginPath(); ctx.moveTo(25,-4); ctx.lineTo(30,-3); ctx.lineTo(25,-2); ctx.fill();
  ctx.restore();
}
function drawBgStar(obj){
  const ctx=bgCtx, pulse=1+Math.sin(obj.phase)*.12, glow=.5+Math.sin(obj.phase*1.3)*.25;
  const g=ctx.createRadialGradient(0,0,0,0,0,45);
  g.addColorStop(0,`rgba(196,132,252,${glow*.5})`); g.addColorStop(.5,`rgba(139,92,246,${glow*.25})`); g.addColorStop(1,'transparent');
  ctx.fillStyle=g; ctx.beginPath(); ctx.arc(0,0,45,0,Math.PI*2); ctx.fill();
  ctx.save(); ctx.scale(pulse,pulse); ctx.rotate(obj.phase*.3);
  ctx.fillStyle=`rgba(253,224,71,${.85+glow*.1})`; ctx.shadowColor='rgba(250,204,21,.8)'; ctx.shadowBlur=14;
  ctx.beginPath();
  for(let i=0;i<8;i++){ const a=(i/8)*Math.PI*2-Math.PI/2,r=i%2===0?18:8; i===0?ctx.moveTo(Math.cos(a)*r,Math.sin(a)*r):ctx.lineTo(Math.cos(a)*r,Math.sin(a)*r); }
  ctx.closePath(); ctx.fill(); ctx.shadowBlur=0; ctx.restore();
  obj.sparkles.forEach(s=>{ s.angle+=s.speed; ctx.beginPath(); ctx.arc(Math.cos(s.angle)*s.dist,Math.sin(s.angle)*s.dist,s.size,0,Math.PI*2); ctx.fillStyle=`rgba(253,224,71,${s.alpha*Math.abs(Math.sin(obj.phase+s.angle))})`; ctx.fill(); });
}
function drawBgLantern(obj){
  const ctx=bgCtx, bob=Math.sin(obj.phase)*6, sway=Math.sin(obj.phase*.7)*.12, glow=.5+Math.sin(obj.phase*1.4)*.3;
  ctx.save(); ctx.rotate(sway); ctx.translate(0,bob);
  const halo=ctx.createRadialGradient(0,0,0,0,0,55); halo.addColorStop(0,`rgba(251,146,60,${glow*.35})`); halo.addColorStop(1,'transparent');
  ctx.fillStyle=halo; ctx.beginPath(); ctx.arc(0,0,55,0,Math.PI*2); ctx.fill();
  ctx.strokeStyle='rgba(251,191,36,.5)'; ctx.lineWidth=1.2; ctx.beginPath(); ctx.moveTo(0,-30); ctx.lineTo(0,-44); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-14,-28); ctx.bezierCurveTo(-22,-10,-22,10,-14,28); ctx.lineTo(14,28); ctx.bezierCurveTo(22,10,22,-10,14,-28); ctx.closePath();
  ctx.fillStyle='rgba(220,38,38,.8)'; ctx.strokeStyle='rgba(153,27,27,.6)'; ctx.lineWidth=1.2; ctx.fill(); ctx.stroke();
  const core=ctx.createRadialGradient(0,0,0,0,0,16); core.addColorStop(0,`rgba(251,191,36,${glow*.9})`); core.addColorStop(1,'rgba(239,68,68,.1)');
  ctx.beginPath(); ctx.ellipse(0,0,14,20,0,0,Math.PI*2); ctx.fillStyle=core; ctx.fill();
  ctx.fillStyle='rgba(251,191,36,.8)'; ctx.beginPath(); ctx.ellipse(0,-28,9,3.5,0,0,Math.PI*2); ctx.fill(); ctx.beginPath(); ctx.ellipse(0,28,9,3.5,0,0,Math.PI*2); ctx.fill();
  ctx.strokeStyle='rgba(153,27,27,.4)'; ctx.lineWidth=.7; ctx.beginPath(); ctx.moveTo(-14,0); ctx.lineTo(14,0); ctx.stroke();
  ctx.restore();
  obj.particles.forEach(p=>{ p.life+=.012; if(p.life>1){ p.life=0; p.x=rand(-8,8); } const py=(bob-28)+p.vy*p.life*80; ctx.beginPath(); ctx.arc(p.x,py,p.size*(1-p.life*.5),0,Math.PI*2); ctx.fillStyle=`rgba(251,191,36,${(1-p.life)*.7})`; ctx.fill(); });
}
function drawBgScroll(obj){
  const ctx=bgCtx, bob=Math.sin(obj.phase)*4, tilt=Math.sin(obj.phase*.8)*.1, openAmt=(Math.sin(obj.phase*.5)+1)/2;
  const sw=50, sh=lerp(10,38,openAmt);
  const g=ctx.createRadialGradient(0,bob,0,0,bob,42); g.addColorStop(0,'rgba(202,138,4,.16)'); g.addColorStop(1,'transparent');
  ctx.fillStyle=g; ctx.beginPath(); ctx.arc(0,bob,42,0,Math.PI*2); ctx.fill();
  ctx.save(); ctx.rotate(tilt); ctx.translate(-sw/2,bob-sh/2);
  ctx.fillStyle='rgba(254,249,195,.7)'; ctx.strokeStyle='rgba(202,138,4,.5)'; ctx.lineWidth=1;
  rrect(ctx,0,0,sw,sh,3); ctx.fill(); ctx.stroke();
  for(let l=0;l<3;l++){ const ly=8+l*10; if(ly>=sh-5) break; ctx.beginPath(); ctx.moveTo(5,ly); ctx.lineTo(sw-5,ly); ctx.strokeStyle='rgba(161,116,10,.2)'; ctx.stroke(); }
  ctx.fillStyle='rgba(146,64,14,.8)'; rrect(ctx,-4,-6,sw+8,12,5); ctx.fill(); rrect(ctx,-4,sh-6,sw+8,12,5); ctx.fill();
  ctx.restore();
}
function drawBgSpace(obj){
  const ctx=bgCtx, bob=Math.sin(obj.phase)*5, tilt=Math.sin(obj.phase*.6)*.08, flameAmt=.5+Math.sin(obj.phase*2)*.3;
  ctx.save(); ctx.rotate(tilt); ctx.translate(0,bob);
  const fl=ctx.createRadialGradient(0,22,0,0,22,20*flameAmt); fl.addColorStop(0,'rgba(255,200,50,.9)'); fl.addColorStop(.5,'rgba(255,100,20,.6)'); fl.addColorStop(1,'transparent');
  ctx.beginPath(); ctx.ellipse(0,22,8,18*flameAmt,0,0,Math.PI*2); ctx.fillStyle=fl; ctx.fill();
  const g=ctx.createRadialGradient(0,0,0,0,0,40); g.addColorStop(0,'rgba(56,189,248,.12)'); g.addColorStop(1,'transparent');
  ctx.fillStyle=g; ctx.beginPath(); ctx.arc(0,0,40,0,Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.moveTo(0,-28); ctx.lineTo(11,14); ctx.lineTo(7,20); ctx.lineTo(-7,20); ctx.lineTo(-11,14); ctx.closePath();
  ctx.fillStyle='rgba(226,232,240,.8)'; ctx.strokeStyle='rgba(148,163,184,.5)'; ctx.lineWidth=1; ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0,-28); ctx.lineTo(9,-8); ctx.lineTo(-9,-8); ctx.closePath(); ctx.fillStyle='rgba(239,68,68,.8)'; ctx.fill();
  ctx.beginPath(); ctx.arc(0,2,6,0,Math.PI*2); ctx.fillStyle='rgba(186,230,254,.8)'; ctx.strokeStyle='rgba(125,211,252,.6)'; ctx.fill(); ctx.stroke();
  ctx.fillStyle='rgba(203,213,225,.7)';
  ctx.beginPath(); ctx.moveTo(11,8); ctx.lineTo(24,20); ctx.lineTo(11,20); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.moveTo(-11,8); ctx.lineTo(-24,20); ctx.lineTo(-11,20); ctx.closePath(); ctx.fill();
  ctx.restore();
  obj.particles.forEach(p=>{ p.life+=.02; if(p.life>1){ p.life=0; p.x=rand(-4,4); p.y=bob+22; } const py=bob+22+p.life*40; ctx.beginPath(); ctx.arc(p.x,py,p.size*(1-p.life),0,Math.PI*2); ctx.fillStyle=`rgba(251,146,60,${(1-p.life)*.5})`; ctx.fill(); });
}

/* ═══════════════════════════════════════════════
   DATABASE — initial load + realtime sync
   Loads every message on start, then keeps every
   open tab (this device or any other) in sync live.
═══════════════════════════════════════════════ */
async function loadMessages(){
  if(!supabaseClient) return;

  const { data, error } = await supabaseClient
    .from('messages')
    .select('*')
    .order('created_at', { ascending:false });

  if(error){ console.error(error); return; }

  inbox = data.map(rowToItem);
  inbox.forEach(item=>spawnBgObj(item));
  updateBadge();
  if(currentTab==='messages') renderMessages();
}

function subscribeToMessages(){
  if(!supabaseClient) return;

  supabaseClient
    .channel('public:messages')
    .on('postgres_changes', { event:'INSERT', schema:'public', table:'messages' }, payload=>{
      const row = payload.new;
      if(inbox.some(m=>m.id===row.id)) return; // already added locally by our own sendMsg()
      const item = rowToItem(row);
      inbox.unshift(item);
      spawnBgObj(item);
      updateBadge();
      if(currentTab==='messages') renderMessages(document.getElementById('msgSearch').value.trim().toLowerCase());
    })
    .on('postgres_changes', { event:'UPDATE', schema:'public', table:'messages' }, payload=>{
      const row  = payload.new;
      const item = inbox.find(m=>m.id===row.id);
      if(item){
        item.opened = row.opened;
        updateBadge();
        if(currentTab==='messages') renderMessages(document.getElementById('msgSearch').value.trim().toLowerCase());
      }
    })
    .subscribe();
}

loadMessages();
subscribeToMessages();