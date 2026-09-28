/* ============ THEME (light / dark) ============ */
/* UPDATED: theme is saved to localStorage so it persists across visits and
   is shared between the start page and the app — see start.html for its copy
   of this same logic. */
function getStoredTheme(){ try{ return localStorage.getItem('campusync-theme') || 'light'; }catch(e){ return 'light'; } }
function applyTheme(theme){
  document.documentElement.setAttribute('data-theme', theme);
  try{ localStorage.setItem('campusync-theme', theme); }catch(e){}
  document.querySelectorAll('.theme-toggle').forEach(b=>{
    b.textContent = theme==='dark' ? '☀️' : '🌙';
    b.setAttribute('aria-label', theme==='dark' ? 'Switch to light mode' : 'Switch to dark mode');
  });
}
function toggleTheme(){ applyTheme(document.documentElement.getAttribute('data-theme')==='dark' ? 'light' : 'dark'); }
applyTheme(getStoredTheme());

/* ============ STATE ============ */
let state = {
  ready:false,
  session:null,
  authRole:'student',
  authStage:'college',      // UPDATED: 'college' (mandatory pick) -> 'login' (role form)
  selectedCollege:null,     // UPDATED: {id, name, has_logo} chosen on the college-select stage
  collegeSearch:'',
  publicColleges:[],        // UPDATED: list for the college-select stage
  collegesLoading:false,
  authError:'',
  authBusy:false,
  tab:'',
  tabError:'',

  colleges:[], reports:null,                    // super_admin
  hods:[], networkAdmins:[], networkIncoming:[], collegeSections:[], // college_admin
  faculty:[], students:[], sections:[],          // hod
  myStudents:[], mySections:[],                  // faculty
  myAttendance:null, myMarks:[],                 // student

  announcements:[], notes:[], events:[], posts:[],

  clubs:[], activeClub:null, activeClubMembers:[], activeClubPosts:[], activeClubGallery:[], // NEW: clubs
  forumPosts:[], forumSubject:'', forumSearch:'',                                            // NEW: discussion forum
  leaderboard:null, leaderboardScope:'college', leaderboardValue:'',                          // NEW: leaderboard
  analytics:null, analyticsCharts:[],                                                         // NEW: dashboard analytics
  facultyTests:[], studentTests:[],                                                            // NEW: online tests
  notifications:[], unreadByTab:{},                                                              // NEW: notifications + per-module red dots
};
const SUBJECT_COLORS = ['#2f9e5b','#c0304f','#f5a623','#1f6b3a','#5c7267'];

/* ============ API HELPERS ============ */
async function api(path, options={}){
  const res = await fetch('/api'+path, {
    method: options.method || 'GET',
    headers: {'Content-Type':'application/json'},
    credentials:'same-origin',
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  let data = {};
  try{ data = await res.json(); }catch(e){}
  if(!res.ok){
    const err = new Error(data.error || 'Something went wrong.');
    err.status = res.status;
    throw err;
  }
  return data;
}
async function apiUpload(path, formData, method){
  const res = await fetch('/api'+path, { method: method||'POST', credentials:'same-origin', body: formData });
  let data = {};
  try{ data = await res.json(); }catch(e){}
  if(!res.ok){
    const err = new Error(data.error || 'Upload failed.');
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ============ UTIL ============ */
function esc(str){ const d=document.createElement('div'); d.textContent = str==null?'':String(str); return d.innerHTML; }
function initials(name){ return (name||'?').trim().split(/\s+/).map(p=>p[0]).slice(0,2).join('').toUpperCase(); }
function timeAgo(ts){
  const diff = Date.now()-ts, mins = Math.floor(diff/60000);
  if(mins<1) return 'just now';
  if(mins<60) return mins+'m ago';
  const hrs = Math.floor(mins/60); if(hrs<24) return hrs+'h ago';
  return Math.floor(hrs/24)+'d ago';
}
function fmtDateBadge(dateStr){
  const d = new Date(dateStr+'T00:00:00');
  if(isNaN(d)) return {day:'--', mon:'---'};
  const months=['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  return {day:d.getDate(), mon:months[d.getMonth()]};
}
function isPastDate(dateStr){
  const d = new Date(dateStr+'T00:00:00');
  if(isNaN(d)) return false;
  const today = new Date(); today.setHours(0,0,0,0);
  return d < today;
}
function subjectColor(str){ let h=0; for(let i=0;i<str.length;i++) h=str.charCodeAt(i)+((h<<5)-h); return SUBJECT_COLORS[Math.abs(h)%SUBJECT_COLORS.length]; }
function roleLabel(role){
  return {super_admin:'Super Admin', college_admin:'College Admin', hod:'HOD', faculty:'Faculty', student:'Student'}[role] || role;
}
function scopeLabel(level){ return {college:'College-wide', department:'Department', section:'Section'}[level] || ''; }
function targetLabel(row){
  if(!row.target_department) return 'College-wide';
  if(row.target_section_id){
    const sec = findAnySectionById(row.target_section_id);
    return sec ? `${esc(sec.department)} · ${esc(sec.name)}` : 'Section';
  }
  if(row.target_year) return `${esc(row.target_department)} · ${esc(row.target_year)}`;
  return `${esc(row.target_department)} (Dept-wide)`;
}
function findAnySectionById(id){
  return (state.sections||[]).find(s=>s.id===id) || (state.mySections||[]).find(s=>s.id===id) || (state.collegeSections||[]).find(s=>s.id===id) || null;
}
// UPDATED: lets the poster (College Admin / HOD / Faculty) explicitly pick
// who a post is for — department, year, and section — instead of it being
// automatically derived from their role.
function audiencePickerHtml(){
  const role = state.session.role;
  if(role==='faculty'){
    if((state.mySections||[]).length<=1) return '';
    return `<div class="field"><label>Section</label><select name="target_section_id">${state.mySections.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div>`;
  }
  if(role==='hod'){
    const years = [...new Set((state.sections||[]).map(s=>s.year).filter(Boolean))];
    return `
      <div class="field"><label>Year</label><select name="target_year" id="audienceYear"><option value="">All years</option>${years.map(y=>`<option value="${esc(y)}">${esc(y)}</option>`).join('')}</select></div>
      <div class="field"><label>Section</label><select name="target_section_id" id="audienceSection"><option value="">All sections</option>${(state.sections||[]).map(s=>`<option value="${s.id}" data-year="${esc(s.year||'')}">${esc(s.name)}</option>`).join('')}</select></div>
    `;
  }
  if(role==='college_admin'){
    const depts = [...new Set((state.collegeSections||[]).map(s=>s.department))];
    return `
      <div class="field"><label>Department</label><select name="target_department" id="audienceDept"><option value="">All departments</option>${depts.map(d=>`<option value="${esc(d)}">${esc(d)}</option>`).join('')}</select></div>
      <div class="field"><label>Year</label><select name="target_year" id="audienceYear"><option value="">All years</option></select></div>
      <div class="field"><label>Section</label><select name="target_section_id" id="audienceSection"><option value="">All sections</option></select></div>
    `;
  }
  return '';
}
function wireAudiencePicker(formId){
  const form = document.getElementById(formId);
  if(!form) return;
  const role = state.session.role;
  if(role==='college_admin'){
    const deptSel = form.querySelector('#audienceDept');
    const yearSel = form.querySelector('#audienceYear');
    const sectionSel = form.querySelector('#audienceSection');
    if(!deptSel) return;
    function refreshYears(){
      const dept = deptSel.value;
      const matching = (state.collegeSections||[]).filter(s=>!dept || s.department===dept);
      const years = [...new Set(matching.map(s=>s.year).filter(Boolean))];
      yearSel.innerHTML = `<option value="">All years</option>${years.map(y=>`<option value="${esc(y)}">${esc(y)}</option>`).join('')}`;
      refreshSections();
    }
    function refreshSections(){
      const dept = deptSel.value, year = yearSel.value;
      const matching = (state.collegeSections||[]).filter(s=>(!dept||s.department===dept) && (!year||s.year===year));
      sectionSel.innerHTML = `<option value="">All sections</option>${matching.map(s=>`<option value="${s.id}">${esc(s.department)} · ${esc(s.name)}</option>`).join('')}`;
    }
    deptSel.addEventListener('change', refreshYears);
    yearSel.addEventListener('change', refreshSections);
    refreshYears();
  }
  if(role==='hod'){
    const yearSel = form.querySelector('#audienceYear');
    const sectionSel = form.querySelector('#audienceSection');
    if(!yearSel) return;
    function refreshSections(){
      const year = yearSel.value;
      const opts = (state.sections||[]).filter(s=>!year||s.year===year);
      sectionSel.innerHTML = `<option value="">All sections</option>${opts.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('')}`;
    }
    yearSel.addEventListener('change', refreshSections);
  }
}
function emptyState(title, sub){ return `<div class="empty-state"><div class="display">${esc(title)}</div><p>${esc(sub)}</p></div>`; }
function canManageRow(row){
  if(!state.session) return false;
  if(row.author_username===state.session.username) return true;
  if(state.session.role==='college_admin' && row.college_id===state.session.college_id) return true;
  if(state.session.role==='hod' && row.college_id===state.session.college_id && row.department===state.session.department) return true;
  return false;
}
function canPost(){ return ['college_admin','hod','faculty'].includes(state.session.role); }

/* ============ BOOT ============ */
async function boot(){
  try{
    const data = await api('/me');
    state.session = data.user;
    state.tab = defaultTab();
    await loadAllData();
  }catch(e){
    state.session = null;
    // UPDATED: the start page's "Super Admin" button links here with #admin,
    // which skips straight to the Super Admin login (no college to pick).
    if(location.hash === '#admin'){
      state.authRole = 'super_admin';
      state.authStage = 'login';
    }
    await loadPublicColleges();
  }
  state.ready = true;
  document.getElementById('bootLoading').style.display='none';
  render();
}
// UPDATED: colleges for the mandatory college-select stage.
async function loadPublicColleges(){
  state.collegesLoading = true;
  try{
    const c = await api('/public/colleges');
    state.publicColleges = c.colleges;
  }catch(e){
    state.publicColleges = [];
  }
  state.collegesLoading = false;
}
function defaultTab(){
  const r = state.session.role;
  if(r==='super_admin') return 'colleges';
  if(r==='college_admin') return 'hods';
  if(r==='hod') return 'sections';
  if(r==='faculty') return 'mystudents';
  return 'announcements';
}
async function loadAllData(){
  const role = state.session.role;
  await refreshNotifications();
  startNotificationPolling();
  if(role==='super_admin'){
    await refreshColleges();
    const r = await api('/super/reports'); state.reports = r;
    const an = await api('/super/analytics'); state.analytics = an;
    return;
  }
  const [ann, ev, notes, posts, clubs, forum, lb] = await Promise.all([
    api('/announcements'), api('/events'), api('/notes'), api('/posts'),
    api('/clubs'), api('/forum'), api('/leaderboard')
  ]);
  state.announcements = ann.announcements;
  state.events = ev.events;
  state.notes = notes.notes;
  state.posts = posts.posts;
  state.clubs = clubs.clubs;
  state.forumPosts = forum.posts;
  state.leaderboard = lb;

  if(role==='college_admin'){
    const [h, an, sec] = await Promise.all([api('/college/hods'), api('/college/analytics'), api('/college/sections')]);
    state.hods = h.hods; state.analytics = an; state.collegeSections = sec.sections;
  }
  if(role==='hod'){
    const [f, s, sec, an] = await Promise.all([api('/hod/faculty'), api('/hod/students'), api('/hod/sections'), api('/hod/analytics')]);
    state.faculty = f.faculty; state.students = s.students; state.sections = sec.sections; state.analytics = an;
  }
  if(role==='faculty'){
    const [s, sec, t] = await Promise.all([api('/faculty/students'), api('/faculty/sections'), api('/faculty/tests')]);
    state.myStudents = s.students; state.mySections = sec.sections; state.facultyTests = t.tests;
  }
  if(role==='student'){
    const [att, marks, t] = await Promise.all([api('/student/attendance'), api('/student/marks'), api('/student/tests')]);
    state.myAttendance = att; state.myMarks = marks.marks; state.studentTests = t.tests;
  }
}
async function refreshLeaderboard(){
  const qs = state.leaderboardScope==='college' ? '' :
    state.leaderboardScope==='department' ? `?scope=department&department=${encodeURIComponent(state.leaderboardValue||state.session.department||'')}` :
    `?scope=section&section_id=${encodeURIComponent(state.leaderboardValue||state.session.section_id||'')}`;
  state.leaderboard = await api('/leaderboard'+qs);
}
async function refreshClubs(){ const c = await api('/clubs'); state.clubs = c.clubs; }
async function refreshForum(){
  const params = new URLSearchParams();
  if(state.forumSubject) params.set('subject', state.forumSubject);
  if(state.forumSearch) params.set('q', state.forumSearch);
  const f = await api('/forum'+(params.toString()?'?'+params.toString():''));
  state.forumPosts = f.posts;
}
async function refreshColleges(){
  const c = await api('/super/colleges');
  state.colleges = c.colleges;
}

/* ============ NOTIFICATIONS: bell + per-module red dots ============
   Every meaningful action elsewhere in the app (a note upload, a new
   announcement, a reply, a grade…) writes a notification server-side.
   We poll for them, badge the bell, and light up a small red dot next
   to whichever sidebar module the notification belongs to. Opening
   that module marks its notifications read and the dot fades out. */
async function refreshNotifications(){
  try{
    const data = await api('/notifications');
    state.notifications = data.notifications || [];
    computeUnreadByTab();
  }catch(e){ /* notifications are a nice-to-have — never block the app on this */ }
}
function computeUnreadByTab(){
  const map = {};
  (state.notifications||[]).forEach(n=>{ if(!n.read) map[n.tab] = (map[n.tab]||0)+1; });
  state.unreadByTab = map;
}
function startNotificationPolling(){
  if(state._notifPollTimer) return;
  state._notifPollTimer = setInterval(async ()=>{
    if(!state.session) return;
    await refreshNotifications();
    updateNotifDots();
    updateBellBadge();
    // if the module that just got a new notification is the one already open,
    // clear it right away instead of leaving a dot the user won't click into
    if((state.unreadByTab||{})[state.tab]) markTabNotificationsRead(state.tab);
  }, 20000);
}
function updateNotifDots(){
  document.querySelectorAll('.nav-dot[data-dot-tab]').forEach(dot=>{
    const has = !!(state.unreadByTab||{})[dot.dataset.dotTab];
    dot.classList.remove('fade-out');
    dot.classList.toggle('show', has);
  });
}
function updateBellBadge(){
  const count = (state.notifications||[]).filter(n=>!n.read).length;
  const el = document.getElementById('notifBadge');
  if(!el) return;
  el.textContent = count>99 ? '99+' : String(count);
  el.style.display = count>0 ? 'inline-flex' : 'none';
}
// Called the moment a sidebar module is opened: marks that module's
// notifications read on the server, then fades its red dot out after a
// beat so the person actually sees it before it goes.
function markTabNotificationsRead(tab){
  if(!state.unreadByTab || !state.unreadByTab[tab]) return;
  document.querySelectorAll('.nav-dot[data-dot-tab="'+tab+'"]').forEach(dot=>{
    setTimeout(()=>{ dot.classList.add('fade-out'); }, 550);
  });
  api('/notifications/read-tab/'+tab, {method:'POST'}).then(()=>{
    (state.notifications||[]).forEach(n=>{ if(n.tab===tab) n.read=true; });
    state.unreadByTab[tab] = 0;
    updateBellBadge();
  }).catch(()=>{});
}
function openNotificationsPanel(){
  const items = (state.notifications||[]).slice(0, 50);
  const labelMap = {};
  navItemsFor(state.session.role).forEach(i=>{ labelMap[i.key]=i.label; });
  showModal(`
    <h2>Notifications</h2>
    ${items.length ? `<div style="display:flex;justify-content:flex-end;margin-bottom:10px;"><button type="button" class="btn btn-outline btn-small" id="notifMarkAllRead">Mark all as read</button></div>` : ''}
    <div class="notif-list">
      ${items.length ? items.map(n=>`
        <button type="button" class="notif-row ${n.read?'':'unread'}" data-notif-id="${n.id}" data-notif-tab="${esc(n.tab)}">
          <div class="notif-row-title">${esc(n.title)}</div>
          ${n.message ? `<div class="notif-row-msg">${esc(n.message)}</div>` : ''}
          <div class="notif-row-time">${timeAgo(n.created_at)} · ${esc(labelMap[n.tab]||n.tab)}</div>
        </button>
      `).join('') : emptyState('No notifications yet', 'You will see updates here as things happen around your campus.')}
    </div>
    <div class="modal-actions"><button type="button" class="btn btn-outline" id="cancelModal">Close</button></div>
  `);
  document.querySelectorAll('.notif-row').forEach(row=>row.addEventListener('click', async ()=>{
    const id = row.dataset.notifId, tab = row.dataset.notifTab;
    api('/notifications/'+id+'/read', {method:'POST'}).catch(()=>{});
    const n = (state.notifications||[]).find(x=>x.id===id);
    if(n) n.read = true;
    computeUnreadByTab();
    updateBellBadge();
    closeModal();
    if(navItemsFor(state.session.role).some(i=>i.key===tab)){
      state.tab = tab; state.tabError=''; render();
      markTabNotificationsRead(tab);
    }
  }));
  const markAll = document.getElementById('notifMarkAllRead');
  if(markAll) markAll.addEventListener('click', async ()=>{
    try{ await api('/notifications/read-all', {method:'POST'}); }catch(e){}
    (state.notifications||[]).forEach(n=>n.read=true);
    computeUnreadByTab();
    updateNotifDots(); updateBellBadge();
    closeModal();
  });
}
const notifBellBtn = document.getElementById('notifBellBtn');
if(notifBellBtn) notifBellBtn.addEventListener('click', ()=>{ closeSidebar(); openNotificationsPanel(); });


/* ============ AUTH SCREEN ============ */
/* UPDATED: Super Admin no longer shares a tab with the other roles — it's
   reached from the "Super Admin" button on the start page (or the link at
   the bottom of the college-select screen) and skips the college picker,
   since the platform owner isn't tied to any one college. */
const TENANT_ROLE_TABS = [
  {key:'student', label:'Student'},
  {key:'faculty', label:'Faculty'},
  {key:'hod', label:'HOD'},
  {key:'college_admin', label:'College Admin'},
];
function collegeLogoTag(c, cls){
  return c.has_logo
    ? `<img class="${cls}" src="/api/super/colleges/${c.id}/logo" alt="${esc(c.name)} logo">`
    : `<div class="${cls} college-pick-fallback">${esc((c.name||'?')[0])}</div>`;
}
function renderAuth(){
  document.getElementById('authScreen').style.display='flex';
  document.getElementById('appScreen').style.display='none';
  const inner = document.getElementById('authPanelInner');
  if(state.authRole!=='super_admin' && state.authStage==='login' && !state.selectedCollege){
    state.authStage = 'college'; // safety net — never show the login form without a college chosen
  }
  if(state.authStage==='college'){
    inner.innerHTML = renderCollegeSelectStage();
    attachCollegeSelectHandlers();
  } else {
    inner.innerHTML = renderLoginStage();
    attachLoginStageHandlers();
  }
}

/* ---- Stage 1: mandatory "select your college" ---- */
function renderCollegeSelectStage(){
  return `
    <div class="brand-row"><img src="/logo.png" alt="Campus Orbis logo"><div class="brand">Campus Orbis · Campus Access</div></div>
    <h1>Select your college</h1>
    <p class="auth-sub">Find your institution to continue to sign in.</p>
    <div class="field" style="margin-bottom:14px;">
      <label>Your college</label>
      <input type="text" id="collegeSearchInput" placeholder="Start typing your college name…" autocomplete="off" value="${esc(state.collegeSearch)}">
    </div>
    <div class="college-pick-list" id="collegePickList">
      ${state.collegesLoading ? `<div class="hint">Loading colleges…</div>` : renderCollegePickRows(state.publicColleges)}
    </div>
    <div class="switch-line">
      <button type="button" class="link-btn" id="superAdminLinkBtn">Platform Super Admin? Sign in here</button>
    </div>
  `;
}
function renderCollegePickRows(list){
  if(!list.length) return emptyState('No colleges yet', 'Ask your Super Admin to add your college to Campus Orbis first.');
  return list.map(c=>`
    <button type="button" class="college-pick-row" data-college-id="${c.id}" data-college-name="${esc(c.name.toLowerCase())}">
      ${collegeLogoTag(c, 'college-pick-logo')}
      <span>${esc(c.name)}</span>
      <span class="college-pick-arrow">→</span>
    </button>
  `).join('');
}
function attachCollegeSelectHandlers(){
  const input = document.getElementById('collegeSearchInput');
  if(input){
    input.focus();
    input.addEventListener('input', ()=>{
      state.collegeSearch = input.value;
      const q = input.value.trim().toLowerCase();
      let anyVisible = false;
      document.querySelectorAll('.college-pick-row').forEach(row=>{
        const match = row.dataset.collegeName.includes(q);
        row.style.display = match ? '' : 'none';
        if(match) anyVisible = true;
      });
      const list = document.getElementById('collegePickList');
      let noneMsg = list.querySelector('.no-match-hint');
      if(!anyVisible && state.publicColleges.length){
        if(!noneMsg){
          noneMsg = document.createElement('div');
          noneMsg.className='hint no-match-hint';
          noneMsg.textContent="No college matches that search.";
          list.appendChild(noneMsg);
        }
      } else if(noneMsg){ noneMsg.remove(); }
    });
  }
  document.querySelectorAll('.college-pick-row').forEach(row=>row.addEventListener('click', ()=>{
    const college = state.publicColleges.find(c=>c.id===row.dataset.collegeId);
    if(!college) return;
    state.selectedCollege = college;
    state.authStage = 'login'; state.authRole = 'student'; state.authError='';
    render();
  }));
  const sa = document.getElementById('superAdminLinkBtn');
  if(sa) sa.addEventListener('click', ()=>{
    state.authStage='login'; state.authRole='super_admin'; state.authError='';
    render();
  });
}

/* ---- Stage 2: role login form ---- */
function renderLoginStage(){
  const isSuper = state.authRole==='super_admin';
  let html = `<div class="brand-row"><img src="/logo.png" alt="Campus Orbis logo"><div class="brand">Campus Orbis · Campus Access</div></div>`;
  if(isSuper){
    html += `
      <button type="button" class="link-btn back-link" id="backToCollegeBtn">← Back to college sign-in</button>
      <h1>Super Admin</h1>
      <p class="auth-sub">Sign in to manage the Campus Orbis platform.</p>
    `;
  } else {
    html += `
      <button type="button" class="link-btn back-link" id="backToCollegeBtn">← Change college</button>
      <div class="selected-college-chip">
        ${collegeLogoTag(state.selectedCollege, 'selected-college-logo')}
        <span>${esc(state.selectedCollege.name)}</span>
      </div>
      <h1>Welcome back</h1>
      <p class="auth-sub">Sign in as ${roleLabel(state.authRole)} to reach Campus Orbis.</p>
      <div class="role-tabs" id="roleTabs">
        ${TENANT_ROLE_TABS.map(r=>`<button type="button" class="role-tab ${state.authRole===r.key?'active':''}" data-role="${r.key}">${r.label}</button>`).join('')}
      </div>
    `;
  }
  html += `<div class="id-card-body" id="authBody">`;
  if(state.authError) html += `<div class="error-msg">${esc(state.authError)}</div>`;
  html += `
    <form id="loginForm">
      <div class="field"><label>Username</label><input type="text" name="username" autocomplete="username" required></div>
      <div class="field"><label>Password</label><input type="password" name="password" autocomplete="current-password" required></div>
      <button type="submit" class="btn btn-primary" ${state.authBusy?'disabled':''}>${state.authBusy?'Signing in…':'Sign in'}</button>
    </form>
    ${isSuper ? `<div class="hint">No self sign-up. The Super Admin account is created from server-side configuration on first run — ask whoever manages your deployment for the login.</div>` : ''}
    <div class="hint">There's no self sign-up — every account is created by the role above it (Super Admin → College Admin → HOD → Faculty/Student). Ask whoever manages your account if you don't have a login yet.</div>
  `;
  html += `</div>`;
  return html;
}
function attachLoginStageHandlers(){
  const back = document.getElementById('backToCollegeBtn');
  if(back) back.addEventListener('click', ()=>{
    state.authStage='college'; state.authRole='student'; state.authError='';
    if(location.hash==='#admin') history.replaceState(null,'',location.pathname);
    render();
  });
  document.querySelectorAll('.role-tab').forEach(b=>b.addEventListener('click', ()=>{
    state.authRole = b.dataset.role; state.authError=''; render();
  }));
  document.getElementById('loginForm').addEventListener('submit', onLoginSubmit);
}
async function onLoginSubmit(e){
  e.preventDefault();
  const fd = new FormData(e.target);
  state.authBusy = true; state.authError=''; render();
  try{
    const body = { username: fd.get('username').trim(), password: fd.get('password'), role: state.authRole };
    if(state.authRole!=='super_admin') body.college_id = state.selectedCollege.id;
    const data = await api('/auth/login', {method:'POST', body});
    state.session = data.user;
    state.tab = defaultTab();
    await loadAllData();
  }catch(err){
    state.authError = err.message;
  }
  state.authBusy = false;
  render();
}
async function logout(){
  try{ await api('/auth/logout', {method:'POST'}); }catch(e){}
  state.session=null;
  // UPDATED: reset back to the mandatory college-select stage for the next sign-in.
  state.authStage='college'; state.authRole='student'; state.selectedCollege=null; state.authError='';
  if(location.hash==='#admin') history.replaceState(null,'',location.pathname);
  await loadPublicColleges();
  render();
}

/* ============ SHELL / NAV ============ */
function navItemsFor(role){
  if(role==='super_admin') return [
    {key:'colleges', label:'Colleges', icon:'🏫'},
    {key:'reports', label:'Reports', icon:'📊'},
  ];
  if(role==='college_admin') return [
    {key:'hods', label:'HODs', icon:'👤'},
    {key:'network', label:'Campus Network', icon:'🌐'},
    {key:'announcements', label:'Announcements', icon:'📌'},
    {key:'events', label:'Events', icon:'🗓️'},
    {key:'notes', label:'Notes', icon:'📄'},
    {key:'board', label:'Public Board', icon:'📢'},
    {key:'clubs', label:'Clubs', icon:'🎭'},
    {key:'forum', label:'Discussion Forum', icon:'💬'},
    {key:'leaderboard', label:'Leaderboard', icon:'🏆'},
    {key:'bookmarks', label:'Bookmarks', icon:'🔖'},
    {key:'analytics', label:'Analytics', icon:'📈'},
  ];
  if(role==='hod') return [
    {key:'sections', label:'Sections', icon:'🏷️'},
    {key:'faculty', label:'Faculty', icon:'👤'},
    {key:'students', label:'Students', icon:'🎓'},
    {key:'announcements', label:'Announcements', icon:'📌'},
    {key:'events', label:'Events', icon:'🗓️'},
    {key:'notes', label:'Notes', icon:'📄'},
    {key:'board', label:'Public Board', icon:'📢'},
    {key:'clubs', label:'Clubs', icon:'🎭'},
    {key:'forum', label:'Discussion Forum', icon:'💬'},
    {key:'leaderboard', label:'Leaderboard', icon:'🏆'},
    {key:'bookmarks', label:'Bookmarks', icon:'🔖'},
    {key:'analytics', label:'Analytics', icon:'📈'},
  ];
  if(role==='faculty') return [
    {key:'mystudents', label:'My Students', icon:'🎓'},
    {key:'attendance', label:'Attendance', icon:'✅'},
    {key:'marks', label:'Marks', icon:'📝'},
    {key:'tests', label:'Tests', icon:'🧪'},
    {key:'announcements', label:'Announcements', icon:'📌'},
    {key:'events', label:'Events', icon:'🗓️'},
    {key:'notes', label:'Notes', icon:'📄'},
    {key:'board', label:'Public Board', icon:'📢'},
    {key:'clubs', label:'Clubs', icon:'🎭'},
    {key:'forum', label:'Discussion Forum', icon:'💬'},
    {key:'leaderboard', label:'Leaderboard', icon:'🏆'},
    {key:'bookmarks', label:'Bookmarks', icon:'🔖'},
  ];
  return [ // student
    {key:'announcements', label:'Announcements', icon:'📌'},
    {key:'events', label:'Events', icon:'🗓️'},
    {key:'notes', label:'Notes', icon:'📄'},
    {key:'board', label:'Public Board', icon:'📢'},
    {key:'clubs', label:'Clubs', icon:'🎭'},
    {key:'forum', label:'Discussion Forum', icon:'💬'},
    {key:'leaderboard', label:'Leaderboard', icon:'🏆'},
    {key:'bookmarks', label:'Bookmarks', icon:'🔖'},
    {key:'myattendance', label:'My Attendance', icon:'✅'},
    {key:'mymarks', label:'My Marks', icon:'📝'},
    {key:'tests', label:'My Tests', icon:'🧪'},
  ];
}
function renderShell(){
  document.getElementById('authScreen').style.display='none';
  document.getElementById('appScreen').style.display='block';

  const items = navItemsFor(state.session.role);
  document.getElementById('sidebarNav').innerHTML = items.map(i=>`
    <button class="nav-item ${state.tab===i.key?'active':''}" data-tab="${i.key}">
      <span class="nav-icon-wrap">${i.icon}<span class="nav-dot ${((state.unreadByTab||{})[i.key])?'show':''}" data-dot-tab="${i.key}"></span></span>
      <span class="nav-label">${i.label}</span>
    </button>
  `).join('');
  document.querySelectorAll('.nav-item').forEach(b=>b.addEventListener('click', ()=>{
    const tab = b.dataset.tab;
    state.tab=tab; state.tabError=''; render();
    markTabNotificationsRead(tab);
    closeSidebar();
  }));
  updateBellBadge();

  document.getElementById('sidebarFooter').innerHTML = `
    <div class="user-chip">
      <div class="avatar" id="profileAvatarBtn" style="cursor:pointer;" title="View profile">${initials(state.session.name)}</div>
      <div><div class="who">${esc(state.session.name)}</div><div class="role-tag">${roleLabel(state.session.role)}</div></div>
    </div>
    <button class="settings-btn" id="accountSettingsBtn">⚙ Account settings</button>
    <button class="logout-btn" id="logoutBtn">Log out</button>
  `;
  document.getElementById('logoutBtn').addEventListener('click', ()=>{ closeSidebar(); logout(); });
  document.getElementById('accountSettingsBtn').addEventListener('click', ()=>{ closeSidebar(); openAccountSettingsModal(); });
  document.getElementById('profileAvatarBtn').addEventListener('click', ()=>{ closeSidebar(); openProfileCardModal(); });
  document.getElementById('mobileWho').textContent = state.session.name+' · '+roleLabel(state.session.role);
  document.getElementById('mobileWho').style.cursor = 'pointer';
  document.getElementById('mobileWho').onclick = openProfileCardModal;
  document.getElementById('mobileLogout').onclick = logout;
  const mobileSettings = document.getElementById('mobileSettings');
  if(mobileSettings) mobileSettings.onclick = openAccountSettingsModal;

  renderTab();
}
// NEW: bug fix — tapping the profile icon on any dashboard shows a profile
// card (name, role, and context like department/section), and lets the
// user update their display name right there.
function openProfileCardModal(){
  const s = state.session;
  const rows = [];
  rows.push(['Username', s.username]);
  rows.push(['Role', roleLabel(s.role)]);
  if(s.department) rows.push(['Department', s.department]);
  if(s.role==='student'){
    const sec = findAnySectionById(s.section_id);
    rows.push(['Section', sec ? sec.name : (s.section_id||'—')]);
    if(s.roll_number) rows.push(['Roll number', s.roll_number]);
  }
  if(s.role==='faculty'){
    const names = (s.section_ids||[]).map(id=>{ const sec=findAnySectionById(id); return sec?sec.name:id; });
    if(names.length) rows.push(['Sections', names.join(', ')]);
  }
  showModal(`
    <h2>Profile</h2>
    <div style="display:flex;align-items:center;gap:14px;margin-bottom:18px;">
      <div class="avatar" style="width:56px;height:56px;font-size:20px;">${initials(s.name)}</div>
      <div style="font-size:13px;color:var(--ink-light);">Tap "Save" below after editing your name.</div>
    </div>
    <form id="profileCardForm">
      <div class="field"><label>Name</label><input type="text" name="name" value="${esc(s.name)}" required></div>
      ${rows.map(([label,val])=>`
        <div class="reg-code-row"><span>${esc(label)}</span><span class="mono">${esc(val)}</span></div>
      `).join('')}
      <div class="modal-actions" style="margin-top:16px;">
        <button type="button" class="btn btn-outline" id="cancelModal">Close</button>
        <button type="submit" class="btn btn-primary">Save changes</button>
      </div>
    </form>
  `);
  document.getElementById('profileCardForm').addEventListener('submit', async e=>{
    e.preventDefault();
    const fd = new FormData(e.target);
    const name = (fd.get('name')||'').trim();
    if(!name){ alert('Name cannot be empty.'); return; }
    try{
      const data = await api('/account/profile', {method:'POST', body:{ name }});
      state.session = { ...state.session, name: data.user.name };
      closeModal();
      renderShell();
    }catch(err){ alert(err.message); }
  });
}
function renderTab(){
  const el = document.getElementById('mainContent');
  const errHtml = state.tabError ? `<div class="banner-error">${esc(state.tabError)}</div>` : '';
  const map = {
    colleges: viewColleges, reports: viewReports,
    hods: viewHods, network: viewNetwork,
    sections: viewSections, faculty: viewFaculty, students: viewStudents,
    mystudents: viewMyStudents, attendance: viewAttendance, marks: viewMarks,
    announcements: viewAnnouncements, events: viewEvents, notes: viewNotes, board: viewBoard,
    myattendance: viewMyAttendance, mymarks: viewMyMarks,
    clubs: viewClubs, forum: viewForum, leaderboard: viewLeaderboard,
    bookmarks: viewBookmarks, analytics: viewAnalytics, tests: viewTests,
  };
  const fn = map[state.tab] || viewAnnouncements;
  el.innerHTML = errHtml + fn();
  attachTabHandlers();
}
function render(){
  if(!state.ready) return;
  if(!state.session) renderAuth();
  else renderShell();
}

/* ============ MODAL HELPERS ============ */
function showModal(html){
  document.getElementById('modalBody').innerHTML = html;
  document.getElementById('overlay').classList.add('show');
  const cancel = document.getElementById('cancelModal');
  if(cancel) cancel.addEventListener('click', closeModal);
}
function closeModal(){
  document.getElementById('overlay').classList.remove('show');
  document.getElementById('modalBody').innerHTML='';
}
document.getElementById('overlay').addEventListener('click', e=>{ if(e.target.id==='overlay' && !(testAttemptState && !testAttemptState.submitting)) closeModal(); });
// UPDATED: light/dark toggle button shown on the auth screen.
const themeToggleBtn = document.getElementById('themeToggle');
if(themeToggleBtn) themeToggleBtn.addEventListener('click', toggleTheme);

/* ============ MOBILE SIDEBAR DRAWER ============ */
// UPDATED: on phones the sidebar now behaves like a normal app's nav menu —
// off-screen until the ☰ button opens it, closable via the ✕ inside it, the
// dimmed backdrop, the Escape key, or by picking a tab.
function openSidebar(){
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('sidebarBackdrop').classList.add('show');
  document.body.classList.add('sidebar-open-lock');
}
function closeSidebar(){
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarBackdrop').classList.remove('show');
  document.body.classList.remove('sidebar-open-lock');
}
const hamburgerBtn = document.getElementById('hamburgerBtn');
if(hamburgerBtn) hamburgerBtn.addEventListener('click', openSidebar);
const sidebarCloseBtn = document.getElementById('sidebarCloseBtn');
if(sidebarCloseBtn) sidebarCloseBtn.addEventListener('click', closeSidebar);
const sidebarBackdrop = document.getElementById('sidebarBackdrop');
if(sidebarBackdrop) sidebarBackdrop.addEventListener('click', closeSidebar);
document.addEventListener('keydown', e=>{ if(e.key==='Escape') closeSidebar(); });

/* ============ FULLSCREEN (fully OPTIONAL — a convenience toggle only) ============
   IMPORTANT: NO AUTOMATIC EXAM SUBMISSION, EVER. Full-screen mode is never
   required to take a test, and entering/exiting it — by any means (Esc,
   Alt+Tab, the toggle button, etc.) — has no effect on an in-progress
   test: no warning, no forced re-entry, no submission, no termination. */
function requestFullscreenSafe(){
  const el = document.documentElement;
  const fn = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen;
  if(!fn) return Promise.resolve(false);
  return fn.call(el).then(()=>true).catch(()=>false);
}
function exitFullscreenSafe(){
  const isFs = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement;
  const fn = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen || document.msExitFullscreen;
  if(isFs && fn) fn.call(document).catch(()=>{});
}
function isFullscreenActive(){
  return !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement);
}
function toggleFullscreenSafe(){
  if(isFullscreenActive()) exitFullscreenSafe();
  else requestFullscreenSafe();
}

/* ============ ACCOUNT SETTINGS ============ */
function openAccountSettingsModal(){
  const currentTheme = document.documentElement.getAttribute('data-theme')||'light';
  showModal(`
    <h2>Account settings</h2>
    <p style="font-size:13.5px;color:var(--ink-light);margin:0 0 14px;">Signed in as <strong>${esc(state.session.name)}</strong> (${roleLabel(state.session.role)}).</p>
    <div class="field">
      <label>Appearance</label>
      <div class="theme-switch-row">
        <button type="button" class="theme-opt ${currentTheme==='light'?'selected':''}" data-theme-opt="light">☀️ Light</button>
        <button type="button" class="theme-opt ${currentTheme==='dark'?'selected':''}" data-theme-opt="dark">🌙 Dark</button>
      </div>
    </div>
    <form id="accountPwForm">
      <div class="field"><label>Current password</label><input type="password" name="current_password" required></div>
      <div class="field"><label>New password</label><input type="password" name="new_password" minlength="6" required></div>
      <div class="field"><label>Confirm new password</label><input type="password" name="confirm_password" minlength="6" required></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-outline" id="cancelModal">Cancel</button>
        <button type="submit" class="btn btn-primary">Update password</button>
      </div>
    </form>
  `);
  document.querySelectorAll('[data-theme-opt]').forEach(b=>b.addEventListener('click', ()=>{
    applyTheme(b.dataset.themeOpt);
    document.querySelectorAll('[data-theme-opt]').forEach(x=>x.classList.remove('selected'));
    b.classList.add('selected');
  }));
  document.getElementById('accountPwForm').addEventListener('submit', async e=>{
    e.preventDefault();
    const fd = new FormData(e.target);
    if(fd.get('new_password')!==fd.get('confirm_password')){ alert("New password and confirmation don't match."); return; }
    try{
      await api('/account/password', {method:'POST', body:{ current_password:fd.get('current_password'), new_password:fd.get('new_password') }});
      closeModal(); alert('Your password has been updated.');
    }catch(err){ alert(err.message); }
  });
}

/* ============ SUPER ADMIN: COLLEGES ============ */
function viewColleges(){
  const list = state.colleges;
  return `
    <div class="main-header">
      <div><h2>Colleges</h2><div class="sub">Every college on the Campus Orbis platform</div></div>
      <button class="btn btn-gold" id="newCollegeBtn">+ Add college</button>
    </div>
    ${list.length===0 ? emptyState('No colleges yet', 'Add the first college — you\'ll create its College Admin account at the same time.') : `
    <div class="college-grid">
      ${list.map(c=>`
        <div class="college-card">
          <div class="college-card-top">
            ${c.has_logo ? `<img class="college-card-logo" src="/api/super/colleges/${c.id}/logo" alt="${esc(c.name)} logo">` : `<div class="college-card-logo" style="display:flex;align-items:center;justify-content:center;font-weight:700;color:var(--ink-light);">${esc(c.name[0]||'?')}</div>`}
            <div style="flex:1;">
              <h3>${esc(c.name)}</h3>
              <span class="college-status ${c.status}">${c.status}</span>
            </div>
          </div>
          <div class="college-counts">
            <div class="stat"><div class="n">${c.counts.hods}</div><div class="l">HODs</div></div>
            <div class="stat"><div class="n">${c.counts.faculty}</div><div class="l">Faculty</div></div>
            <div class="stat"><div class="n">${c.counts.students}</div><div class="l">Students</div></div>
          </div>
          <div class="college-card-actions">
            <button class="btn btn-outline btn-small" data-toggle-college="${c.id}" data-current-status="${c.status}">${c.status==='active'?'Disable':'Enable'}</button>
            <button class="btn-danger" data-del-college="${c.id}" data-college-name="${esc(c.name)}">Remove</button>
          </div>
        </div>
      `).join('')}
    </div>`}
  `;
}
function openCollegeModal(){
  showModal(`
    <h2>Add a college</h2>
    <form id="collegeForm">
      <div class="field"><label>College name</label><input type="text" name="name" required></div>
      <div class="field"><label>College logo (optional)</label><input type="file" name="logo" accept="image/png,image/jpeg,image/webp"></div>
      <hr style="border:none;border-top:1px solid var(--line);margin:16px 0;">
      <p style="font-size:12.5px;color:var(--ink-light);margin:0 0 10px;text-transform:uppercase;letter-spacing:0.04em;font-weight:700;">College Admin account</p>
      <div class="field"><label>Admin's full name</label><input type="text" name="admin_name" required></div>
      <div class="field"><label>Admin username</label><input type="text" name="admin_username" required></div>
      <div class="field"><label>Admin password</label><input type="password" name="admin_password" minlength="6" required></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-outline" id="cancelModal">Cancel</button>
        <button type="submit" class="btn btn-primary" id="collegeSubmitBtn">Create college</button>
      </div>
    </form>
  `);
  document.getElementById('collegeForm').addEventListener('submit', async e=>{
    e.preventDefault();
    const fd = new FormData(e.target);
    if(fd.get('logo') && fd.get('logo').size===0) fd.delete('logo');
    const btn = document.getElementById('collegeSubmitBtn');
    btn.disabled = true; btn.textContent = 'Creating…';
    try{
      const data = await apiUpload('/super/colleges', fd);
      state.colleges.unshift(data.college);
      closeModal(); render();
    }catch(err){
      alert(err.message);
      btn.disabled = false; btn.textContent = 'Create college';
    }
  });
}

/* ============ SUPER ADMIN: REPORTS ============ */
function viewReports(){
  const r = state.reports || {};
  const cards = [
    ['Colleges', r.colleges], ['College Admins', r.admins], ['HODs', r.hods],
    ['Faculty', r.faculty], ['Students', r.students], ['Sections', r.sections],
    ['Events', r.events], ['Notes', r.notes], ['Board posts', r.posts],
  ];
  return `
    <div class="main-header"><div><h2>Reports</h2><div class="sub">Platform-wide counts across every college</div></div></div>
    <div class="college-counts" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:14px;">
      ${cards.map(([label,val])=>`
        <div class="stat" style="padding:20px 10px;">
          <div class="n" style="font-size:26px;">${val==null?'—':val}</div>
          <div class="l">${esc(label)}</div>
        </div>
      `).join('')}
    </div>
    <div class="chart-grid">
      <div class="chart-card"><h4>Platform registrations (last 6 months)</h4><div class="chart-wrap"><canvas id="chartSuperRegistrations"></canvas></div></div>
      <div class="chart-card"><h4>Colleges by status</h4><div class="chart-wrap"><canvas id="chartSuperCollegeStatus"></canvas></div></div>
      <div class="chart-card"><h4>Users by role</h4><div class="chart-wrap"><canvas id="chartSuperUsersByRole"></canvas></div></div>
    </div>
  `;
}

/* ============ COLLEGE ADMIN: HODs ============ */
function viewHods(){
  const list = state.hods;
  return `
    <div class="main-header">
      <div><h2>HODs</h2><div class="sub">Department heads for your college</div></div>
      <button class="btn btn-gold" id="newHodBtn">+ Add HOD</button>
    </div>
    ${list.length===0 ? emptyState('No HODs yet', 'Add a department head — they\'ll create faculty, sections, and students for their department.') : `
    <table>
      <thead><tr><th>Name</th><th>Username</th><th>Department</th><th></th></tr></thead>
      <tbody>
        ${list.map(h=>`
          <tr>
            <td>${esc(h.name)}</td>
            <td class="mono">${esc(h.username)}</td>
            <td>${esc(h.department)}</td>
            <td><button class="btn-danger" data-del-hod="${h.id}">Remove</button></td>
          </tr>
        `).join('')}
      </tbody>
    </table>`}
  `;
}
function openHodModal(){
  showModal(`
    <h2>Add an HOD</h2>
    <form id="hodForm">
      <div class="field"><label>Full name</label><input type="text" name="name" required></div>
      <div class="field"><label>Department</label><input type="text" name="department" placeholder="e.g. Computer Science" required></div>
      <div class="field"><label>Username</label><input type="text" name="username" required></div>
      <div class="field"><label>Password</label><input type="password" name="password" minlength="6" required></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-outline" id="cancelModal">Cancel</button>
        <button type="submit" class="btn btn-primary">Add HOD</button>
      </div>
    </form>
  `);
  document.getElementById('hodForm').addEventListener('submit', async e=>{
    e.preventDefault();
    const fd = new FormData(e.target);
    try{
      const data = await api('/college/hods', {method:'POST', body:{
        name: fd.get('name').trim(), department: fd.get('department').trim(),
        username: fd.get('username').trim(), password: fd.get('password')
      }});
      state.hods.push(data.hod);
      closeModal(); render();
    }catch(err){ alert(err.message); }
  });
}

/* ============ CAMPUS NETWORK (College Admin <-> College Admin) ============ */
async function refreshNetworkState(){
  const data = await api('/network/state');
  state.networkAdmins = data.admins;
  state.networkIncoming = data.incoming;
}
function viewNetwork(){
  const incoming = state.networkIncoming, admins = state.networkAdmins;
  const connected = admins.filter(a=>a.connection.state==='connected');
  const others = admins.filter(a=>a.connection.state!=='connected');
  return `
    <div class="main-header"><div><h2>Campus Network</h2><div class="sub">Connect with other colleges' admins — nothing is shared until a request is accepted</div></div></div>
    ${incoming.length>0 ? `
      <h3 style="font-size:15px;margin:0 0 10px;">Requests waiting on you</h3>
      ${incoming.map(r=>`
        <div class="reg-code-row">
          <span>${esc(r.from_name)} <span class="mono" style="color:var(--ink-light);">(${esc(r.from_college||'')})</span></span>
          <span>
            <button class="btn btn-gold btn-small" data-accept-req="${r.id}">Accept</button>
            <button class="btn-danger" data-decline-req="${r.id}">Decline</button>
          </span>
        </div>
      `).join('')}
      <div style="height:20px;"></div>
    ` : ''}
    ${connected.length>0 ? `
      <h3 style="font-size:15px;margin:0 0 10px;">Connected</h3>
      ${connected.map(a=>`
        <div class="reg-code-row">
          <span>${esc(a.name)} <span class="mono" style="color:var(--ink-light);">(${esc(a.college_name)})</span></span>
          <button class="btn btn-outline btn-small" data-message-admin="${a.username}" data-admin-name="${esc(a.name)}">Message</button>
        </div>
      `).join('')}
      <div style="height:20px;"></div>
    ` : ''}
    <h3 style="font-size:15px;margin:0 0 10px;">Other college admins</h3>
    ${others.length===0 ? `<p class="hint">No other college admins yet — once the Super Admin adds more colleges, they'll show up here.</p>` : others.map(a=>{
      const st = a.connection.state;
      let action = `<button class="btn btn-gold btn-small" data-connect="${a.username}">Send request</button>`;
      if(st==='pending_sent') action = `<span class="mono" style="color:var(--ink-light);font-size:12px;">Request sent</span>`;
      if(st==='pending_received') action = `<span class="mono" style="color:var(--ink-light);font-size:12px;">Check requests above</span>`;
      return `
        <div class="reg-code-row">
          <span>${esc(a.name)} <span class="mono" style="color:var(--ink-light);">(${esc(a.college_name)})</span></span>
          ${action}
        </div>
      `;
    }).join('')}
  `;
}
async function openNetworkChat(username, name){
  const data = await api('/network/messages/'+username);
  renderNetworkChatModal(username, name, data.messages);
}
function renderNetworkChatModal(username, name, messages){
  showModal(`
    <h2>${esc(name)}</h2>
    <div class="reg-code-lists" style="grid-template-columns:1fr;max-height:320px;overflow-y:auto;margin-bottom:14px;" id="chatThread">
      ${messages.length===0 ? `<p class="hint">No messages yet — say hello, or share an announcement/event invite.</p>` : messages.map(m=>`
        <div class="reply-item">
          <p><strong>${esc(m.sender_name)}</strong>${m.title?` — ${esc(m.title)}`:''}</p>
          <p>${esc(m.body)}</p>
          <div class="meta"><span>${m.type!=='message'?esc(m.type.replace('_',' ')):''}</span><span>${timeAgo(m.created_at)}</span></div>
        </div>
      `).join('')}
    </div>
    <form id="chatForm">
      <div class="field">
        <label>Type</label>
        <div class="radio-row">
          <label class="radio-opt selected" data-val="message">Message</label>
          <label class="radio-opt" data-val="announcement">Announcement</label>
          <label class="radio-opt" data-val="event_invite">Event invite</label>
        </div>
        <input type="hidden" name="type" value="message">
      </div>
      <div class="field" id="chatTitleField" style="display:none;"><label>Title</label><input type="text" name="title"></div>
      <div class="field"><label>Message</label><textarea name="body" rows="3" required></textarea></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-outline" id="cancelModal">Close</button>
        <button type="submit" class="btn btn-primary">Send</button>
      </div>
    </form>
  `);
  const form = document.getElementById('chatForm');
  const opts = form.querySelectorAll('.radio-opt');
  const hidden = form.querySelector('input[type=hidden]');
  const titleField = document.getElementById('chatTitleField');
  opts.forEach(o=>o.addEventListener('click', ()=>{
    opts.forEach(x=>x.classList.remove('selected')); o.classList.add('selected'); hidden.value = o.dataset.val;
    titleField.style.display = o.dataset.val==='message' ? 'none' : 'block';
  }));
  form.addEventListener('submit', async e=>{
    e.preventDefault();
    const fd = new FormData(e.target);
    try{
      await api('/network/messages/'+username, {method:'POST', body:{
        type: fd.get('type'), title: fd.get('title'), body: fd.get('body').trim()
      }});
      const fresh = await api('/network/messages/'+username);
      renderNetworkChatModal(username, name, fresh.messages);
    }catch(err){ alert(err.message); }
  });
}

/* ============ HOD: SECTIONS ============ */
function viewSections(){
  const list = state.sections;
  return `
    <div class="main-header">
      <div><h2>Sections</h2><div class="sub">${esc(state.session.department)} — create sections and assign a faculty in-charge</div></div>
      <button class="btn btn-gold" id="newSectionBtn">+ Add section</button>
    </div>
    ${list.length===0 ? emptyState('No sections yet', 'Add a section (e.g. "Section A") — students and a faculty in-charge go here.') : `
    <div class="section-chip-row" style="flex-direction:column;">
      ${list.map(s=>`
        <div class="reg-code-row">
          <span>${esc(s.name)}${s.year?` <span class="mono" style="color:var(--ink-light);">(${esc(s.year)})</span>`:''}${s.faculty_username?` <span class="mono" style="color:var(--ink-light);">— in-charge: ${esc(s.faculty_username)}</span>`:''}</span>
          <span>
            <select data-assign-section="${s.id}" style="padding:6px 8px;border-radius:6px;border:1px solid var(--line);font-size:12.5px;">
              <option value="">— Assign faculty —</option>
              ${state.faculty.map(f=>`<option value="${f.username}" ${s.faculty_username===f.username?'selected':''}>${esc(f.name)}</option>`).join('')}
            </select>
            <button class="btn-danger" data-del-section="${s.id}">Remove</button>
          </span>
        </div>
      `).join('')}
    </div>`}
  `;
}
function openSectionModal(){
  showModal(`
    <h2>Add a section</h2>
    <form id="sectionForm">
      <div class="field"><label>Section name</label><input type="text" name="name" placeholder="e.g. Section A" required></div>
      <div class="field"><label>Year (optional)</label><input type="text" name="year" placeholder="e.g. 1st Year"></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-outline" id="cancelModal">Cancel</button>
        <button type="submit" class="btn btn-primary">Add section</button>
      </div>
    </form>
  `);
  document.getElementById('sectionForm').addEventListener('submit', async e=>{
    e.preventDefault();
    const fd = new FormData(e.target);
    try{
      const data = await api('/hod/sections', {method:'POST', body:{ name: fd.get('name').trim(), year: (fd.get('year')||'').trim() }});
      state.sections.push(data.section);
      closeModal(); render();
    }catch(err){ alert(err.message); }
  });
}

/* ============ HOD: FACULTY ============ */
function viewFaculty(){
  const list = state.faculty;
  return `
    <div class="main-header">
      <div><h2>Faculty</h2><div class="sub">${esc(state.session.department)}</div></div>
      <button class="btn btn-gold" id="newFacultyBtn">+ Add faculty</button>
    </div>
    ${list.length===0 ? emptyState('No faculty yet', 'Add a faculty member, then assign them to a section from the Sections tab.') : `
    <table>
      <thead><tr><th>Name</th><th>Username</th><th>Sections</th><th></th></tr></thead>
      <tbody>
        ${list.map(f=>`
          <tr>
            <td>${esc(f.name)}</td>
            <td class="mono">${esc(f.username)}</td>
            <td>${(f.section_ids||[]).map(id=>{ const s=state.sections.find(x=>x.id===id); return s?esc(s.name):''; }).filter(Boolean).join(', ') || '<span style="color:var(--ink-light);">none</span>'}</td>
            <td><button class="btn-danger" data-del-faculty="${f.id}">Remove</button></td>
          </tr>
        `).join('')}
      </tbody>
    </table>`}
  `;
}
function openFacultyModal(){
  showModal(`
    <h2>Add faculty</h2>
    <form id="facultyForm">
      <div class="field"><label>Full name</label><input type="text" name="name" required></div>
      <div class="field"><label>Username</label><input type="text" name="username" required></div>
      <div class="field"><label>Password</label><input type="password" name="password" minlength="6" required></div>
      <div class="hint">Assign them to a section afterward from the Sections tab.</div>
      <div class="modal-actions">
        <button type="button" class="btn btn-outline" id="cancelModal">Cancel</button>
        <button type="submit" class="btn btn-primary">Add faculty</button>
      </div>
    </form>
  `);
  document.getElementById('facultyForm').addEventListener('submit', async e=>{
    e.preventDefault();
    const fd = new FormData(e.target);
    try{
      const data = await api('/hod/faculty', {method:'POST', body:{
        name: fd.get('name').trim(), username: fd.get('username').trim(), password: fd.get('password')
      }});
      state.faculty.push(data.faculty);
      closeModal(); render();
    }catch(err){ alert(err.message); }
  });
}

/* ============ HOD: STUDENTS ============ */
function viewStudents(){
  const list = state.students;
  return `
    <div class="main-header">
      <div><h2>Students</h2><div class="sub">${esc(state.session.department)}</div></div>
      <button class="btn btn-gold" id="newStudentBtn" ${state.sections.length===0?'disabled title="Add a section first"':''}>+ Add student</button>
    </div>
    ${state.sections.length===0 ? `<div class="hint" style="margin-bottom:16px;">Add a section before adding students.</div>` : ''}
    ${list.length===0 ? emptyState('No students yet', 'Add a student and assign them to a section.') : `
    <table>
      <thead><tr><th>Name</th><th>Username</th><th>Roll No.</th><th>Section</th><th></th></tr></thead>
      <tbody>
        ${list.map(s=>{
          const sec = state.sections.find(x=>x.id===s.section_id);
          return `
          <tr>
            <td>${esc(s.name)}</td>
            <td class="mono">${esc(s.username)}</td>
            <td class="mono">${esc(s.roll_number||'—')}</td>
            <td>${sec?esc(sec.name):'<span style="color:var(--ink-light);">unassigned</span>'}</td>
            <td><button class="btn-danger" data-del-student="${s.id}">Remove</button></td>
          </tr>
        `;}).join('')}
      </tbody>
    </table>`}
  `;
}
function openStudentModal(){
  showModal(`
    <h2>Add a student</h2>
    <form id="studentForm">
      <div class="field"><label>Full name</label><input type="text" name="name" required></div>
      <div class="field"><label>Roll number</label><input type="text" name="roll_number"></div>
      <div class="field"><label>Section</label>
        <select name="section_id" required>
          ${state.sections.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>Username</label><input type="text" name="username" required></div>
      <div class="field"><label>Password</label><input type="password" name="password" minlength="6" required></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-outline" id="cancelModal">Cancel</button>
        <button type="submit" class="btn btn-primary">Add student</button>
      </div>
    </form>
  `);
  document.getElementById('studentForm').addEventListener('submit', async e=>{
    e.preventDefault();
    const fd = new FormData(e.target);
    try{
      const data = await api('/hod/students', {method:'POST', body:{
        name: fd.get('name').trim(), roll_number: fd.get('roll_number').trim(),
        section_id: fd.get('section_id'), username: fd.get('username').trim(), password: fd.get('password')
      }});
      state.students.push(data.student);
      closeModal(); render();
    }catch(err){ alert(err.message); }
  });
}

/* ============ FACULTY: MY STUDENTS ============ */
function viewMyStudents(){
  const list = state.myStudents;
  if(state.mySections.length===0) return emptyState('No section assigned yet', 'Ask your HOD to assign you to a section — you\'ll see its students here.');
  return `
    <div class="main-header"><div><h2>My Students</h2><div class="sub">${state.mySections.map(s=>esc(s.name)).join(', ')}</div></div></div>
    ${list.length===0 ? emptyState('No students yet', 'Your HOD hasn\'t added students to your section yet.') : `
    <table>
      <thead><tr><th>Name</th><th>Roll No.</th><th>Username</th></tr></thead>
      <tbody>
        ${list.map(s=>`<tr><td>${esc(s.name)}</td><td class="mono">${esc(s.roll_number||'—')}</td><td class="mono">${esc(s.username)}</td></tr>`).join('')}
      </tbody>
    </table>`}
  `;
}

/* ============ FACULTY: ATTENDANCE ============ */
function viewAttendance(){
  if(state.mySections.length===0) return emptyState('No section assigned yet', 'Ask your HOD to assign you to a section first.');
  const sectionOptions = state.mySections.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('');
  const hourOptions = [1,2,3,4,5,6,7,8].map(h=>`<option value="${h}">Hour ${h}</option>`).join('');
  return `
    <div class="main-header"><div><h2>Attendance</h2><div class="sub">Mark attendance for your section, hour by hour</div></div></div>
    <form id="attendanceSetupForm" style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px;align-items:flex-end;">
      <div class="field" style="margin:0;"><label>Section</label><select name="section_id">${sectionOptions}</select></div>
      <div class="field" style="margin:0;"><label>Date</label><input type="date" name="date" value="${new Date().toISOString().slice(0,10)}"></div>
      <div class="field" style="margin:0;"><label>Hour</label><select name="hour">${hourOptions}</select></div>
      <button type="submit" class="btn btn-outline btn-small">Load</button>
    </form>
    <div id="attendanceBody"></div>
  `;
}
async function loadAttendanceSheet(sectionId, date, hour){
  hour = String(hour||1);
  const students = state.myStudents.filter(s=>s.section_id===sectionId);
  const body = document.getElementById('attendanceBody');
  if(!body) return;
  if(students.length===0){ body.innerHTML = emptyState('No students in this section', ''); return; }
  let hist;
  try{ hist = await api('/faculty/attendance/'+sectionId); }catch(e){ hist = {attendance:[]}; }
  const existing = (hist.attendance||[]).find(r=>r.date===date && String(r.hour)===hour);
  if(existing){
    // UPDATED: attendance already submitted for this section/date/hour — locked, no edit/resubmit.
    const presentSet = new Set(existing.records.filter(r=>r.present).map(r=>r.student_username));
    body.innerHTML = `
      <div class="hint" style="margin-bottom:14px;">🔒 Attendance for <strong>${esc(date)}, Hour ${esc(hour)}</strong> was already submitted by ${esc(existing.taken_by_name||'')} and is locked — it cannot be edited or resubmitted.</div>
      <div class="attendance-grid">
        ${students.map(s=>`
          <div class="attendance-row">
            <span>${esc(s.name)} <span class="mono" style="color:var(--ink-light);">${esc(s.roll_number||'')}</span></span>
            <span class="status-pill ${presentSet.has(s.username)?'open':'resolved'}">${presentSet.has(s.username)?'Present':'Absent'}</span>
          </div>
        `).join('')}
      </div>
      <div id="attendanceHistory" style="margin-top:24px;"></div>
    `;
    renderAttendanceHistory(hist.attendance);
    return;
  }
  body.innerHTML = `
    <div class="attendance-grid" id="attendanceGrid">
      ${students.map(s=>`
        <div class="attendance-row" data-student="${s.username}">
          <span>${esc(s.name)} <span class="mono" style="color:var(--ink-light);">${esc(s.roll_number||'')}</span></span>
          <div class="attendance-toggle">
            <button type="button" class="present on" data-mark="present">Present</button>
            <button type="button" class="absent" data-mark="absent">Absent</button>
          </div>
        </div>
      `).join('')}
    </div>
    <button class="btn btn-gold" id="saveAttendanceBtn">Save attendance for Hour ${esc(hour)}</button>
    <div id="attendanceHistory" style="margin-top:24px;"></div>
  `;
  document.querySelectorAll('#attendanceGrid .attendance-toggle button').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const row = btn.closest('.attendance-row');
      row.querySelectorAll('button').forEach(b=>b.classList.remove('on'));
      btn.classList.add('on');
    });
  });
  document.getElementById('saveAttendanceBtn').addEventListener('click', async ()=>{
    const records = [...document.querySelectorAll('#attendanceGrid .attendance-row')].map(row=>({
      student_username: row.dataset.student,
      present: row.querySelector('.present').classList.contains('on')
    }));
    try{
      await api('/faculty/attendance', {method:'POST', body:{ section_id: sectionId, date, hour, records }});
      alert('Attendance saved for '+date+', Hour '+hour+'. This cannot be edited once submitted.');
      loadAttendanceSheet(sectionId, date, hour);
    }catch(err){ alert(err.message); }
  });
  renderAttendanceHistory(hist.attendance);
}
function renderAttendanceHistory(rows){
  const el = document.getElementById('attendanceHistory');
  if(!el) return;
  if(rows.length===0){ el.innerHTML = ''; return; }
  el.innerHTML = `
    <h3 style="font-size:14px;margin:0 0 10px;">Past records</h3>
    ${rows.slice(0,10).map(r=>{
      const present = r.records.filter(x=>x.present).length;
      return `<div class="reg-code-row"><span class="mono">${esc(r.date)}${r.hour?' · Hour '+esc(r.hour):''}</span><span>${present} / ${r.records.length} present 🔒</span></div>`;
    }).join('')}
  `;
}


/* ============ FACULTY: MARKS ============ */
function viewMarks(){
  if(state.mySections.length===0) return emptyState('No section assigned yet', 'Ask your HOD to assign you to a section first.');
  const sectionOptions = state.mySections.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('');
  return `
    <div class="main-header">
      <div><h2>Marks</h2><div class="sub">Record test scores for your section</div></div>
      <button class="btn btn-gold" id="newMarksBtn">+ New test</button>
    </div>
    <div class="field" style="max-width:280px;"><label>Section</label><select id="marksSectionSelect">${sectionOptions}</select></div>
    <div id="marksBody" style="margin-top:16px;"></div>
  `;
}
async function loadMarksList(sectionId){
  const body = document.getElementById('marksBody');
  if(!body) return;
  const data = await api('/faculty/marks/'+sectionId);
  if(data.marks.length===0){ body.innerHTML = emptyState('No tests recorded yet', 'Click "+ New test" to record scores.'); return; }
  body.innerHTML = data.marks.map(m=>`
    <div class="reg-code-row">
      <span>${esc(m.test_name)} <span class="mono" style="color:var(--ink-light);">/ ${m.max_score}</span></span>
      <span>${m.records.length} scored <button class="btn-danger" data-del-marks="${m.id}" style="margin-left:8px;">Remove</button></span>
    </div>
  `).join('');
}
function openMarksModal(){
  const sectionId = document.getElementById('marksSectionSelect').value;
  const students = state.myStudents.filter(s=>s.section_id===sectionId);
  if(students.length===0){ alert('No students in this section yet.'); return; }
  showModal(`
    <h2>New test</h2>
    <form id="marksForm">
      <div class="field"><label>Test name</label><input type="text" name="test_name" placeholder="e.g. Unit Test 1" required></div>
      <div class="field"><label>Max score</label><input type="number" name="max_score" min="1" value="100" required></div>
      <div class="field"><label>Scores</label>
        <div class="attendance-grid">
          ${students.map(s=>`
            <div class="attendance-row">
              <span>${esc(s.name)}</span>
              <input type="number" min="0" data-score="${s.username}" style="width:80px;padding:6px 8px;border:1px solid var(--line);border-radius:6px;" value="0">
            </div>
          `).join('')}
        </div>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-outline" id="cancelModal">Cancel</button>
        <button type="submit" class="btn btn-primary">Save test</button>
      </div>
    </form>
  `);
  document.getElementById('marksForm').addEventListener('submit', async e=>{
    e.preventDefault();
    const fd = new FormData(e.target);
    const records = [...document.querySelectorAll('[data-score]')].map(inp=>({ student_username: inp.dataset.score, score: Number(inp.value)||0 }));
    try{
      await api('/faculty/marks', {method:'POST', body:{
        section_id: sectionId, test_name: fd.get('test_name').trim(), max_score: Number(fd.get('max_score')), records
      }});
      closeModal();
      loadMarksList(sectionId);
    }catch(err){ alert(err.message); }
  });
}

/* ============ STUDENT: MY ATTENDANCE / MARKS ============ */
function viewMyAttendance(){
  const a = state.myAttendance;
  if(!a || a.total_count===0) return emptyState('No attendance recorded yet', 'Your faculty hasn\'t taken attendance yet.');
  return `
    <div class="main-header"><div><h2>My Attendance</h2><div class="sub">${a.present_count} of ${a.total_count} days present</div></div></div>
    <div class="percentage-badge">${a.percentage}%</div>
    <div style="margin-top:20px;">
      ${a.history.map(h=>`<div class="reg-code-row"><span class="mono">${esc(h.date)}${h.hour?' · Hour '+esc(h.hour):''}</span><span class="status-pill ${h.present?'open':'resolved'}">${h.present?'Present':'Absent'}</span></div>`).join('')}
    </div>
  `;
}
function viewMyMarks(){
  const list = state.myMarks;
  return `
    <div class="main-header"><div><h2>My Marks</h2><div class="sub">Test scores recorded by your faculty</div></div></div>
    ${list.length===0 ? emptyState('No marks yet', 'Scores will show up here once your faculty records a test.') : list.map(m=>`
      <div class="reg-code-row"><span>${esc(m.test_name)}</span><span><strong>${m.score}</strong> / ${m.max_score}</span></div>
    `).join('')}
  `;
}

/* ============ ANNOUNCEMENTS (shared) ============ */
function viewAnnouncements(){
  const list = state.announcements;
  return `
    <div class="main-header">
      <div><h2>Announcements</h2><div class="sub">Posted to whichever department/year/section the author picked</div></div>
      ${canPost()?`<button class="btn btn-gold" id="newAnnouncementBtn">+ New announcement</button>`:''}
    </div>
    <div class="board">
      ${list.length===0 ? emptyState('Nothing pinned yet', 'Check back soon.') : `
      <div class="board-grid">
        ${list.map(a=>`
          <div class="pin-card ${a.priority==='urgent'?'urgent':''}">
            <span class="tag">${a.priority==='urgent'?'Urgent':'Notice'}</span><span class="scope-pill">${targetLabel(a)}</span>
            <h3>${esc(a.title)}</h3>
            <p>${esc(a.body)}</p>
            <div class="meta"><span>${esc(a.author_name)} · ${roleLabel(a.author_role)}</span><span class="mono">${timeAgo(a.created_at)}</span></div>
            ${canManageRow(a)?`<div style="margin-top:8px;text-align:right;"><button class="btn-danger" data-del-ann="${a.id}">Remove</button></div>`:''}
          </div>
        `).join('')}
      </div>`}
    </div>
  `;
}
function openAnnouncementModal(){
  showModal(`
    <h2>New announcement</h2>
    <form id="annForm">
      <div class="field"><label>Title</label><input type="text" name="title" required></div>
      <div class="field"><label>Details</label><textarea name="body" rows="4" required></textarea></div>
      ${audiencePickerHtml()}
      <div class="field">
        <label>Priority</label>
        <div class="radio-row">
          <label class="radio-opt selected" data-val="normal">Normal</label>
          <label class="radio-opt" data-val="urgent">Urgent</label>
        </div>
        <input type="hidden" name="priority" value="normal">
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-outline" id="cancelModal">Cancel</button>
        <button type="submit" class="btn btn-primary">Post</button>
      </div>
    </form>
  `);
  wireRadioRow('annForm');
  wireAudiencePicker('annForm');
  document.getElementById('annForm').addEventListener('submit', async e=>{
    e.preventDefault();
    const fd = new FormData(e.target);
    try{
      const data = await api('/announcements', {method:'POST', body:{
        title: fd.get('title').trim(), body: fd.get('body').trim(), priority: fd.get('priority'),
        target_department: fd.get('target_department') || undefined,
        target_year: fd.get('target_year') || undefined,
        target_section_id: fd.get('target_section_id') || undefined
      }});
      state.announcements.unshift(data.announcement);
      closeModal(); render();
    }catch(err){ alert(err.message); }
  });
}
function wireRadioRow(formId){
  const form = document.getElementById(formId);
  const opts = form.querySelectorAll('.radio-opt');
  const hidden = form.querySelector('input[type=hidden]');
  opts.forEach(o=>o.addEventListener('click', ()=>{
    opts.forEach(x=>x.classList.remove('selected')); o.classList.add('selected'); hidden.value = o.dataset.val;
  }));
}

/* ============ EVENTS (shared) ============ */
function viewEvents(){
  const canExport = ['college_admin','hod','faculty'].includes(state.session.role);
  const list = state.events;
  return `
    <div class="main-header">
      <div><h2>Events</h2><div class="sub">What's happening at your college</div></div>
      ${canPost()?`<button class="btn btn-gold" id="newEventBtn">+ New event</button>`:''}
    </div>
    ${list.length===0 ? emptyState('No events scheduled', 'Check back soon.') : list.map(ev=>{
      const badge = fmtDateBadge(ev.date);
      return `
        <div class="event-row">
          ${ev.has_poster ? `<img class="event-poster" src="/api/events/${ev.id}/poster" alt="${esc(ev.title)} poster">` : `<div class="date-badge"><div class="day">${badge.day}</div><div class="mon">${badge.mon}</div></div>`}
          <div class="event-info">
            ${ev.has_poster ? `<div class="event-date-chip mono">${badge.day} ${badge.mon}</div>` : ''}
            <h3>${esc(ev.title)} <span class="scope-pill">${targetLabel(ev)}</span></h3>
            <p>${esc(ev.description)}</p>
            <div class="event-meta-row"><span>🕒 ${esc(ev.time||'TBA')}</span><span>📍 ${esc(ev.venue||'TBA')}</span><span>${esc(ev.author_name)} · ${roleLabel(ev.author_role)}</span></div>
            <div class="event-actions">
              ${state.session.role==='student' ? (isPastDate(ev.date) ? `<span class="badge-muted">Event completed</span>` : `<button class="btn btn-small ${ev.rsvped?'btn-outline':'btn-gold'}" data-rsvp="${ev.id}">${ev.rsvped?'Cancel RSVP':"I'll attend"}</button>`) : ''}
              <span class="rsvp-count">${ev.rsvp_count} attending</span>
              ${canExport && ev.rsvp_count>0 ? `<a class="btn btn-outline btn-small" href="/api/events/${ev.id}/rsvps.csv" download>⬇ RSVP list (CSV)</a>` : ''}
              ${state.session.role==='student' && ev.rsvped && new Date(ev.date)<=new Date() ? `<a class="btn btn-outline btn-small" href="/api/events/${ev.id}/certificate" target="_blank">🎓 Certificate</a>` : ''}
              ${canManageRow(ev)?`<button class="btn-danger" data-del-event="${ev.id}">Remove</button>`:''}
            </div>
          </div>
        </div>
      `;
    }).join('')}
  `;
}
function openEventModal(){
  showModal(`
    <h2>New event</h2>
    <form id="eventForm">
      <div class="field"><label>Title</label><input type="text" name="title" required></div>
      <div class="field"><label>Description</label><textarea name="description" rows="3" required></textarea></div>
      <div class="field"><label>Date</label><input type="date" name="date" min="${new Date().toISOString().slice(0,10)}" required></div>
      <div class="field"><label>Time</label><input type="text" name="time" placeholder="e.g. 4:00 PM"></div>
      <div class="field"><label>Venue</label><input type="text" name="venue" placeholder="e.g. Main Auditorium"></div>
      ${audiencePickerHtml()}
      <div class="field"><label>Poster image (optional)</label><input type="file" name="poster" accept="image/png,image/jpeg,image/webp"></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-outline" id="cancelModal">Cancel</button>
        <button type="submit" class="btn btn-primary">Schedule event</button>
      </div>
    </form>
  `);
  wireAudiencePicker('eventForm');
  document.getElementById('eventForm').addEventListener('submit', async e=>{
    e.preventDefault();
    const fd = new FormData(e.target);
    if(fd.get('poster') && fd.get('poster').size===0) fd.delete('poster');
    try{
      const data = await apiUpload('/events', fd);
      state.events.push(data.event);
      state.events.sort((a,b)=>a.date.localeCompare(b.date));
      closeModal(); render();
    }catch(err){ alert(err.message); }
  });
}
async function toggleRsvp(eventId){
  try{
    const data = await api('/events/'+eventId+'/rsvp', {method:'POST'});
    const ev = state.events.find(e=>e.id===eventId);
    if(ev){ ev.rsvp_count = data.rsvp_count; ev.rsvped = data.rsvped; }
    render();
  }catch(err){ state.tabError = err.message; render(); }
}

/* ============ NOTES (shared) ============ */
const FILE_KIND_ICON = {pdf:'📕', image:'🖼️', office:'📄'};
function viewNotes(){
  const list = state.notes;
  return `
    <div class="main-header">
      <div><h2>Notes</h2><div class="sub">Study material — visible to whichever department/year/section the author picked</div></div>
      ${canPost()?`<button class="btn btn-gold" id="newNoteBtn">+ Share a note</button>`:''}
    </div>
    ${list.length===0 ? emptyState('No notes shared yet', 'Check back soon.') : `
    <div class="notes-grid">
      ${list.map(n=>`
        <div class="note-card">
          <span class="note-tab" style="background:${subjectColor(n.subject)}">${esc(n.subject)}</span>
          <h3>${esc(n.title)} <span class="scope-pill">${targetLabel(n)}</span></h3>
          <p>${esc(n.description)}</p>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            ${n.file_kind!=='office' ? `<button class="btn btn-outline btn-small" data-view-note="${n.id}" data-note-title="${esc(n.title)}" data-note-kind="${n.file_kind||'office'}">${FILE_KIND_ICON[n.file_kind]||'📄'} View</button>` : ''}
            ${n.allow_download ? `<a class="btn btn-outline btn-small" href="/api/notes/${n.id}/file" download="${esc(n.file_name)}">⬇ Download ${esc(n.file_name||'')}</a>` : (n.file_kind==='office' ? `<button class="btn btn-outline btn-small" data-view-note="${n.id}" data-note-title="${esc(n.title)}" data-note-kind="office">📄 View</button>` : '')}
          </div>
          <div class="meta" style="margin-top:10px;"><span>${esc(n.author_name)}</span><span class="mono">${timeAgo(n.created_at)}</span></div>
          <div style="margin-top:8px;display:flex;justify-content:space-between;align-items:center;">
            <button class="like-btn ${n.bookmarked?'liked':''}" data-toggle-bookmark="${n.id}">${n.bookmarked?'🔖 Bookmarked':'🔖 Bookmark'}</button>
            ${canManageRow(n)?`<button class="btn-danger" data-del-note="${n.id}">Remove</button>`:''}
          </div>
        </div>
      `).join('')}
    </div>`}
  `;
}
function openNoteModal(){
  showModal(`
    <h2>Share a note</h2>
    <form id="noteForm">
      <div class="field"><label>Subject / Course</label><input type="text" name="subject" required></div>
      <div class="field"><label>Title</label><input type="text" name="title" required></div>
      <div class="field"><label>Description</label><textarea name="description" rows="3" required></textarea></div>
      <div class="field"><label>File</label><input type="file" name="file" accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,image/jpeg,image/png,image/webp" required></div>
      ${audiencePickerHtml()}
      <label style="display:flex;align-items:center;gap:8px;font-size:13.5px;margin:10px 0;"><input type="checkbox" name="allow_download"> Allow students to download this file</label>
      <div class="hint">Students can always view PDFs/images in-app; checking this also gives them a direct download link.</div>
      <div class="modal-actions" style="margin-top:14px;">
        <button type="button" class="btn btn-outline" id="cancelModal">Cancel</button>
        <button type="submit" class="btn btn-primary" id="noteSubmitBtn">Upload &amp; share</button>
      </div>
    </form>
  `);
  wireAudiencePicker('noteForm');
  document.getElementById('noteForm').addEventListener('submit', async e=>{
    e.preventDefault();
    const fd = new FormData(e.target);
    fd.set('allow_download', document.querySelector('[name=allow_download]').checked ? 'true' : 'false');
    const btn = document.getElementById('noteSubmitBtn');
    btn.disabled = true; btn.textContent = 'Uploading…';
    try{
      const data = await apiUpload('/notes', fd);
      state.notes.unshift(data.note);
      closeModal(); render();
    }catch(err){
      alert(err.message); btn.disabled = false; btn.textContent = 'Upload & share';
    }
  });
}
async function openNoteFileViewer(noteId, title, fileKind){
  if(fileKind==='office'){
    showModal(`
      <h2 style="margin-bottom:4px;">${esc(title)}</h2>
      <p style="font-size:13.5px;color:var(--ink-light);line-height:1.6;">This is a Word, PowerPoint, Excel, or text file. In-app preview isn't available for this format yet — ask the uploader if you need its contents, or ask them to enable downloads for it.</p>
      <div class="modal-actions"><button type="button" class="btn btn-outline" id="cancelModal">Close</button></div>
    `);
    return;
  }
  showModal(`
    <h2 style="margin-bottom:4px;">${esc(title)}</h2>
    <p style="font-size:12.5px;color:var(--ink-light);margin:0 0 12px;">View only.</p>
    <div class="pdf-viewer-wrap" id="pdfViewerWrap" oncontextmenu="return false;"><div class="pdf-loading" id="pdfLoading">Loading…</div></div>
    <div class="pdf-pager" id="pdfPager" style="display:none;">
      <button type="button" class="btn btn-outline btn-small" id="pdfPrevBtn">◀ Prev</button>
      <span class="mono" id="pdfPageLabel">1 / 1</span>
      <button type="button" class="btn btn-outline btn-small" id="pdfNextBtn">Next ▶</button>
    </div>
  `);
  try{
    const res = await fetch('/api/notes/'+noteId+'/file', {credentials:'same-origin'});
    if(!res.ok) throw new Error('Could not load this file.');
    const wrap = document.getElementById('pdfViewerWrap');
    if(fileKind==='image'){
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const img = new Image(); img.onload=()=>URL.revokeObjectURL(url);
      img.src=url; img.alt=title; img.oncontextmenu=()=>false; img.draggable=false;
      wrap.innerHTML=''; wrap.appendChild(img);
      return;
    }
    if(!window.pdfjsLib){ document.getElementById('pdfLoading').textContent='PDF viewer failed to load.'; return; }
    const arrayBuffer = await res.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({data:arrayBuffer}).promise;
    wrap.innerHTML = '<canvas id="pdfCanvas" oncontextmenu="return false;"></canvas>';
    const canvas = document.getElementById('pdfCanvas'), ctx = canvas.getContext('2d');
    let currentPage=1; const totalPages=pdf.numPages;
    async function renderPage(num){
      const page = await pdf.getPage(num);
      const viewport = page.getViewport({scale:1.3});
      canvas.width=viewport.width; canvas.height=viewport.height;
      await page.render({canvasContext:ctx, viewport}).promise;
      document.getElementById('pdfPageLabel').textContent = num+' / '+totalPages;
    }
    await renderPage(currentPage);
    if(totalPages>1){
      document.getElementById('pdfPager').style.display='flex';
      document.getElementById('pdfPrevBtn').addEventListener('click', async ()=>{ if(currentPage>1){currentPage--; await renderPage(currentPage);} });
      document.getElementById('pdfNextBtn').addEventListener('click', async ()=>{ if(currentPage<totalPages){currentPage++; await renderPage(currentPage);} });
    }
  }catch(err){
    document.getElementById('pdfLoading').textContent = 'Could not load this file.';
  }
}

/* ============ PUBLIC BOARD ============ */
const POST_TYPE_LABEL = {complaint:'Complaint', opinion:'Opinion', lost_found:'Lost & Found'};
const BOARD_FILTERS = [{key:'all',label:'All'},{key:'complaint',label:'Complaints'},{key:'opinion',label:'Opinions'},{key:'lost_found',label:'Lost & Found'}];
function viewBoard(){
  state.boardFilter = state.boardFilter || 'all';
  const list = state.posts.filter(p=>state.boardFilter==='all'||p.type===state.boardFilter);
  const canBoardPost = ['hod','faculty','student'].includes(state.session.role);
  return `
    <div class="main-header">
      <div><h2>Public Board</h2><div class="sub">Complaints, opinions, lost &amp; found — visible to your whole college</div></div>
      ${canBoardPost?`<button class="btn btn-gold" id="newPostBtn">+ New post</button>`:''}
    </div>
    <div class="filter-row">${BOARD_FILTERS.map(f=>`<button class="filter-pill ${state.boardFilter===f.key?'active':''}" data-board-filter="${f.key}">${f.label}</button>`).join('')}</div>
    ${list.length===0 ? emptyState('Nothing here yet', 'Post a complaint, opinion, or a lost item.') : list.map(p=>`
      <div class="post-card" data-open-post="${p.id}">
        <div class="post-top"><span class="type-pill ${p.type}">${POST_TYPE_LABEL[p.type]}</span>${p.type==='lost_found'?`<span class="status-pill ${p.status}">${p.status==='open'?'Unresolved':'Resolved'}</span>`:''}</div>
        <h3>${esc(p.title)}</h3><p class="snippet">${esc(p.body)}</p>
        <div class="meta"><span>${esc(p.author_name)} · ${roleLabel(p.author_role)}${p.roll_number?` · <span class="roll-chip">${esc(p.roll_number)}</span>`:''}</span><span>${p.reply_count} ${p.reply_count===1?'reply':'replies'} · ${timeAgo(p.created_at)}</span></div>
      </div>
    `).join('')}
  `;
}
function openPostModal(){
  const showRoll = state.session.role==='student';
  showModal(`
    <h2>New board post</h2>
    <form id="postForm">
      <div class="field"><label>Type</label>
        <div class="radio-row">
          <label class="radio-opt selected" data-val="complaint">Complaint</label>
          <label class="radio-opt" data-val="opinion">Opinion</label>
          <label class="radio-opt" data-val="lost_found">Lost &amp; Found</label>
        </div>
        <input type="hidden" name="type" value="complaint">
      </div>
      <div class="field"><label>Title</label><input type="text" name="title" required></div>
      <div class="field"><label>Details</label><textarea name="body" rows="4" required></textarea></div>
      ${showRoll ? `<div class="hint">Posted with your roll number on file — visible only to faculty, HOD, and admins.</div>` : ''}
      <div class="modal-actions" style="margin-top:14px;">
        <button type="button" class="btn btn-outline" id="cancelModal">Cancel</button>
        <button type="submit" class="btn btn-primary">Post</button>
      </div>
    </form>
  `);
  wireRadioRow('postForm');
  document.getElementById('postForm').addEventListener('submit', async e=>{
    e.preventDefault();
    const fd = new FormData(e.target);
    try{
      const data = await api('/posts', {method:'POST', body:{ type:fd.get('type'), title:fd.get('title').trim(), body:fd.get('body').trim() }});
      state.posts.unshift(data.post);
      closeModal(); render();
    }catch(err){ alert(err.message); }
  });
}
async function openPostDetail(postId){
  let data;
  try{ data = await api('/posts/'+postId); }catch(err){ state.tabError = err.message; render(); return; }
  renderPostDetailModal(data.post, data.replies);
}
function renderPostDetailModal(post, replies){
  const canManageThis = ['hod','faculty'].includes(state.session.role) || post.author_username===state.session.username;
  showModal(`
    <div class="post-detail-header"><span class="type-pill ${post.type}">${POST_TYPE_LABEL[post.type]}</span>${post.type==='lost_found'?`<span class="status-pill ${post.status}">${post.status==='open'?'Unresolved':'Resolved'}</span>`:''}</div>
    <h2>${esc(post.title)}</h2>
    <div class="post-detail-meta"><span>${esc(post.author_name)} · ${roleLabel(post.author_role)}</span>${post.roll_number?`<span class="roll-chip">${esc(post.roll_number)}</span>`:''}<span class="mono">${timeAgo(post.created_at)}</span></div>
    <div class="post-detail-body">${esc(post.body)}</div>
    <div class="post-detail-actions">
      ${post.type==='lost_found' && canManageThis ? `<button class="btn btn-outline btn-small" id="toggleStatusBtn">${post.status==='open'?'Mark resolved':'Reopen'}</button>` : ''}
      ${canManageThis ? `<button class="btn-danger" id="deletePostBtn">Remove post</button>` : ''}
    </div>
    <div class="reply-list">
      <h4>${replies.length} ${replies.length===1?'Reply':'Replies'}</h4>
      ${replies.length===0 ? `<p style="font-size:13px;color:var(--ink-light);">No replies yet.</p>` : replies.map(r=>`
        <div class="reply-item"><p>${esc(r.body)}</p><div class="meta"><span>${esc(r.author_name)} · ${roleLabel(r.author_role)} · ${timeAgo(r.created_at)}</span>${(['hod','faculty'].includes(state.session.role)||r.author_username===state.session.username)?`<button class="btn-danger" data-del-reply="${r.id}" data-parent-post="${post.id}">Remove</button>`:''}</div></div>
      `).join('')}
      <form class="reply-form" id="replyForm"><textarea name="body" placeholder="Write a reply…" required></textarea><button type="submit" class="btn btn-gold btn-small">Reply</button></form>
    </div>
  `);
  const toggleBtn = document.getElementById('toggleStatusBtn');
  if(toggleBtn) toggleBtn.addEventListener('click', async ()=>{
    try{
      const data = await api('/posts/'+post.id+'/status', {method:'PATCH'});
      const idx = state.posts.findIndex(p=>p.id===post.id); if(idx>-1) state.posts[idx]=data.post;
      renderPostDetailModal(data.post, replies); renderTab();
    }catch(err){ alert(err.message); }
  });
  const deleteBtn = document.getElementById('deletePostBtn');
  if(deleteBtn) deleteBtn.addEventListener('click', async ()=>{
    try{ await api('/posts/'+post.id, {method:'DELETE'}); state.posts = state.posts.filter(p=>p.id!==post.id); closeModal(); render(); }
    catch(err){ alert(err.message); }
  });
  document.getElementById('replyForm').addEventListener('submit', async e=>{
    e.preventDefault();
    const fd = new FormData(e.target);
    try{
      await api('/posts/'+post.id+'/replies', {method:'POST', body:{ body: fd.get('body').trim() }});
      const fresh = await api('/posts/'+post.id);
      const idx = state.posts.findIndex(p=>p.id===post.id); if(idx>-1) state.posts[idx]=fresh.post;
      renderPostDetailModal(fresh.post, fresh.replies); renderTab();
    }catch(err){ alert(err.message); }
  });
  document.querySelectorAll('[data-del-reply]').forEach(b=>b.addEventListener('click', async ()=>{
    try{
      await api('/posts/'+b.dataset.parentPost+'/replies/'+b.dataset.delReply, {method:'DELETE'});
      const fresh = await api('/posts/'+b.dataset.parentPost);
      const idx = state.posts.findIndex(p=>p.id===b.dataset.parentPost); if(idx>-1) state.posts[idx]=fresh.post;
      renderPostDetailModal(fresh.post, fresh.replies); renderTab();
    }catch(err){ alert(err.message); }
  }));
}

/* ============ CLUBS (NEW) ============ */
function viewClubs(){
  const list = state.clubs;
  const canCreate = ['college_admin','hod'].includes(state.session.role);
  return `
    <div class="main-header">
      <div><h2>Clubs</h2><div class="sub">Join clubs, post updates, and browse the photo gallery</div></div>
      ${canCreate?`<button class="btn btn-gold" id="newClubBtn">+ New club</button>`:''}
    </div>
    ${list.length===0 ? emptyState('No clubs yet', canCreate?'Create the first club for your college.':'Check back soon.') : `
    <div class="club-grid">
      ${list.map(c=>`
        <div class="club-card" data-open-club="${c.id}">
          <span class="cat">${esc(c.category)}</span>
          <h3>${esc(c.name)}</h3>
          <p>${esc(c.description)}</p>
          <div class="club-meta">
            <span class="member-pill">👥 ${c.member_count} member${c.member_count===1?'':'s'}</span>
            <span>${c.is_member?'✅ Joined':''}</span>
          </div>
        </div>
      `).join('')}
    </div>`}
  `;
}
function openClubModal(){
  showModal(`
    <h2>New club</h2>
    <form id="clubForm">
      <div class="field"><label>Club name</label><input type="text" name="name" required></div>
      <div class="field"><label>Category</label><input type="text" name="category" placeholder="e.g. Coding, Dance, Sports, Photography"></div>
      <div class="field"><label>Description</label><textarea name="description" rows="3"></textarea></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-outline" id="cancelModal">Cancel</button>
        <button type="submit" class="btn btn-primary">Create club</button>
      </div>
    </form>
  `);
  document.getElementById('clubForm').addEventListener('submit', async e=>{
    e.preventDefault();
    const fd = new FormData(e.target);
    try{
      const data = await api('/clubs', {method:'POST', body:{
        name: fd.get('name').trim(), category: (fd.get('category')||'').trim(), description: (fd.get('description')||'').trim()
      }});
      state.clubs.unshift(data.club);
      closeModal(); render();
    }catch(err){ alert(err.message); }
  });
}
async function openClubDetail(clubId){
  try{
    const data = await api('/clubs/'+clubId);
    renderClubDetailModal(data.club, data.members, data.posts);
  }catch(err){ alert(err.message); }
}
function renderClubDetailModal(club, members, posts){
  showModal(`
    <h2>${esc(club.name)} <span class="scope-pill">${esc(club.category)}</span></h2>
    <p style="font-size:13.5px;color:var(--ink-light);margin:4px 0 16px;">${esc(club.description)}</p>
    <div style="display:flex;gap:10px;margin-bottom:16px;">
      ${club.is_member ? `<button class="btn btn-outline btn-small" id="leaveClubBtn">Leave club</button>` : `<button class="btn btn-gold btn-small" id="joinClubBtn">Join club</button>`}
      ${club.can_manage?`<button class="btn-danger" id="deleteClubBtn">Delete club</button>`:''}
    </div>

    <h4 style="margin:14px 0 6px;font-size:12.5px;text-transform:uppercase;letter-spacing:0.04em;color:var(--ink-light);">Members (${members.length})</h4>
    <div style="max-height:130px;overflow:auto;margin-bottom:16px;">
      ${members.length===0?`<p style="font-size:13px;color:var(--ink-light);">No members yet.</p>`:members.map(m=>`
        <div class="club-member-row"><span>${esc(m.name)}</span><span class="scope-pill">${roleLabel(m.role)}</span></div>
      `).join('')}
    </div>

    <h4 style="margin:14px 0 6px;font-size:12.5px;text-transform:uppercase;letter-spacing:0.04em;color:var(--ink-light);">Club updates</h4>
    <div style="max-height:150px;overflow:auto;margin-bottom:10px;">
      ${posts.length===0?`<p style="font-size:13px;color:var(--ink-light);">No updates yet.</p>`:posts.map(p=>`
        <div class="club-post-item"><p style="font-size:13.5px;margin:0;">${esc(p.body)}</p><div class="meta">${esc(p.author_name)} · ${timeAgo(p.created_at)}</div></div>
      `).join('')}
    </div>
    ${club.is_member||club.can_manage?`
    <form id="clubPostForm" style="display:flex;gap:8px;margin-bottom:18px;">
      <input type="text" name="body" placeholder="Post an update…" style="flex:1;" required>
      <button type="submit" class="btn btn-gold btn-small">Post</button>
    </form>`:''}

    <h4 style="margin:14px 0 6px;font-size:12.5px;text-transform:uppercase;letter-spacing:0.04em;color:var(--ink-light);">Gallery (${club.gallery_count})</h4>
    <div id="clubGalleryWrap">Loading…</div>
    ${club.is_member||club.can_manage?`
    <form id="clubGalleryForm" style="display:flex;gap:8px;margin-top:10px;align-items:center;flex-wrap:wrap;">
      <input type="file" name="image" accept="image/png,image/jpeg,image/webp" required>
      <input type="text" name="caption" placeholder="Caption (optional)" style="flex:1;min-width:120px;">
      <button type="submit" class="btn btn-outline btn-small">Add photo</button>
    </form>`:''}

    <div class="modal-actions"><button type="button" class="btn btn-outline" id="cancelModal">Close</button></div>
  `);
  loadClubGallery(club.id, club.can_manage);

  const joinBtn = document.getElementById('joinClubBtn');
  if(joinBtn) joinBtn.addEventListener('click', async ()=>{
    try{ await api('/clubs/'+club.id+'/join', {method:'POST'}); await refreshClubs(); await openClubDetail(club.id); render(); }
    catch(err){ alert(err.message); }
  });
  const leaveBtn = document.getElementById('leaveClubBtn');
  if(leaveBtn) leaveBtn.addEventListener('click', async ()=>{
    try{ await api('/clubs/'+club.id+'/leave', {method:'POST'}); await refreshClubs(); await openClubDetail(club.id); render(); }
    catch(err){ alert(err.message); }
  });
  const deleteBtn = document.getElementById('deleteClubBtn');
  if(deleteBtn) deleteBtn.addEventListener('click', async ()=>{
    if(!confirm(`Delete "${club.name}"? This can't be undone.`)) return;
    try{ await api('/clubs/'+club.id, {method:'DELETE'}); state.clubs = state.clubs.filter(c=>c.id!==club.id); closeModal(); render(); }
    catch(err){ alert(err.message); }
  });
  const postForm = document.getElementById('clubPostForm');
  if(postForm) postForm.addEventListener('submit', async e=>{
    e.preventDefault();
    const fd = new FormData(e.target);
    try{ await api('/clubs/'+club.id+'/posts', {method:'POST', body:{body:fd.get('body').trim()}}); await openClubDetail(club.id); }
    catch(err){ alert(err.message); }
  });
  const galleryForm = document.getElementById('clubGalleryForm');
  if(galleryForm) galleryForm.addEventListener('submit', async e=>{
    e.preventDefault();
    const fd = new FormData(e.target);
    try{ await apiUpload('/clubs/'+club.id+'/gallery', fd); await refreshClubs(); await openClubDetail(club.id); }
    catch(err){ alert(err.message); }
  });
}
async function loadClubGallery(clubId, canManage){
  const wrap = document.getElementById('clubGalleryWrap');
  try{
    const data = await api('/clubs/'+clubId+'/gallery');
    if(!wrap) return;
    wrap.innerHTML = data.images.length===0 ? `<p style="font-size:13px;color:var(--ink-light);">No photos yet.</p>` : `
      <div class="gallery-grid">
        ${data.images.map(img=>`
          <div class="gallery-thumb">
            <img src="/api/clubs/${clubId}/gallery/${img.id}/file" alt="${esc(img.caption)}">
            ${(canManage || img.uploaded_by===state.session.username) ? `<button class="gallery-del" data-del-gallery-img="${img.id}" data-gallery-club="${clubId}">✕</button>` : ''}
            ${img.caption?`<div class="cap">${esc(img.caption)}</div>`:''}
          </div>
        `).join('')}
      </div>`;
    wrap.querySelectorAll('[data-del-gallery-img]').forEach(b=>b.addEventListener('click', async ()=>{
      try{ await api('/clubs/'+b.dataset.galleryClub+'/gallery/'+b.dataset.delGalleryImg, {method:'DELETE'}); loadClubGallery(clubId); }
      catch(err){ alert(err.message); }
    }));
  }catch(err){ if(wrap) wrap.innerHTML = `<p style="font-size:13px;color:var(--crimson);">Could not load photos.</p>`; }
}

/* ============ DISCUSSION FORUM (NEW) ============ */
const FORUM_SUBJECTS = ['General','DBMS','Data Structures','Operating Systems','Networks','Placement Prep','Other'];
function viewForum(){
  const list = state.forumPosts;
  const canAsk = ['hod','faculty','student'].includes(state.session.role);
  return `
    <div class="main-header">
      <div><h2>Discussion Forum</h2><div class="sub">Ask questions, reply, and like the answers that help</div></div>
      ${canAsk?`<button class="btn btn-gold" id="newForumBtn">+ Ask a question</button>`:''}
    </div>
    <div class="forum-toolbar">
      <input type="text" id="forumSearchInput" placeholder="Search discussions…" value="${esc(state.forumSearch)}">
      <select id="forumSubjectSelect">
        <option value="">All subjects</option>
        ${FORUM_SUBJECTS.map(s=>`<option value="${s}" ${state.forumSubject===s?'selected':''}>${s}</option>`).join('')}
      </select>
    </div>
    ${list.length===0 ? emptyState('No discussions yet', 'Be the first to ask a question.') : list.map(p=>`
      <div class="forum-card" data-open-forum="${p.id}">
        <span class="subject-tag">${esc(p.subject)}</span>
        <h3>${esc(p.title)}</h3>
        <p>${esc(p.body.length>140 ? p.body.slice(0,140)+'…' : p.body)}</p>
        <div class="meta">
          <span>${esc(p.author_name)} · ${roleLabel(p.author_role)} · ${timeAgo(p.created_at)}</span>
          <span>❤ ${p.like_count} · 💬 ${p.reply_count}</span>
        </div>
      </div>
    `).join('')}
  `;
}
function openForumPostModal(){
  showModal(`
    <h2>Ask a question</h2>
    <form id="forumForm">
      <div class="field"><label>Subject</label>
        <select name="subject" required>${FORUM_SUBJECTS.map(s=>`<option value="${s}">${s}</option>`).join('')}</select>
      </div>
      <div class="field"><label>Title</label><input type="text" name="title" placeholder="e.g. How to prepare for GATE DBMS?" required></div>
      <div class="field"><label>Details</label><textarea name="body" rows="4" required></textarea></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-outline" id="cancelModal">Cancel</button>
        <button type="submit" class="btn btn-primary">Post question</button>
      </div>
    </form>
  `);
  document.getElementById('forumForm').addEventListener('submit', async e=>{
    e.preventDefault();
    const fd = new FormData(e.target);
    try{
      const data = await api('/forum', {method:'POST', body:{ subject: fd.get('subject'), title: fd.get('title').trim(), body: fd.get('body').trim() }});
      state.forumPosts.unshift(data.post);
      closeModal(); render();
    }catch(err){ alert(err.message); }
  });
}
async function openForumDetail(postId){
  try{
    const data = await api('/forum/'+postId);
    renderForumDetailModal(data.post, data.replies);
  }catch(err){ alert(err.message); }
}
function renderForumDetailModal(post, replies){
  const canManageThis = post.author_username===state.session.username || ['college_admin','hod'].includes(state.session.role);
  showModal(`
    <span class="subject-tag">${esc(post.subject)}</span>
    <h2 style="margin-top:8px;">${esc(post.title)}</h2>
    <div class="meta" style="margin-bottom:10px;"><span>${esc(post.author_name)} · ${roleLabel(post.author_role)} · ${timeAgo(post.created_at)}</span></div>
    <div class="forum-detail-body">${esc(post.body)}</div>
    <div style="display:flex;gap:10px;margin-bottom:16px;">
      <button class="like-btn ${post.liked?'liked':''}" id="likeForumBtn">❤ ${post.like_count}</button>
      ${canManageThis?`<button class="btn-danger" id="deleteForumBtn">Remove thread</button>`:''}
    </div>
    <h4 style="font-size:12.5px;text-transform:uppercase;letter-spacing:0.04em;color:var(--ink-light);">${replies.length} ${replies.length===1?'Reply':'Replies'}</h4>
    <div class="reply-list">
      ${replies.length===0?`<p style="font-size:13px;color:var(--ink-light);">No replies yet — be the first to help.</p>`:replies.map(r=>`
        <div class="reply-item">
          <p>${esc(r.body)}</p>
          <div class="meta">
            <span>${esc(r.author_name)} · ${roleLabel(r.author_role)} · ${timeAgo(r.created_at)}</span>
            <span style="display:flex;gap:8px;align-items:center;">
              <button class="like-btn ${r.liked?'liked':''}" data-like-reply="${r.id}">❤ ${r.like_count}</button>
              ${(r.author_username===state.session.username||['college_admin','hod'].includes(state.session.role))?`<button class="btn-danger" data-del-forum-reply="${r.id}">Remove</button>`:''}
            </span>
          </div>
        </div>
      `).join('')}
      ${['hod','faculty','student'].includes(state.session.role)?`<form class="reply-form" id="forumReplyForm"><textarea name="body" placeholder="Write a reply…" required></textarea><button type="submit" class="btn btn-gold btn-small">Reply</button></form>`:''}
    </div>
  `);
  document.getElementById('likeForumBtn').addEventListener('click', async ()=>{
    try{
      const data = await api('/forum/'+post.id+'/like', {method:'POST'});
      const idx = state.forumPosts.findIndex(p=>p.id===post.id); if(idx>-1){ state.forumPosts[idx].liked=data.liked; state.forumPosts[idx].like_count=data.like_count; }
      const fresh = await api('/forum/'+post.id);
      renderForumDetailModal(fresh.post, fresh.replies); renderTab();
    }catch(err){ alert(err.message); }
  });
  const delBtn = document.getElementById('deleteForumBtn');
  if(delBtn) delBtn.addEventListener('click', async ()=>{
    try{ await api('/forum/'+post.id, {method:'DELETE'}); state.forumPosts = state.forumPosts.filter(p=>p.id!==post.id); closeModal(); render(); }
    catch(err){ alert(err.message); }
  });
  const replyForm = document.getElementById('forumReplyForm');
  if(replyForm) replyForm.addEventListener('submit', async e=>{
    e.preventDefault();
    const fd = new FormData(e.target);
    try{
      await api('/forum/'+post.id+'/replies', {method:'POST', body:{ body: fd.get('body').trim() }});
      const fresh = await api('/forum/'+post.id);
      const idx = state.forumPosts.findIndex(p=>p.id===post.id); if(idx>-1) state.forumPosts[idx]=fresh.post;
      renderForumDetailModal(fresh.post, fresh.replies); renderTab();
    }catch(err){ alert(err.message); }
  });
  document.querySelectorAll('[data-like-reply]').forEach(b=>b.addEventListener('click', async ()=>{
    try{
      await api('/forum/replies/'+b.dataset.likeReply+'/like', {method:'POST'});
      const fresh = await api('/forum/'+post.id);
      renderForumDetailModal(fresh.post, fresh.replies);
    }catch(err){ alert(err.message); }
  }));
  document.querySelectorAll('[data-del-forum-reply]').forEach(b=>b.addEventListener('click', async ()=>{
    try{
      await api('/forum/replies/'+b.dataset.delForumReply, {method:'DELETE'});
      const fresh = await api('/forum/'+post.id);
      const idx = state.forumPosts.findIndex(p=>p.id===post.id); if(idx>-1) state.forumPosts[idx]=fresh.post;
      renderForumDetailModal(fresh.post, fresh.replies); renderTab();
    }catch(err){ alert(err.message); }
  }));
}

/* ============ LEADERBOARD (NEW) ============ */
function viewLeaderboard(){
  const lb = state.leaderboard;
  if(!lb) return emptyState('Leaderboard unavailable', 'Try again shortly.');
  return `
    <div class="main-header"><div><h2>Leaderboard</h2><div class="sub">Event participation + attendance + academics + club activity, combined into one score</div></div></div>

    ${lb.hall_of_fame.length? `
    <h4 style="font-size:12.5px;text-transform:uppercase;letter-spacing:0.04em;color:var(--ink-light);margin-bottom:8px;">🏛 Hall of Fame</h4>
    <div class="leaderboard-hof">
      ${lb.hall_of_fame.map(r=>`<div class="hof-card"><div class="rank">#${r.rank}</div><div class="name">${esc(r.name)}</div><div class="pts">${r.score} pts</div></div>`).join('')}
    </div>`:''}

    <div class="leaderboard-filter-bar">
      <div class="field">
        <label>Ranking scope</label>
        <select id="lbScopeSelect">
          <option value="college" ${lb.scope==='college'?'selected':''}>Overall Campus</option>
          <option value="department" ${lb.scope==='department'?'selected':''}>Department-wise</option>
          <option value="section" ${lb.scope==='section'?'selected':''}>Section-wise</option>
        </select>
      </div>
      ${lb.scope==='department'?`<div class="field"><label>Department</label><select id="lbValueSelect">${lb.departments.map(d=>`<option value="${esc(d)}" ${state.leaderboardValue===d?'selected':''}>${esc(d)}</option>`).join('')}</select></div>`:''}
      ${lb.scope==='section'?`<div class="field"><label>Section</label><select id="lbValueSelect">${lb.sections.map(s=>`<option value="${s.id}" ${state.leaderboardValue===s.id?'selected':''}>${esc(s.name)} (${esc(s.department)})</option>`).join('')}</select></div>`:''}
    </div>

    ${lb.leaderboard.length===0 ? emptyState('No students to rank yet', 'Scores appear once students are added.') : `
    <table>
      <thead><tr><th>Rank</th><th>Student</th><th>Badges</th><th>Score</th></tr></thead>
      <tbody>
        ${lb.leaderboard.map(r=>`
          <tr class="${r.rank<=3?'leaderboard-top':''} ${r.username===state.session.username?'leaderboard-row-me':''}">
            <td>#${r.rank}</td>
            <td>${esc(r.name)}${r.username===state.session.username?' (You)':''}</td>
            <td>${r.badges.map(b=>`<span class="badge-chip">${b.icon} ${b.label}</span>`).join('')||'—'}</td>
            <td><strong>${r.score}</strong></td>
          </tr>
        `).join('')}
      </tbody>
    </table>`}
  `;
}

/* ============ BOOKMARKS (NEW) ============ */
function viewBookmarks(){
  const list = state.notes.filter(n=>n.bookmarked);
  return `
    <div class="main-header"><div><h2>Bookmarks</h2><div class="sub">Study materials you've saved for later</div></div></div>
    ${list.length===0 ? emptyState('No bookmarks yet', 'Bookmark a note from the Notes tab to find it here.') : `
    <div class="notes-grid">
      ${list.map(n=>`
        <div class="note-card">
          <span class="note-tab" style="background:${subjectColor(n.subject)}">${esc(n.subject)}</span>
          <h3>${esc(n.title)}</h3>
          <p>${esc(n.description)}</p>
          ${n.allow_download
            ? `<a class="btn btn-outline btn-small" href="/api/notes/${n.id}/file" download="${esc(n.file_name)}">⬇ Download ${esc(n.file_name||'')}</a>`
            : `<button class="btn btn-outline btn-small" data-view-note="${n.id}" data-note-title="${esc(n.title)}" data-note-kind="${n.file_kind||'office'}">${FILE_KIND_ICON[n.file_kind]||'📄'} View ${esc(n.file_name||'file')}</button>`}
          <div style="margin-top:8px;"><button class="like-btn liked" data-toggle-bookmark="${n.id}">🔖 Remove bookmark</button></div>
        </div>
      `).join('')}
    </div>`}
  `;
}

/* ============ ANALYTICS / DASHBOARD CHARTS (NEW) ============ */
function viewAnalytics(){
  const role = state.session.role;
  if(!state.analytics) return emptyState('Analytics unavailable', 'Try again shortly.');
  if(role==='college_admin'){
    return `
      <div class="main-header"><div><h2>Analytics</h2><div class="sub">College-wide activity at a glance</div></div></div>
      <div class="chart-grid">
        <div class="chart-card"><h4>Student registrations (last 6 months)</h4><div class="chart-wrap"><canvas id="chartRegistrations"></canvas></div></div>
        <div class="chart-card"><h4>Events created (last 6 months)</h4><div class="chart-wrap"><canvas id="chartEvents"></canvas></div></div>
        <div class="chart-card"><h4>Public board status</h4><div class="chart-wrap"><canvas id="chartPostStatus"></canvas></div></div>
        <div class="chart-card"><h4>Department-wise event participation</h4><div class="chart-wrap"><canvas id="chartDeptParticipation"></canvas></div></div>
      </div>
    `;
  }
  if(role==='hod'){
    return `
      <div class="main-header"><div><h2>Analytics</h2><div class="sub">Your department at a glance</div></div></div>
      <div class="chart-grid">
        <div class="chart-card"><h4>Students per section</h4><div class="chart-wrap"><canvas id="chartStudentsBySection"></canvas></div></div>
        <div class="chart-card"><h4>Attendance % per section</h4><div class="chart-wrap"><canvas id="chartAttendanceBySection"></canvas></div></div>
        <div class="chart-card"><h4>Average marks % per section</h4><div class="chart-wrap"><canvas id="chartMarksBySection"></canvas></div></div>
      </div>
    `;
  }
  return emptyState('Not available', '');
}
function mountCharts(){
  if(!window.Chart || !state.analytics) return;
  const a = state.analytics;
  const mk = (id, type, labels, data, color) => {
    const el = document.getElementById(id);
    if(!el) return;
    new Chart(el, {
      type, data:{ labels, datasets:[{ data, backgroundColor: color||'rgba(47,158,91,0.65)', borderColor:'#1f6b3a', borderWidth:1.5, tension:0.35 }] },
      options:{ plugins:{legend:{display:false}}, responsive:true, maintainAspectRatio:false, scales: type==='doughnut'?{}:{ y:{ beginAtZero:true } } }
    });
  };
  if(state.tab==='reports' && state.session.role==='super_admin'){
    mk('chartSuperRegistrations','line', a.registrations_by_month.map(x=>x.label), a.registrations_by_month.map(x=>x.count));
    mk('chartSuperCollegeStatus','doughnut', a.colleges_by_status.map(x=>x.label), a.colleges_by_status.map(x=>x.count), ['#2f9e5b','#c0304f']);
    mk('chartSuperUsersByRole','bar', a.users_by_role.map(x=>x.label), a.users_by_role.map(x=>x.count));
  }
  if(state.tab==='analytics' && state.session.role==='college_admin'){
    mk('chartRegistrations','line', a.registrations_by_month.map(x=>x.label), a.registrations_by_month.map(x=>x.count));
    mk('chartEvents','bar', a.events_by_month.map(x=>x.label), a.events_by_month.map(x=>x.count));
    mk('chartPostStatus','doughnut', a.post_status.map(x=>x.label), a.post_status.map(x=>x.count), ['#f5a623','#2f9e5b']);
    mk('chartDeptParticipation','bar', a.department_participation.map(x=>x.label), a.department_participation.map(x=>x.count));
  }
  if(state.tab==='analytics' && state.session.role==='hod'){
    mk('chartStudentsBySection','bar', a.students_by_section.map(x=>x.label), a.students_by_section.map(x=>x.count));
    mk('chartAttendanceBySection','bar', a.attendance_by_section.map(x=>x.label), a.attendance_by_section.map(x=>x.count), 'rgba(47,158,91,0.65)');
    mk('chartMarksBySection','bar', a.marks_by_section.map(x=>x.label), a.marks_by_section.map(x=>x.count), 'rgba(245,166,35,0.65)');
  }
}

/* ============ ONLINE TESTS (NEW) ============ */
function viewTests(){
  return state.session.role==='faculty' ? viewFacultyTests() : viewStudentTests();
}

// ---------- Faculty: create + manage ----------
function viewFacultyTests(){
  const list = state.facultyTests||[];
  return `
    <div class="main-header">
      <div><h2>Tests</h2><div class="sub">Write a multiple-choice test for your section — it's auto-graded the moment a student submits</div></div>
      <button class="btn btn-gold" id="newTestBtn">+ Create test</button>
    </div>
    ${list.length===0 ? emptyState('No tests yet', 'Create your first test for a section you teach.') : `
    <table>
      <thead><tr><th>Title</th><th>Section</th><th>Questions</th><th>Status</th><th>Submissions</th><th></th></tr></thead>
      <tbody>
        ${list.map(t=>{
          const sec = (state.mySections||[]).find(s=>s.id===t.section_id);
          return `<tr>
            <td>${esc(t.title)}<div class="mono" style="font-size:11px;color:var(--ink-light);">${esc(t.subject)}</div></td>
            <td>${sec?esc(sec.name):'—'}</td>
            <td>${t.question_count}</td>
            <td><span class="scope-pill">${t.status}</span></td>
            <td>${t.submission_count}</td>
            <td><div style="display:flex;gap:8px;"><button class="btn btn-outline btn-small" data-view-test-results="${t.id}">${t.pending_grading_count>0?`Grade (${t.pending_grading_count})`:'Results'}</button><button class="btn-danger" data-del-test="${t.id}">Delete</button></div></td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`}
  `;
}
let testBuilderQuestions = [];
function openTestModal(){
  if(!state.mySections || !state.mySections.length){ alert('You need to be assigned to a section before you can create a test.'); return; }
  testBuilderQuestions = [{ type:'mcq', text:'', options:['',''], correct_index:0, marks:1 }];
  showModal(`
    <h2>Create test</h2>
    <form id="testForm">
      <div class="field"><label>Section</label>
        <select name="section_id" required>${state.mySections.map(s=>`<option value="${s.id}">${esc(s.name)} (${esc(s.department)})</option>`).join('')}</select>
      </div>
      <div class="field"><label>Title</label><input type="text" name="title" required></div>
      <div class="field"><label>Subject</label><input type="text" name="subject" placeholder="e.g. DBMS"></div>
      <div class="field"><label>Duration (minutes)</label><input type="number" name="duration_minutes" value="20" min="1" required></div>
      <div class="field"><label>Opens at (optional)</label><input type="datetime-local" name="start_time"></div>
      <div class="field"><label>Closes at (optional)</label><input type="datetime-local" name="end_time"></div>

      <h4 style="margin:16px 0 8px;font-size:12.5px;text-transform:uppercase;letter-spacing:0.04em;color:var(--ink-light);">Questions</h4>
      <div id="testQuestionsWrap"></div>
      <button type="button" class="btn btn-outline btn-small" id="addQuestionBtn" style="margin-top:2px;">+ Add question</button>

      <div class="modal-actions" style="margin-top:18px;">
        <button type="button" class="btn btn-outline" id="cancelModal">Cancel</button>
        <button type="submit" class="btn btn-primary">Publish test</button>
      </div>
    </form>
  `);
  renderTestQuestionsWrap();
  document.getElementById('addQuestionBtn').addEventListener('click', ()=>{
    testBuilderQuestions.push({ type:'mcq', text:'', options:['',''], correct_index:0, marks:1 });
    renderTestQuestionsWrap();
  });
  document.getElementById('testForm').addEventListener('submit', async e=>{
    e.preventDefault();
    if(testBuilderQuestions.some(q=>!q.text.trim() || (q.type==='mcq' && q.options.some(o=>!o.trim())))){
      alert('Fill in every question — and every option for multiple-choice questions — before publishing.'); return;
    }
    const fd = new FormData(e.target);
    try{
      const payload = {
        section_id: fd.get('section_id'), title: fd.get('title').trim(), subject: (fd.get('subject')||'').trim(),
        duration_minutes: Number(fd.get('duration_minutes'))||20,
        start_time: fd.get('start_time') ? new Date(fd.get('start_time')).toISOString() : null,
        end_time: fd.get('end_time') ? new Date(fd.get('end_time')).toISOString() : null,
        questions: testBuilderQuestions.map(q=> q.type==='theory'
          ? { type:'theory', text:q.text.trim(), marks:q.marks }
          : { type:'mcq', text:q.text.trim(), options:q.options.map(o=>o.trim()), correct_index:q.correct_index, marks:q.marks }
        )
      };
      const data = await api('/faculty/tests', {method:'POST', body:payload});
      state.facultyTests.unshift(data.test);
      closeModal(); render();
    }catch(err){ alert(err.message); }
  });
}
function renderTestQuestionsWrap(){
  const wrap = document.getElementById('testQuestionsWrap');
  if(!wrap) return;
  wrap.innerHTML = testBuilderQuestions.map((q,qi)=>`
    <div class="test-q-block">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
        <strong style="font-size:13px;">Question ${qi+1}</strong>
        <div style="display:flex;gap:8px;align-items:center;">
          <select data-q-type="${qi}">
            <option value="mcq" ${q.type!=='theory'?'selected':''}>Multiple choice</option>
            <option value="theory" ${q.type==='theory'?'selected':''}>Theory / long answer</option>
          </select>
          ${testBuilderQuestions.length>1?`<button type="button" class="btn-danger" data-remove-q="${qi}">Remove</button>`:''}
        </div>
      </div>
      <div class="field" style="margin:8px 0;"><input type="text" placeholder="Question text" data-q-text="${qi}" value="${esc(q.text)}"></div>
      ${q.type==='theory' ? `
        <p style="font-size:12.5px;color:var(--ink-light);margin:4px 0 8px;">The student will type a free-text answer. You'll grade it yourself after they submit.</p>
      ` : `
        ${q.options.map((opt,oi)=>`
          <div class="test-opt-row">
            <input type="radio" name="correct-${qi}" data-q-correct="${qi}:${oi}" ${q.correct_index===oi?'checked':''}>
            <input type="text" placeholder="Option ${oi+1}" data-q-opt="${qi}:${oi}" value="${esc(opt)}">
            ${q.options.length>2?`<button type="button" class="btn-danger" data-remove-opt="${qi}:${oi}">✕</button>`:''}
          </div>
        `).join('')}
        <button type="button" class="btn btn-outline btn-small" data-add-opt="${qi}" style="margin-top:4px;">+ Option</button>
      `}
      <div style="margin-top:8px;">
        <label style="font-size:12.5px;margin:0;display:inline-flex;align-items:center;gap:6px;">Marks <input type="number" min="1" value="${q.marks}" data-q-marks="${qi}" style="width:60px;"></label>
      </div>
    </div>
  `).join('');
  wrap.querySelectorAll('[data-q-type]').forEach(sel=>sel.addEventListener('change', ()=>{
    const qi = +sel.dataset.qType;
    testBuilderQuestions[qi].type = sel.value;
    if(sel.value==='mcq' && (!testBuilderQuestions[qi].options || testBuilderQuestions[qi].options.length<2)) testBuilderQuestions[qi].options = ['',''];
    renderTestQuestionsWrap();
  }));
  wrap.querySelectorAll('[data-q-text]').forEach(inp=>inp.addEventListener('input', ()=>{ testBuilderQuestions[+inp.dataset.qText].text = inp.value; }));
  wrap.querySelectorAll('[data-q-marks]').forEach(inp=>inp.addEventListener('input', ()=>{ testBuilderQuestions[+inp.dataset.qMarks].marks = Number(inp.value)||1; }));
  wrap.querySelectorAll('[data-q-opt]').forEach(inp=>inp.addEventListener('input', ()=>{ const [qi,oi]=inp.dataset.qOpt.split(':').map(Number); testBuilderQuestions[qi].options[oi]=inp.value; }));
  wrap.querySelectorAll('[data-q-correct]').forEach(inp=>inp.addEventListener('change', ()=>{ const [qi,oi]=inp.dataset.qCorrect.split(':').map(Number); testBuilderQuestions[qi].correct_index=oi; }));
  wrap.querySelectorAll('[data-remove-q]').forEach(b=>b.addEventListener('click', ()=>{ testBuilderQuestions.splice(+b.dataset.removeQ,1); renderTestQuestionsWrap(); }));
  wrap.querySelectorAll('[data-add-opt]').forEach(b=>b.addEventListener('click', ()=>{ testBuilderQuestions[+b.dataset.addOpt].options.push(''); renderTestQuestionsWrap(); }));
  wrap.querySelectorAll('[data-remove-opt]').forEach(b=>b.addEventListener('click', ()=>{
    const [qi,oi]=b.dataset.removeOpt.split(':').map(Number);
    const q = testBuilderQuestions[qi];
    if(q.options.length<=2) return;
    q.options.splice(oi,1);
    if(q.correct_index===oi) q.correct_index=0; else if(q.correct_index>oi) q.correct_index--;
    renderTestQuestionsWrap();
  }));
}
async function openTestResults(testId){
  try{
    const data = await api('/faculty/tests/'+testId);
    renderTestResultsModal(data.test, data.submissions);
  }catch(err){ alert(err.message); }
}
function renderTestResultsModal(test, submissions){
  showModal(`
    <h2>${esc(test.title)} — Results</h2>
    <p style="font-size:13px;color:var(--ink-light);margin-bottom:14px;">${submissions.length} submission${submissions.length===1?'':'s'} · Total marks: ${test.total_marks}</p>
    <div style="max-height:340px;overflow:auto;margin-bottom:14px;">
      ${submissions.length===0 ? `<p style="font-size:13px;color:var(--ink-light);">No one has attempted this test yet.</p>` : `
      <table><thead><tr><th>Student</th><th>Score</th><th>Status</th><th></th></tr></thead><tbody>
        ${submissions.map(s=>`<tr>
          <td>${esc(s.student_name)}</td>
          <td>${s.score} / ${test.total_marks}</td>
          <td>${s.fully_graded?'<span class="scope-pill">Graded</span>':'<span class="scope-pill" style="color:var(--gold-deep);">Pending</span>'}</td>
          <td><button class="btn btn-outline btn-small" data-view-submission="${s.id}">${s.fully_graded?'View':'Grade'}</button></td>
        </tr>`).join('')}
      </tbody></table>`}
    </div>
    ${submissions.length>0?`<a class="btn btn-outline btn-small" href="/api/faculty/tests/${test.id}/results.csv" download>⬇ Export CSV</a>`:''}
    <div class="modal-actions"><button type="button" class="btn btn-outline" id="cancelModal">Close</button></div>
  `);
  document.querySelectorAll('[data-view-submission]').forEach(b=>b.addEventListener('click', ()=>{
    const sub = submissions.find(s=>s.id===b.dataset.viewSubmission);
    renderSubmissionGradeModal(test, sub);
  }));
}
function renderSubmissionGradeModal(test, sub){
  showModal(`
    <h2>${esc(sub.student_name)}'s answers</h2>
    <p style="font-size:13.5px;color:var(--ink-light);margin-bottom:14px;">Score: <strong>${sub.score}</strong> / ${test.total_marks}</p>
    <form id="gradeForm">
      ${sub.answers.map((a,i)=>{
        const q = test.questions.find(qq=>qq.id===a.question_id) || {};
        if(a.type==='mcq'){
          return `<div class="test-q-block">
            <strong style="font-size:13.5px;">${i+1}. ${esc(q.text||'')}</strong>
            ${(q.options||[]).map((opt,oi)=>{
              const isCorrect = oi===q.correct_index;
              const isMine = a.selected_index===oi;
              const style = isCorrect ? 'color:var(--purple);font-weight:700;' : (isMine ? 'color:var(--crimson);' : '');
              return `<div class="test-opt-row" style="${style}">${isCorrect?'✔ ':(isMine?'✘ ':'')}${esc(opt)}</div>`;
            }).join('')}
            <div class="meta" style="margin-top:6px;">${a.correct?'Correct':'Incorrect'} · ${a.score} / ${q.marks||a.max_marks} marks</div>
          </div>`;
        }
        return `<div class="test-q-block">
          <strong style="font-size:13.5px;">${i+1}. ${esc(q.text||'')}</strong>
          <p style="font-size:13.5px;white-space:pre-wrap;background:var(--paper-card);border:1px solid var(--line);border-radius:8px;padding:10px;margin:8px 0;">${a.answer_text?esc(a.answer_text):'<em style="color:var(--ink-light);">No answer given.</em>'}</p>
          <label style="font-size:12.5px;display:inline-flex;align-items:center;gap:8px;">Score (out of ${q.marks||a.max_marks})
            <input type="number" min="0" max="${q.marks||a.max_marks}" value="${a.score===null||a.score===undefined?'':a.score}" data-theory-score="${a.question_id}" style="width:70px;">
          </label>
        </div>`;
      }).join('')}
      <div class="modal-actions">
        <button type="button" class="btn btn-outline" id="cancelModal">Close</button>
        ${sub.answers.some(a=>a.type==='theory')?`<button type="submit" class="btn btn-primary">Save grades</button>`:''}
      </div>
    </form>
  `);
  const form = document.getElementById('gradeForm');
  if(form) form.addEventListener('submit', async e=>{
    e.preventDefault();
    const scores = {};
    document.querySelectorAll('[data-theory-score]').forEach(inp=>{ if(inp.value!=='') scores[inp.dataset.theoryScore] = Number(inp.value); });
    try{
      await api('/faculty/tests/'+test.id+'/submissions/'+sub.id+'/grade', {method:'POST', body:{scores}});
      const t = state.facultyTests.find(x=>x.id===test.id);
      if(t){ const fresh = await api('/faculty/tests/'+test.id); t.submission_count = fresh.submissions.length; t.pending_grading_count = fresh.submissions.filter(s=>!s.fully_graded).length; }
      alert('Grades saved.'); closeModal(); render();
    }catch(err){ alert(err.message); }
  });
}

// ---------- Student: browse + attempt ----------
function viewStudentTests(){
  const list = state.studentTests||[];
  return `
    <div class="main-header"><div><h2>My Tests</h2><div class="sub">Tests your faculty have assigned to your section</div></div></div>
    ${list.length===0 ? emptyState('No tests assigned yet', 'Your faculty will publish tests here.') : `
    <div class="notes-grid">
      ${list.map(t=>`
        <div class="note-card">
          <span class="note-tab" style="background:${subjectColor(t.subject)}">${esc(t.subject)}</span>
          <h3>${esc(t.title)}</h3>
          <p>${t.question_count} question${t.question_count===1?'':'s'} · ${t.total_marks} marks · ${t.duration_minutes} min</p>
          <div class="meta" style="margin:8px 0;"><span>By ${esc(t.created_by_name)}</span><span class="scope-pill">${t.status}</span></div>
          ${t.submitted
            ? `<button class="btn btn-outline btn-small" data-review-test="${t.id}">View result — ${t.score}/${t.total_marks}${t.fully_graded?'':' (pending grading)'}</button>`
            : t.status==='open'
              ? `<button class="btn btn-gold btn-small" data-attempt-test="${t.id}">Start test</button>`
              : `<button class="btn btn-outline btn-small" disabled>${t.status==='upcoming'?'Not open yet':'Closed'}</button>`}
        </div>
      `).join('')}
    </div>`}
  `;
}
/* ============ FULL-PAGE VIEW HELPERS (used by the test-attempt module) ============ */
function showFullPage(html){
  const el = document.getElementById('testFullPage');
  el.innerHTML = html;
  el.style.display = 'block';
}
function closeFullPage(){
  const el = document.getElementById('testFullPage');
  el.style.display = 'none';
  el.innerHTML = '';
}

let testAttemptState = null;
async function openTestAttempt(testId){
  try{
    const data = await api('/student/tests/'+testId);
    if(data.submission){ exitFullscreenSafe(); renderTestReview(data.test, data.submission); return; }
    testAttemptState = { testId, questions: data.test.questions, answers: new Array(data.test.questions.length).fill(null), secondsLeft: data.test.duration_minutes*60, submitting:false };
    renderTestAttemptModal(data.test);
    startTestTimer();
  }catch(err){ exitFullscreenSafe(); alert(err.message); }
}
function renderTestAttemptModal(test){
  // UPDATED: taking a test now opens as a dedicated full page, not a small modal dialog.
  showFullPage(`
    <div class="test-fullpage-inner">
      <div class="test-fullpage-header">
        <h2>${esc(test.title)}</h2>
        <div style="display:flex;align-items:center;gap:14px;">
          <button type="button" class="btn btn-outline btn-small" id="testFullscreenToggle">⛶ Fullscreen</button>
          <span class="scope-pill">${test.total_marks} marks</span>
          <span class="mono" id="testTimer" style="font-weight:700;font-size:16px;"></span>
        </div>
      </div>
      <p style="font-size:12px;color:var(--ink-light);margin:0 0 14px;">ℹ Fullscreen is optional — you can take this test in fullscreen or in your normal browser window. Switching between them never affects your test, your answers, or your timer, and nothing submits the test except clicking "Submit test" below.</p>
      <p id="testTimeExpiredNotice" style="display:none;font-size:12.5px;font-weight:700;color:var(--crimson);background:rgba(220,38,38,0.08);border:1px solid rgba(220,38,38,0.25);border-radius:8px;padding:8px 12px;margin:0 0 14px;">⏰ Time Expired — Please Submit Your Exam</p>
      <form id="testAttemptForm">
        ${testAttemptState.questions.map((q,qi)=>`
          <div class="test-q-block">
            <strong style="font-size:13.5px;">${qi+1}. ${esc(q.text)} <span class="scope-pill">${q.marks} mark${q.marks===1?'':'s'}</span></strong>
            ${q.type==='theory'
              ? `<textarea data-attempt-theory="${qi}" rows="4" placeholder="Type your answer…" style="width:100%;margin-top:8px;padding:8px;border-radius:8px;border:1.5px solid var(--line);font-family:inherit;font-size:13.5px;"></textarea>`
              : q.options.map((opt,oi)=>`
                <label class="test-opt-row" style="cursor:pointer;">
                  <input type="radio" name="ans-${qi}" data-attempt-ans="${qi}:${oi}"> <span>${esc(opt)}</span>
                </label>
              `).join('')}
          </div>
        `).join('')}
        <div class="modal-actions" style="margin-top:16px;">
          <button type="submit" class="btn btn-primary" style="flex:1;">Submit test</button>
        </div>
      </form>
    </div>
  `);
  const fsToggle = document.getElementById('testFullscreenToggle');
  if(fsToggle) fsToggle.addEventListener('click', toggleFullscreenSafe);
  document.querySelectorAll('[data-attempt-ans]').forEach(inp=>inp.addEventListener('change', ()=>{
    const [qi,oi] = inp.dataset.attemptAns.split(':').map(Number);
    testAttemptState.answers[qi] = oi;
  }));
  document.querySelectorAll('[data-attempt-theory]').forEach(ta=>ta.addEventListener('input', ()=>{
    testAttemptState.answers[+ta.dataset.attemptTheory] = ta.value;
  }));
  document.getElementById('testAttemptForm').addEventListener('submit', async e=>{ e.preventDefault(); await submitTestAttempt(); });
}
function startTestTimer(){
  updateTestTimerDisplay();
  clearInterval(testAttemptState.timerInterval);
  testAttemptState.timerInterval = setInterval(()=>{
    if(!testAttemptState) return;
    // IMPORTANT: NO AUTOMATIC EXAM SUBMISSION — the timer reaching 00:00
    // never submits, exits, or locks the exam on its own. It just stops
    // counting and shows "Time Expired – Please Submit Your Exam"; the
    // student must click Submit test themselves.
    if(testAttemptState.secondsLeft<=0){
      clearInterval(testAttemptState.timerInterval);
      updateTestTimerDisplay();
      const notice = document.getElementById('testTimeExpiredNotice');
      if(notice) notice.style.display = 'block';
      return;
    }
    testAttemptState.secondsLeft--;
    updateTestTimerDisplay();
  }, 1000);
}
function updateTestTimerDisplay(){
  const el = document.getElementById('testTimer');
  if(!el || !testAttemptState) return;
  const m = Math.max(0,Math.floor(testAttemptState.secondsLeft/60));
  const s = Math.max(0,testAttemptState.secondsLeft%60);
  el.textContent = `⏱ ${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}
// Submit is ONLY ever called from the student's own "Submit test" click
// (see the form submit handler above). There is no other caller anywhere
// in this file — no fullscreen listener, no timer, no visibility/blur
// listener — so there is no automatic/forced submission path.
async function submitTestAttempt(){
  if(!testAttemptState || testAttemptState.submitting) return;
  const { questions, answers, testId } = testAttemptState;
  if(answers.some(a=>a===null || a===undefined || a==='')){
    if(!confirm('Some questions are unanswered. Submit anyway?')) return;
  }
  testAttemptState.submitting = true;
  clearInterval(testAttemptState.timerInterval);
  const payload = questions.map((q,i)=>{
    const a = answers[i];
    return q.type==='theory' ? { text: a==null?'':String(a) } : { selected_index: (a===null||a===undefined)?-1:a };
  });
  try{
    const data = await api('/student/tests/'+testId+'/submit', {method:'POST', body:{ answers: payload }});
    const t = state.studentTests.find(x=>x.id===testId);
    if(t){ t.submitted = true; t.score = data.submission.score; t.fully_graded = data.submission.fully_graded; }
    testAttemptState = null;
    exitFullscreenSafe();
    closeFullPage(); render();
    const gradingNote = data.submission.fully_graded ? '' : ' Theory answers are pending your faculty\u2019s review.';
    alert(`Test submitted! Auto-graded score: ${data.submission.score} / ${data.total_marks}.${gradingNote}`);
  }catch(err){
    testAttemptState.submitting = false;
    alert(err.message);
  }
}
function renderTestReview(test, submission){
  showModal(`
    <h2>${esc(test.title)} — Review</h2>
    <p style="font-size:13.5px;color:var(--ink-light);margin-bottom:14px;">Score: <strong>${submission.score} / ${test.total_marks}</strong>${submission.fully_graded?'':' <span style="color:var(--gold-deep);">(theory answers pending review)</span>'}</p>
    ${test.questions.map((q,qi)=>{
      const mine = submission.answers[qi];
      if(q.type==='theory'){
        return `<div class="test-q-block">
          <strong style="font-size:13.5px;">${qi+1}. ${esc(q.text)}</strong>
          <p style="font-size:13.5px;white-space:pre-wrap;background:var(--paper);border:1px solid var(--line);border-radius:8px;padding:10px;margin:8px 0;">${mine&&mine.answer_text?esc(mine.answer_text):'<em style="color:var(--ink-light);">No answer given.</em>'}</p>
          <div class="meta">${mine&&mine.score!==null&&mine.score!==undefined ? `${mine.score} / ${q.marks} marks` : 'Pending faculty review'}</div>
        </div>`;
      }
      return `<div class="test-q-block">
        <strong style="font-size:13.5px;">${qi+1}. ${esc(q.text)}</strong>
        ${q.options.map((opt,oi)=>{
          const isCorrect = oi===q.correct_index;
          const isMine = mine && mine.selected_index===oi;
          let style = '';
          if(isCorrect) style = 'color:var(--purple);font-weight:700;';
          else if(isMine) style = 'color:var(--crimson);';
          return `<div class="test-opt-row" style="${style}">${isCorrect?'✔ ':(isMine?'✘ ':'')}${esc(opt)}</div>`;
        }).join('')}
      </div>`;
    }).join('')}
    <div class="modal-actions"><button type="button" class="btn btn-outline" id="cancelModal">Close</button></div>
  `);
}

/* ============ EVENT DELEGATION ============ */
function attachTabHandlers(){
  const el = document.getElementById('mainContent');

  const bind = (id, fn) => { const b=document.getElementById(id); if(b) b.addEventListener('click', fn); };
  bind('newCollegeBtn', openCollegeModal);
  bind('newHodBtn', openHodModal);
  bind('newSectionBtn', openSectionModal);
  bind('newFacultyBtn', openFacultyModal);
  bind('newStudentBtn', openStudentModal);
  bind('newAnnouncementBtn', openAnnouncementModal);
  bind('newEventBtn', openEventModal);
  bind('newNoteBtn', openNoteModal);
  bind('newPostBtn', openPostModal);
  bind('newMarksBtn', openMarksModal);
  bind('newClubBtn', openClubModal);
  bind('newForumBtn', openForumPostModal);
  bind('newTestBtn', openTestModal);

  const attSetup = document.getElementById('attendanceSetupForm');
  if(attSetup){
    attSetup.addEventListener('submit', e=>{
      e.preventDefault();
      const fd = new FormData(e.target);
      loadAttendanceSheet(fd.get('section_id'), fd.get('date'), fd.get('hour'));
    });
    // auto-load first section on first render
    const firstSection = state.mySections[0];
    if(firstSection) loadAttendanceSheet(firstSection.id, new Date().toISOString().slice(0,10), 1);
  }
  const marksSelect = document.getElementById('marksSectionSelect');
  if(marksSelect){
    marksSelect.addEventListener('change', ()=>loadMarksList(marksSelect.value));
    if(state.mySections[0]) loadMarksList(state.mySections[0].id);
  }
  el.querySelectorAll('[data-del-marks]').forEach(b=>b.addEventListener('click', async ()=>{
    try{ await api('/faculty/marks/'+b.dataset.delMarks, {method:'DELETE'}); loadMarksList(document.getElementById('marksSectionSelect').value); }
    catch(err){ alert(err.message); }
  }));

  el.querySelectorAll('[data-toggle-college]').forEach(b=>b.addEventListener('click', async ()=>{
    const next = b.dataset.currentStatus==='active' ? 'disabled' : 'active';
    try{
      await api('/super/colleges/'+b.dataset.toggleCollege+'/status', {method:'PATCH', body:{status:next}});
      await refreshColleges(); render();
    }catch(err){ alert(err.message); }
  }));
  el.querySelectorAll('[data-del-college]').forEach(b=>b.addEventListener('click', async ()=>{
    if(!confirm(`Remove "${b.dataset.collegeName}" and ALL its data? This can't be undone.`)) return;
    try{ await api('/super/colleges/'+b.dataset.delCollege, {method:'DELETE'}); await refreshColleges(); render(); }
    catch(err){ alert(err.message); }
  }));

  el.querySelectorAll('[data-del-hod]').forEach(b=>b.addEventListener('click', async ()=>{
    try{ await api('/college/hods/'+b.dataset.delHod, {method:'DELETE'}); state.hods = state.hods.filter(h=>h.id!==b.dataset.delHod); render(); }
    catch(err){ alert(err.message); }
  }));
  el.querySelectorAll('[data-del-faculty]').forEach(b=>b.addEventListener('click', async ()=>{
    try{ await api('/hod/faculty/'+b.dataset.delFaculty, {method:'DELETE'}); state.faculty = state.faculty.filter(f=>f.id!==b.dataset.delFaculty); render(); }
    catch(err){ alert(err.message); }
  }));
  el.querySelectorAll('[data-del-student]').forEach(b=>b.addEventListener('click', async ()=>{
    try{ await api('/hod/students/'+b.dataset.delStudent, {method:'DELETE'}); state.students = state.students.filter(s=>s.id!==b.dataset.delStudent); render(); }
    catch(err){ alert(err.message); }
  }));
  el.querySelectorAll('[data-del-section]').forEach(b=>b.addEventListener('click', async ()=>{
    try{ await api('/hod/sections/'+b.dataset.delSection, {method:'DELETE'}); state.sections = state.sections.filter(s=>s.id!==b.dataset.delSection); render(); }
    catch(err){ alert(err.message); }
  }));
  el.querySelectorAll('[data-assign-section]').forEach(sel=>sel.addEventListener('change', async ()=>{
    try{
      await api('/hod/sections/'+sel.dataset.assignSection+'/assign-faculty', {method:'PATCH', body:{faculty_username: sel.value || null}});
      const [f, sec] = await Promise.all([api('/hod/faculty'), api('/hod/sections')]);
      state.faculty = f.faculty; state.sections = sec.sections; render();
    }catch(err){ alert(err.message); }
  }));

  el.querySelectorAll('[data-connect]').forEach(b=>b.addEventListener('click', async ()=>{
    try{ await api('/network/requests', {method:'POST', body:{to_username:b.dataset.connect}}); await refreshNetworkState(); render(); }
    catch(err){ alert(err.message); }
  }));
  el.querySelectorAll('[data-accept-req]').forEach(b=>b.addEventListener('click', async ()=>{
    try{ await api('/network/requests/'+b.dataset.acceptReq+'/accept', {method:'POST'}); await refreshNetworkState(); render(); }
    catch(err){ alert(err.message); }
  }));
  el.querySelectorAll('[data-decline-req]').forEach(b=>b.addEventListener('click', async ()=>{
    try{ await api('/network/requests/'+b.dataset.declineReq+'/decline', {method:'POST'}); await refreshNetworkState(); render(); }
    catch(err){ alert(err.message); }
  }));
  el.querySelectorAll('[data-message-admin]').forEach(b=>b.addEventListener('click', ()=>{
    openNetworkChat(b.dataset.messageAdmin, b.dataset.adminName);
  }));

  el.querySelectorAll('[data-del-ann]').forEach(b=>b.addEventListener('click', async ()=>{
    try{ await api('/announcements/'+b.dataset.delAnn, {method:'DELETE'}); state.announcements = state.announcements.filter(a=>a.id!==b.dataset.delAnn); render(); }
    catch(err){ state.tabError = err.message; render(); }
  }));
  el.querySelectorAll('[data-del-event]').forEach(b=>b.addEventListener('click', async ()=>{
    try{ await api('/events/'+b.dataset.delEvent, {method:'DELETE'}); state.events = state.events.filter(a=>a.id!==b.dataset.delEvent); render(); }
    catch(err){ state.tabError = err.message; render(); }
  }));
  el.querySelectorAll('[data-rsvp]').forEach(b=>b.addEventListener('click', ()=>toggleRsvp(b.dataset.rsvp)));
  el.querySelectorAll('[data-del-note]').forEach(b=>b.addEventListener('click', async ()=>{
    try{ await api('/notes/'+b.dataset.delNote, {method:'DELETE'}); state.notes = state.notes.filter(a=>a.id!==b.dataset.delNote); render(); }
    catch(err){ state.tabError = err.message; render(); }
  }));
  el.querySelectorAll('[data-view-note]').forEach(b=>b.addEventListener('click', ()=>{
    openNoteFileViewer(b.dataset.viewNote, b.dataset.noteTitle, b.dataset.noteKind);
  }));
  el.querySelectorAll('[data-board-filter]').forEach(b=>b.addEventListener('click', ()=>{ state.boardFilter=b.dataset.boardFilter; render(); }));
  el.querySelectorAll('[data-open-post]').forEach(b=>b.addEventListener('click', ()=>openPostDetail(b.dataset.openPost)));

  // --- NEW: bookmarks ---
  el.querySelectorAll('[data-toggle-bookmark]').forEach(b=>b.addEventListener('click', async ()=>{
    try{
      const data = await api('/notes/'+b.dataset.toggleBookmark+'/bookmark', {method:'POST'});
      const n = state.notes.find(x=>x.id===b.dataset.toggleBookmark); if(n) n.bookmarked = data.bookmarked;
      render();
    }catch(err){ alert(err.message); }
  }));

  // --- NEW: clubs ---
  el.querySelectorAll('[data-open-club]').forEach(b=>b.addEventListener('click', ()=>openClubDetail(b.dataset.openClub)));

  // --- NEW: discussion forum ---
  el.querySelectorAll('[data-open-forum]').forEach(b=>b.addEventListener('click', ()=>openForumDetail(b.dataset.openForum)));
  const forumSearch = document.getElementById('forumSearchInput');
  if(forumSearch) forumSearch.addEventListener('change', async ()=>{ state.forumSearch = forumSearch.value.trim(); await refreshForum(); render(); });
  const forumSubject = document.getElementById('forumSubjectSelect');
  if(forumSubject) forumSubject.addEventListener('change', async ()=>{ state.forumSubject = forumSubject.value; await refreshForum(); render(); });

  // --- NEW: leaderboard filters ---
  const lbScope = document.getElementById('lbScopeSelect');
  if(lbScope) lbScope.addEventListener('change', async ()=>{
    state.leaderboardScope = lbScope.value; state.leaderboardValue='';
    try{ await refreshLeaderboard(); render(); }catch(err){ alert(err.message); }
  });
  const lbValue = document.getElementById('lbValueSelect');
  if(lbValue) lbValue.addEventListener('change', async ()=>{
    state.leaderboardValue = lbValue.value;
    try{ await refreshLeaderboard(); render(); }catch(err){ alert(err.message); }
  });

  // --- NEW: online tests ---
  el.querySelectorAll('[data-view-test-results]').forEach(b=>b.addEventListener('click', ()=>openTestResults(b.dataset.viewTestResults)));
  el.querySelectorAll('[data-del-test]').forEach(b=>b.addEventListener('click', async ()=>{
    if(!confirm('Delete this test? All submissions will be removed too.')) return;
    try{ await api('/faculty/tests/'+b.dataset.delTest, {method:'DELETE'}); state.facultyTests = state.facultyTests.filter(t=>t.id!==b.dataset.delTest); render(); }
    catch(err){ alert(err.message); }
  }));
  el.querySelectorAll('[data-attempt-test]').forEach(b=>b.addEventListener('click', ()=>{
    // Full-screen is optional — the test opens normally either way.
    openTestAttempt(b.dataset.attemptTest);
  }));
  el.querySelectorAll('[data-review-test]').forEach(b=>b.addEventListener('click', ()=>openTestAttempt(b.dataset.reviewTest)));

  // --- NEW: analytics charts (must run after the canvases are in the DOM) ---
  mountCharts();
}

boot();
