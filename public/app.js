import {createAiOffice} from './ai.js';
import {createTaskWorkflow} from './task-workflow.js';

const icons = {
  grid:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  list:'<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  repeat:'<path d="M20 7H7a4 4 0 0 0-4 4M17 4l3 3-3 3M4 17h13a4 4 0 0 0 4-4M7 14l-3 3 3 3"/>',
  bell:'<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
  settings:'<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  chevron:'<path d="m9 5 7 7-7 7"/>', down:'<path d="m6 9 6 6 6-6"/>',
  check:'<path d="m5 12 4 4L19 6"/>', checkCircle:'<circle cx="12" cy="12" r="9"/><path d="m7 12 3 3 7-7"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  alert:'<path d="M10.3 4.5 2.8 18a1.5 1.5 0 0 0 1.3 2h15.8a1.5 1.5 0 0 0 1.3-2L13.7 4.5a2 2 0 0 0-3.4 0ZM12 9v4M12 17h.01"/>',
  spark:'<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3ZM20 2v4M18 4h4"/>',
  calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 11h18M8 15h2M14 15h2"/>',
  download:'<path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/>',upload:'<path d="M12 16V4m-5 5 5-5 5 5M4 16v4h16v-4"/>',
  board:'<rect x="3" y="4" width="5" height="16" rx="1"/><rect x="10" y="4" width="5" height="10" rx="1"/><rect x="17" y="4" width="4" height="13" rx="1"/>',
  rows:'<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  close:'<path d="m6 6 12 12M6 18 18 6"/>', edit:'<path d="m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-4-4L5 15l-1 5Z"/>',
  folder:'<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
  leaf:'<path d="M20 3C10 2 3 6 3 13a7 7 0 0 0 14 0c0-4 1-7 3-10ZM4 20l10-10"/>',
  shield:'<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
  menu:'<path d="M4 6h16M4 12h16M4 18h16"/>',info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  trash:'<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
};
const icon = name => `<svg aria-hidden="true" viewBox="0 0 24 24">${icons[name] || icons.list}</svg>`;
const esc = v => String(v ?? '').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const today = () => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const shiftDate = (date,n) => { const d=new Date(`${date}T00:00:00Z`);d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10); };
const dateText = v => v ? `${Number(v.slice(5,7))}月${Number(v.slice(8,10))}日` : '—';
const timeText = v => v ? new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(v)) : '尚未执行';
const fullDate = () => new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'long',day:'numeric',weekday:'long'}).format(new Date());
const overdue = t => t.status !== '已完成' && t.dueDate < today();
const badge = t => {const s=overdue(t)?'已逾期':t.status;return `<span class="badge ${({待办:'todo',进行中:'doing',已完成:'done',已逾期:'overdue'})[s]||'todo'}">${esc(s)}</span>`;};
const submissionTypes = ['文本','表格','演示文稿','PDF','图片','不限'];
const submissionFormats = {
  文本:['txt','md','doc','docx','rtf'],表格:['csv','xls','xlsx'],演示文稿:['ppt','pptx'],PDF:['pdf'],图片:['png','jpg','jpeg','webp'],
};
submissionFormats['不限'] = [...new Set(Object.values(submissionFormats).flat())];
const taskSubmissionType = t => submissionTypes.includes(t.submissionType)?t.submissionType:'文本';
const submission = t => `<span class="submission-type">${esc(taskSubmissionType(t))}</span>`;
const formatText = type => submissionFormats[type].map(ext=>`.${ext}`).join('、');
const fileSizeText = bytes => bytes>=1024**3?`${(bytes/1024**3).toFixed(1)} GiB`:bytes>=1024*1024?`${(bytes/1024/1024).toFixed(1)} 兆`:`${Math.max(0,Math.ceil(bytes/1024))} 千字节`;
const avatar = name => `<span class="avatar">${esc((name==='管理员'?'管':(name||'管').slice(-2)))}</span>`;
const option = (value,selected,label=value) => `<option value="${esc(value)}" ${String(value)===String(selected)?'selected':''}>${esc(label)}</option>`;
const action = (name, label, cls='', extra='') => `<button type="button" class="${cls}" data-action="${name}" ${extra}>${label}</button>`;
let data = {tasks:[],templates:[],reminders:[],events:[],settings:{adminName:'管理员',reminderDays:1},system:{}};
let page = /^#task\/.+/.test(location.hash)?'task':['overview','tasks','templates','reminders','ai','settings'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
let taskFilter='全部',query='',ownerFilter='',submissionFilter='',layout='table',reminderFilter='未读',loadError='',loading=true,taskPage=1;
let focusBeforeModal=null,stateLoadToken=0,reminderPage=1,modalToken=0,detailData=null,searchTimer;
const taskCache=new Map();
const taskTotal=()=>data.summary?.total??data.tasks.length;
const unreadCount=()=>data.summary?.unread??data.reminders.filter(r=>!r.read).length;
const findTask=id=>data.tasks.find(task=>task.id===id)||taskCache.get(id);
const stateQuery=()=>new URLSearchParams({page:taskPage,pageSize:page==='overview'?5:10,filter:taskFilter,q:query,owner:ownerFilter,submissionType:submissionFilter,reminderPage,reminderFilter}).toString();
let completionDraft=null,completionBusy=false;
let serverchanBusy=false;
let attachmentBusy=false;
const pageNames={overview:'工作总览',tasks:'任务台账',templates:'固定任务',reminders:'提醒中心',ai:'AI 文档',settings:'平台设置'};
const ai=createAiOffice({api,esc,icon,action,option,heading,empty,timeText,openDrawer,closeDrawer,toast,getTasks:()=>data.tasks,rerender:()=>{if(page==='ai')renderApp();}});
const workflow=createTaskWorkflow({api,esc,icon,action,option,timeText,badge,toast,rerender:()=>{if(page==='task')renderApp();},onTaskChange:()=>refresh(false),openTaskForm:taskForm,openRecords:detail,openCompletion:completionForm,navigate});
function openWorkspace(id){closeDrawer();page='task';location.hash=`task/${encodeURIComponent(id)}`;workflow.open(id);renderApp();window.scrollTo(0,0);}

async function api(path,options={}){
  const response=await fetch(path,{...options,headers:{'Content-Type':'application/json',...options.headers}});
  const result=await response.json().catch(()=>({error:'服务返回异常，请稍后重试'}));
  if(!response.ok){const error=new Error(result.error||'操作未完成，请稍后重试');error.status=response.status;throw error;}
  return result;
}
async function refresh(render=true){
  const token=++stateLoadToken,requested=stateQuery();
  try{const result=await api('/api/state?'+requested);if(token!==stateLoadToken||requested!==stateQuery())return false;data=result;taskPage=data.pagination?.page||taskPage;reminderPage=data.reminderPagination?.page||1;loading=false;loadError='';if(page==='ai')await ai.load(false);if(render&&page==='task')await workflow.reload();if(render)renderApp();return true;}
  catch(error){if(token!==stateLoadToken)return false;loading=false;loadError='暂时无法连接本地服务。请确认平台已启动，再点击重试。';if(render)renderApp();return false;}
}
function toast(message,error=false){const el=document.createElement('div');el.className=`toast${error?' error':''}`;el.textContent=message;document.querySelector('#toast-root').append(el);setTimeout(()=>el.remove(),4500);}
function counts(){if(data.summary)return {pending:data.summary.pending,doing:data.summary.doing,overdue:data.summary.overdue,done:data.summary.done};return {pending:data.tasks.filter(t=>t.status==='待办').length,doing:data.tasks.filter(t=>t.status==='进行中').length,overdue:data.tasks.filter(overdue).length,done:data.tasks.filter(t=>t.status==='已完成').length};}
function weekTasks(){const t=today();const day=new Date(`${t}T12:00:00Z`).getUTCDay()||7;const start=shiftDate(t,1-day),end=shiftDate(start,6);return data.tasks.filter(t=>t.dueDate>=start&&t.dueDate<=end);}
function stats(){const c=counts();const weekDone=data.summary?.weekDone??data.tasks.filter(t=>t.status==='已完成'&&t.completedAt&&weekContains(t.completedAt)).length;return `<div class="stats">${[
  ['待处理',c.pending,'待办'],['进行中',c.doing,'进行中'],['已逾期',c.overdue,'已逾期'],['本周完成',weekDone,'已完成']
].map(([label,num,filter])=>action('stat',`<span class="stat-label">${label}</span><strong class="stat-number ${filter==='已逾期'&&num?'number-alert':''}">${num}</strong>`,'stat',`data-filter="${filter}" aria-label="查看${filter}任务"`)).join('')}</div>`;}
function weekContains(value){const t=today();const day=new Date(`${t}T12:00:00Z`).getUTCDay()||7;const start=shiftDate(t,1-day),end=shiftDate(start,6);const d=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));return d>=start&&d<=end;}
function heading(title,subtitle,buttons=''){return `<div class="page-heading"><div class="page-heading-copy"><h1>${title}</h1>${subtitle?`<p class="subtitle">${subtitle}</p>`:''}</div>${buttons?`<div class="button-row">${buttons}</div>`:''}</div>`;}
function renderApp(){
  const focusedSearch=document.activeElement?.id==='task-search'?{start:document.activeElement.selectionStart,end:document.activeElement.selectionEnd}:null;
  const unread=unreadCount();
  document.title=`${page==='task'?'整理并完成':pageNames[page]} · AI辅助办公应用`;
  document.querySelector('#app').innerHTML=`<div class="shell"><aside class="sidebar"><a class="brand" href="#overview" aria-label="AI辅助办公应用首页"><span class="brand-name">AI辅助办公应用</span><span class="brand-sub">本地工作台</span></a><nav class="nav" aria-label="主导航">${Object.entries(pageNames).map(([key,label])=>action('navigate',`${icon(({overview:'grid',tasks:'list',templates:'repeat',reminders:'bell',ai:'list',settings:'settings'})[key])}<span>${label}</span>${key==='reminders'&&unread?`<span class="nav-count">${unread}</span>`:''}`,`nav-btn ${(page===key||page==='task'&&key==='tasks')?'active':''}`,`data-page="${key}" ${(page===key||page==='task'&&key==='tasks')?'aria-current="page"':''}`)).join('')}</nav><div class="sidebar-footer"><span>本地版</span>${action('roadmap','关于平台','link-button')}</div></aside><div class="main-shell"><header class="topbar"><div class="breadcrumb">${action('menu',icon('menu'),'icon-btn mobile-menu','aria-label="打开导航菜单"')}<span>办公平台</span>${icon('chevron')}<strong>${page==='task'?'整理并完成':pageNames[page]}</strong></div><div class="top-actions"><span class="date">${fullDate()}</span>${action('navigate',`${icon('bell')}${unread?'<span class="unread-dot"></span>':''}`,'icon-btn',`data-page="reminders" aria-label="提醒中心，${unread}条未读"`)}<div class="profile"><span>${esc(data.settings.adminName)}</span></div></div></header><main class="main" id="main-content">${loadError?`<div class="error-banner">${loadError} ${action('retry','重新连接','button small')}</div>`:''}${loading?'<div class="skeleton">正在读取本地工作台…</div>':renderPage()}<footer class="page-footer"><span>AI辅助办公应用 · 本地版</span></footer></main></div></div>`;
  if(focusedSearch){const input=document.querySelector('#task-search');if(input){input.focus({preventScroll:true});input.setSelectionRange(focusedSearch.start,focusedSearch.end);}}
}
function renderPage(){return ({overview:overviewPage,tasks:tasksPage,task:()=>workflow.render(),templates:templatesPage,reminders:remindersPage,ai:()=>ai.render(),settings:settingsPage})[page]();}
function overviewPage(){const wCount=data.summary?.weekDueCount??weekTasks().length,done=data.summary?.weekDueDone??weekTasks().filter(t=>t.status==='已完成').length,percent=wCount?Math.round(done/wCount*100):0;const due=data.upcoming||[];return `${heading('工作总览',`共 ${taskTotal()} 项任务，${taskTotal()-counts().done} 项未完成。`,action('new-task',`${icon('plus')} 新建任务`,'button primary'))}${stats()}${taskPanel(true)}<div class="overview-secondary"><section class="panel"><div class="panel-heading"><h2>近期到期</h2>${action('navigate','查看全部','link-button','data-page="tasks"')}</div><div class="notice-list">${due.length?due.map(t=>action('detail',`<span class="notice-date">${dateText(t.dueDate)}</span><span class="notice-info"><h3>${esc(t.title)}</h3><p>${esc(t.owner)} · ${overdue(t)?'已逾期':t.dueDate===today()?'今天截止':'待处理'}</p></span>`,'notice-item',`data-id="${t.id}"`)).join(''):empty('暂无待办任务','当前任务已完成。')}</div><div class="week-summary"><div><span>本周到期任务</span><span>已完成 ${done} / ${wCount}</span></div><div class="progress-track" role="progressbar" aria-label="本周任务完成率" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><span style="width:${percent}%"></span></div></div></section><section class="panel"><div class="panel-heading"><h2>最近动态</h2><span class="small-label">最近 4 条记录</span></div>${activity(data.events.slice(0,4))}</section></div>`;}
function tasksPage(){return `${heading('任务台账','查看、分派和跟进全部任务。',`${action('trash',`${icon('trash')} 回收站`,'button')}<a class="button" href="/api/export/tasks" download>${icon('download')} 导出台账</a>${action('new-task',`${icon('plus')} 新建任务`,'button primary')}`)}${taskPanel(false)}`;}
function filteredTasks(){if(data.pagination)return data.tasks;const q=query.trim().toLowerCase();return data.tasks.filter(t=>(taskFilter==='全部'||taskFilter==='已逾期'?taskFilter==='全部'||overdue(t):t.status===taskFilter)&&(!q||[t.title,t.owner,t.deliverable,String(t.number)].some(v=>String(v||'').toLowerCase().includes(q)))&&(!ownerFilter||t.owner===ownerFilter)&&(!submissionFilter||taskSubmissionType(t)===submissionFilter)).sort((a,b)=>(a.status==='已完成')-(b.status==='已完成')||a.dueDate.localeCompare(b.dueDate)||b.createdAt.localeCompare(a.createdAt));}
function taskPanel(compact){const c=counts(),tabCounts={'全部':taskTotal(),'待办':c.pending,'进行中':c.doing,'已完成':c.done,'已逾期':c.overdue};return `<section class="panel ${compact?'dashboard-table':''}"><div class="panel-heading"><h2><span class="heading-dot"></span>${compact?'我的任务':'全部任务'}</h2>${compact?action('navigate',`查看全部 ${icon('chevron')}`,'link-button','data-page="tasks"'):`<span class="small-label">共 ${taskTotal()} 项工作记录</span>`}</div><div class="tabs" role="tablist" aria-label="任务状态筛选">${Object.entries(tabCounts).map(([s,n])=>action('filter',`${s==='待办'?'待处理':s}<span class="tab-count">${n}</span>`,`tab ${taskFilter===s?'active':''}`,`data-filter="${s}" role="tab" aria-selected="${taskFilter===s}"`)).join('')}</div><div class="filter-bar"><label class="search-wrap">${icon('search')}<input id="task-search" aria-label="搜索任务名称、负责人或交付要求" placeholder="搜索任务名称、负责人…" value="${esc(query)}" autocomplete="off"></label><select id="owner-filter" class="filter-select" aria-label="负责人筛选">${option('',ownerFilter,'全部负责人')}${(data.owners||[...new Set(data.tasks.map(t=>t.owner))].sort()).map(v=>option(v,ownerFilter)).join('')}</select><select id="submission-filter" class="filter-select" aria-label="提交形式筛选">${option('',submissionFilter,'全部提交形式')}${submissionTypes.map(v=>option(v,submissionFilter)).join('')}</select><div class="view-switch" aria-label="切换视图">${action('layout',icon('rows'),layout==='table'?'active':'',`data-layout="table" aria-label="列表视图" aria-pressed="${layout==='table'}"`)}${action('layout',icon('board'),layout==='board'?'active':'',`data-layout="board" aria-label="看板视图" aria-pressed="${layout==='board'}"`)}</div></div><div id="task-results">${taskResults(compact)}</div></section>`;}
function taskResults(compact){
  const tasks=filteredTasks(),total=data.pagination?.total??tasks.length,pageSize=data.pagination?.pageSize||(compact?5:10),pageCount=data.pagination?.pageCount||Math.max(1,Math.ceil(total/pageSize));
  taskPage=Math.max(1,Math.min(taskPage,pageCount));
  const start=(taskPage-1)*pageSize,shown=data.pagination?tasks:tasks.slice(start,start+pageSize);
  const rows=shown.map(t=>`<tr><td>${action('detail',esc(t.title),'task-title',`data-id="${t.id}"`)}<div class="task-sub"><span class="task-owner-inline">${esc(t.owner)}</span><span>${esc(t.category)}</span><span class="task-number">· 第 ${t.number} 号</span><span class="task-submission-inline">${esc(taskSubmissionType(t))}</span></div><div class="task-mobile-actions">${taskActions(t,'row-action')}${action('delete-task','删除','row-action danger',`data-id="${t.id}" aria-label="删除任务：${esc(t.title)}"`)}</div></td><td><div class="owner-cell">${esc(t.owner)}</div></td><td class="${overdue(t)?'overdue-date':''}" title="${t.dueDate}">${dateText(t.dueDate)}${t.dueDate===today()?'<div class="task-sub">今天截止</div>':''}</td><td class="submission-col">${submission(t)}</td><td>${badge(t)}</td><td><div class="row-actions">${taskActions(t,'row-action')}${action('delete-task','删除','row-action danger',`data-id="${t.id}" aria-label="删除任务：${esc(t.title)}"`)}</div></td></tr>`).join('');
  const content=!shown.length?empty('这里还没有任务',query||ownerFilter||submissionFilter?'试试其他搜索词或筛选条件。':taskFilter==='全部'?'点击「新建任务」，开始记录第一项工作。':'换个分类，查看其他工作安排。'):layout==='board'?taskBoard(shown):`<div class="table-wrap"><table><thead><tr><th>任务名称</th><th>负责人</th><th>截止日期</th><th class="submission-col">提交形式</th><th>状态</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  const pageOptions=Array.from({length:pageCount},(_,i)=>option(i+1,taskPage,`第 ${i+1} 页`)).join('');
  return `${content}<div class="table-footer"><span class="pagination-summary">共 ${total} 项${total?`，本页 ${start+1}—${start+shown.length} 项`:''}</span><nav class="pagination" aria-label="任务分页">${action('task-page','上一页','button small',`data-page-number="${taskPage-1}" ${taskPage===1?'disabled':''}`)}<label class="page-select-label"><span class="visually-hidden">选择页码</span><select id="task-page-select" aria-label="任务页码">${pageOptions}</select><span> / ${pageCount} 页</span></label>${action('task-page','下一页','button small',`data-page-number="${taskPage+1}" ${taskPage===pageCount?'disabled':''}`)}</nav></div>`;
}
function taskActions(t,cls){return `${action('edit-task','编辑任务',cls,`data-id="${t.id}"`)}${t.status==='已完成'?action('detail','查看',cls,`data-id="${t.id}"`):action('status','标记完成',cls,`data-id="${t.id}" data-status="已完成"`)}`;}
function taskBoard(tasks){return `<div class="board">${['待办','进行中','已完成'].map(status=>{const list=tasks.filter(t=>t.status===status);return `<section class="board-column"><h3>${status} · 本页 ${list.length} 项</h3>${list.map(t=>`<article class="board-card">${badge(t)}${action('detail',esc(t.title),'board-task-title',`data-id="${t.id}"`)}<div class="board-card-footer"><span>${esc(t.owner)}</span><span>${dateText(t.dueDate)}截止</span></div><p class="board-submission">提交形式：${esc(taskSubmissionType(t))}</p><div class="board-actions">${taskActions(t,'row-action')}${action('delete-task','删除','row-action danger',`data-id="${t.id}"`)}</div></article>`).join('')}${!list.length?'<p class="subtitle">本页暂无任务</p>':''}</section>`;}).join('')}</div>`;}
function activity(events){return events.length?`<div class="activity-list">${events.map(e=>`<div class="activity-item"><span class="activity-symbol">${icon(e.action.includes('完成')?'check':'edit')}</span><div class="activity-info"><strong>${esc(e.actor||'管理员')}</strong> · ${esc(e.action)}<div class="activity-detail" title="${esc(e.detail)}">${esc(e.detail)}</div></div><time class="activity-time">${timeText(e.createdAt)}</time></div>`).join('')}</div>`:empty('暂无操作记录','任务新增、改派和状态变更将记录在这里。');}
function empty(title,text){return `<div class="empty">${icon('folder')}<h3>${title}</h3><p>${text}</p></div>`;}
function templatesPage(){return `${heading('固定任务','设置重复周期，自动生成任务。',`${action('import',`${icon('upload')} 批量导入`,'button')}${action('new-template',`${icon('plus')} 新建固定任务`,'button primary')}`)}<div class="info-banner">${icon('repeat')}<span>支持每周、每月、每季度及每年。平台运行时自动检查；停机后最多补齐近一年的周期，每次最多生成 100 项，剩余任务分批继续处理。</span></div>${data.templates.length?`<div class="templates-grid">${data.templates.map(t=>`<article class="panel template-card"><div class="template-card-top"><span class="template-icon">${icon('repeat')}</span><span class="badge ${t.active?'done':'todo'}">${t.active?'自动生成中':'已暂停'}</span></div><h3>${esc(t.title)}</h3><p class="template-description">${esc(t.deliverable)}</p><dl class="template-metadata"><div><dt>负责人</dt><dd>${esc(t.owner)}</dd></div><div><dt>重复周期</dt><dd>${esc(t.frequency)}</dd></div><div><dt>下次开始</dt><dd>${esc(t.nextDate)}</dd></div><div><dt>完成时限</dt><dd>${t.dueDays===0?'当天完成':`开始后 ${t.dueDays} 天`}</dd></div></dl><div class="button-row">${action('edit-template',`${icon('edit')} 编辑规则`,'button small',`data-id="${t.id}"`)}${action('toggle-template',t.active?'暂停生成':'启用生成','button small ghost',`data-id="${t.id}"`)}</div></article>`).join('')}</div>`:`<section class="panel">${empty('暂无固定任务','创建一项周期规则，或通过表格批量导入。')}</section>`}`;}
function remindersPage(){const list=data.reminders.filter(r=>reminderFilter==='全部'||!r.read);return `${heading('提醒中心','查看临期和逾期事项。',`${action('run',`${icon('repeat')} 检查提醒`,'button')}${action('read-all',`${icon('check')} 全部标为已读`,'button primary')}`)}<div class="info-banner">${icon('bell')}<span>当前规则：提前 <strong>${data.settings.reminderDays} 天</strong>提醒，同时在到期当天和逾期后提醒。接收对象为任务负责人和${esc(data.settings.adminName)}，站内提醒保存在本地平台内；微信推送可在下方单独配置。</span></div>${serverchanPanel()}<section class="panel"><div class="panel-heading"><h2>工作提醒</h2><span class="small-label">${unreadCount()} 条未读</span></div><div class="tabs">${['未读','全部'].map(s=>action('reminder-filter',s,`tab ${s===reminderFilter?'active':''}`,`data-filter="${s}"`)).join('')}</div>${list.length?list.map(r=>`<article class="reminder-card ${r.read?'':'unread'}"><span class="reminder-icon">${icon(r.kind==='逾期'?'alert':'bell')}</span><div class="reminder-content"><h3>${esc(r.title)} ${!r.read?'<span class="badge todo">未读</span>':''}</h3><p>${esc(r.message)}</p><div class="reminder-meta"><span>提醒对象：${esc((r.recipients||[]).join('、'))}</span><time>${timeText(r.createdAt)}</time></div></div><div class="reminder-actions">${action('detail','查看任务','button small',`data-id="${r.taskId}"`)}${r.read?'<span class="read-label">已读</span>':action('read','标为已读','link-button',`data-id="${r.id}"`)}</div></article>`).join(''):empty(reminderFilter==='未读'?'暂无未读提醒':'暂无提醒','系统会按设置检查未完成任务，也可以手动检查。')}${reminderPagination()}</section>`;}
function reminderPagination(){const p=data.reminderPagination;if(!p||p.pageCount<=1)return '';return `<div class="table-footer"><span>共 ${p.total} 条，第 ${p.page}/${p.pageCount} 页</span><div class="button-row">${action('reminder-page','上一页','button small',`data-page-number="${p.page-1}" ${p.page===1?'disabled':''}`)}${action('reminder-page','下一页','button small',`data-page-number="${p.page+1}" ${p.page===p.pageCount?'disabled':''}`)}</div></div>`;}
function settingsPage(){return `${heading('平台设置','管理提醒规则和数据备份。','')}<div class="settings-grid"><section class="panel"><div class="panel-heading"><h2><span class="heading-dot"></span>基础与提醒设置</h2></div><form id="settings-form" class="settings-body"><div class="form-error" role="alert"></div><div class="form-grid"><div class="field full"><label for="adminName">管理员名称 <span class="required">*</span></label><input id="adminName" name="adminName" required maxlength="50" value="${esc(data.settings.adminName)}"><span class="hint">作为提醒接收人和操作记录中的管理员署名。</span></div><div class="field full"><label for="reminderDays">提前提醒天数 <span class="required">*</span></label><input id="reminderDays" name="reminderDays" type="number" min="0" max="30" required value="${data.settings.reminderDays}"><span class="hint">设置为 0 至 30 天。到期当天和逾期后也会提醒；已完成任务停止提醒。</span></div></div><div class="form-actions"><button class="button primary" type="submit">保存设置</button></div></form></section><div class="main-column"><section class="panel"><div class="panel-heading"><h2>运行信息</h2><span class="badge done">本地管理员版</span></div><div class="settings-body"><div class="setting-row"><span>定时检查方式</span><strong>${esc(data.system.scheduler||'本地定时器')}</strong></div><div class="setting-row"><span>最近检查时间</span><strong>${timeText(data.system.lastRunAt)}</strong></div><div class="setting-row"><span>工作时区</span><strong>北京时间</strong></div><div class="setting-row"><span>数据范围</span><strong>${taskTotal()} 项任务 · ${data.templates.length} 项固定规则</strong></div><div class="setting-row"><span>原件及交付文件</span><strong>${fileSizeText(data.system.storage?.used||0)} / ${fileSizeText(data.system.storage?.limit||4294967296)}</strong></div><div class="setting-row"><span>待补齐周期规则</span><strong>${data.system.pendingSchedules||0} 项（每次最多补建 100 项任务）</strong></div><div class="setting-row"><span>当前阶段</span><strong>二期：AI 文档辅助</strong></div><div class="form-actions">${action('run','立即检查任务与提醒','button small')}</div></div></section><section class="panel"><div class="panel-heading"><h2>数据导出与备份</h2>${icon('shield')}</div><div class="settings-body"><p class="subtitle">下载数据备份可保留任务、固定规则、提醒、操作记录、已提交材料，以及 AI 素材、文档模板、文档和审核记录。模型设置与密钥单独保存在本机，不包含在备份中。建议定期将备份保存到其他磁盘。</p><div class="button-row" style="margin-top:18px"><a class="button" href="/api/backup" download>${icon('download')} 下载数据备份</a><a class="button" href="/api/export/tasks" download>${icon('list')} 导出任务台账</a></div></div></section></div></div>`;}

function serverchanStatus(record){
  if(!record)return '暂无请求记录';
  return ({sending:'请求中',sent:'Server酱已受理，请在微信确认',failed:'请求失败'})[record.status]||'状态待确认';
}
function serverchanTodayDigest(){return (data.serverchan?.history||[]).find(r=>r.kind==='digest'&&r.day===today());}
function serverchanPanel(){
  const settings=data.serverchan;
  if(!settings)return `<section class="panel serverchan-panel"><div class="panel-heading"><h2>个人微信推送</h2><span class="small-label">服务待更新</span></div><p class="serverchan-unavailable">当前运行服务尚未启用微信推送功能，请更新并重启平台服务。</p></section>`;
  const latest=settings.latest,digest=serverchanTodayDigest(),submitted=digest?.status==='sent',sending=latest?.status==='sending',retry=digest?.status==='failed';
  const keyLabel=settings.configured?settings.keySource==='environment'?'已配置 · 环境变量管理':'已配置 · 本机保存':'未配置';
  return `<section class="panel serverchan-panel"><div class="panel-heading"><h2>个人微信推送</h2><span class="badge ${settings.enabled?'done':'todo'}">${settings.enabled?'已启用':'未启用'}</span></div><div class="serverchan-body"><p class="serverchan-description">通过方糖 Server酱，将临期和逾期任务的每日摘要推送到本人微信服务号。</p>${settings.configError?`<p class="serverchan-result is-failed" role="alert">${esc(settings.configError)}</p>`:settings.keySource==='environment'&&!settings.configured?'<p class="serverchan-result is-failed" role="alert">环境变量中的 SendKey 不可用，请检查本机配置后重启服务。</p>':''}<dl class="serverchan-summary"><div><dt>推送凭据</dt><dd>${keyLabel}</dd></div><div><dt>每天汇总</dt><dd>北京时间 ${esc(settings.sendTime||'09:00')}</dd></div><div><dt>负责人范围</dt><dd>${esc(settings.owner||'全部负责人')}</dd></div><div><dt>最近请求</dt><dd>${latest?timeText(latest.attemptedAt):'尚未发送'}</dd></div></dl><div class="serverchan-result ${latest?.status==='failed'?'is-failed':''}" role="status"><span>${latest?`${latest.kind==='test'?'测试推送':'任务汇总'} · `:''}${serverchanStatus(latest)}</span>${latest?.error?`<p>${esc(latest.error)}</p>`:''}${submitted?'<p>今日汇总已提交，不会重复发送。</p>':''}</div><div class="button-row serverchan-actions">${action('serverchan-configure','配置微信推送','button primary')}${action('serverchan-test','测试微信推送','button',`${!settings.configured||sending?'disabled':''}`)}${action('serverchan-send',submitted?'今日已提交':retry?'重试今日提醒':'推送今日提醒','button',`${!settings.enabled||!settings.configured||submitted||sending?'disabled':''} data-retry="${retry}"`)}</div><p class="serverchan-footnote">一天自动汇总一次；站内已读不影响汇总。失败后可手动重试。测试也占用第三方额度，以 Server酱官网实际额度为准。</p>${settings.history?.length?`<details class="serverchan-history"><summary>最近推送记录</summary><ul>${settings.history.map(r=>`<li><div><span>${r.kind==='test'?'测试推送':`任务汇总 · ${r.taskCount||0} 项`}</span><time>${timeText(r.attemptedAt)}</time></div><p class="${r.status==='failed'?'is-failed':''}">${serverchanStatus(r)}${r.attempts>1?` · 第 ${r.attempts} 次请求`:''}</p>${r.error?`<p class="is-failed">${esc(r.error)}</p>`:''}</li>`).join('')}</ul></details>`:''}</div></section>`;
}
function serverchanForm(){
  const settings=data.serverchan;if(!settings)return toast('请先更新并重启平台服务',true);
  const managed=settings.keySource==='environment';
  const owners=[...new Set([...data.tasks.map(t=>t.owner),...data.templates.map(t=>t.owner),settings.owner].filter(Boolean))].sort();
  openDrawer('配置个人微信推送',`<div class="serverchan-setup"><p>使用 <a href="https://sct.ftqq.com/" target="_blank" rel="noopener noreferrer">Server酱 Turbo 官网</a>（方糖服务）。登录后获取以 SCT 开头的 SendKey，将默认通道设为「微信服务号」，并绑定本人微信。SC3 密钥用于 App 推送，不适用于此处。</p></div><form id="serverchan-form"><div class="form-error" role="alert"></div><label class="serverchan-toggle"><input type="checkbox" id="serverchan-enabled" name="enabled" ${settings.enabled?'checked':''}><span>启用每日微信汇总</span></label><div class="form-grid"><div class="field full"><label for="serverchan-key">SendKey 推送密钥</label><input id="serverchan-key" name="sendKey" type="password" autocomplete="new-password" maxlength="256" spellcheck="false" ${managed?'disabled':''} placeholder="${managed?'已由环境变量提供':settings.configured?'已保存；留空保留原密钥':'粘贴 SCT 开头的 SendKey'}"><span class="hint">${managed?'密钥由环境变量管理，页面不能修改或清除。':settings.configured?'密钥不会回显；填写新值后保存即可更换。':'只保存在本机服务端，页面不会显示已保存的密钥。请勿将密钥发给他人。'}</span></div><div class="field"><label for="serverchan-time">每天汇总时间</label><input id="serverchan-time" name="sendTime" type="time" value="${esc(settings.sendTime||'09:00')}" required><span class="hint">按北京时间执行，平台服务需保持运行。</span></div><div class="field"><label for="serverchan-owner">负责人范围</label><select id="serverchan-owner" name="owner">${option('',settings.owner||'','全部负责人')}${owners.map(name=>option(name,settings.owner)).join('')}</select><span class="hint">选择需要汇总到本人微信的任务。</span></div></div><div class="serverchan-disclosure">启用后会将任务标题、负责人、截止日期摘要发送到 Server酱及绑定的微信，不上传交付文档。每日自动汇总一次；站内标为已读后仍会汇总。失败不自动重复，可在提醒中心手动重试。</div><p class="serverchan-footnote">首次使用请先保存配置，再点击「测试微信推送」，并在微信确认接收结果。测试也占用 Server酱额度。</p>${settings.configured&&!managed?`<div class="serverchan-key-actions">${action('serverchan-clear-prompt','清除本机密钥并停用','link-button danger')}<div id="serverchan-clear-confirm" class="serverchan-clear-confirm" hidden><p>清除后将停止微信推送。以后可重新填写密钥并启用。</p><div class="button-row">${action('serverchan-clear-cancel','取消','button small')}${action('serverchan-clear','确认清除并停用','button small danger')}</div></div></div>`:''}</form>`,`${action('close','取消','button')}<button type="submit" form="serverchan-form" class="button primary">保存配置</button>`, 'center');
}
function serverchanControls(busy){
  const controls=[...document.querySelectorAll('.serverchan-panel button, .drawer button, #serverchan-form input, #serverchan-form select')];
  const states=controls.map(el=>[el,el.disabled]);
  if(busy)controls.forEach(el=>el.disabled=true);
  return ()=>states.forEach(([el,disabled])=>el.disabled=disabled);
}
async function saveServerchan(form){
  if(serverchanBusy)return;
  const err=form.querySelector('.form-error');err.textContent='';
  const fields={enabled:form.elements.enabled.checked,sendTime:form.elements.sendTime.value,owner:form.elements.owner.value};
  const key=form.elements.sendKey;if(!key.disabled&&key.value.trim())fields.sendKey=key.value.trim();
  const restore=serverchanControls(true);serverchanBusy=true;
  try{
    const result=await api('/api/serverchan/settings',{method:'PATCH',body:JSON.stringify(fields)});
    key.value='';data.serverchan=result.serverchan;renderApp();serverchanForm();toast('微信推送配置已保存');
  }catch(error){err.textContent=error.message;err.scrollIntoView({block:'nearest'});}
  finally{serverchanBusy=false;restore();}
}
async function serverchanRequest(kind,button){
  if(serverchanBusy)return;
  const restore=serverchanControls(true);serverchanBusy=true;
  try{
    const clear=kind==='clear';
    const result=await api(clear?'/api/serverchan/settings':`/api/serverchan/${kind}`,{method:clear?'PATCH':'POST',body:JSON.stringify(clear?{clearSendKey:true}:kind==='send'?{retry:button.dataset.retry==='true'}:{})});
    if(result.serverchan)data.serverchan=result.serverchan;
    renderApp();
    if(clear){serverchanForm();toast('本机密钥已清除，微信推送已停用');}
    else toast(result.result?.message||'操作完成，请查看最近请求结果',result.result?.record?.status==='failed');
  }catch(error){
    await refresh();
    const err=document.querySelector('#serverchan-form .form-error');if(err)err.textContent=error.message;
    toast(error.message,true);
  }finally{serverchanBusy=false;restore();}
}

function openDrawer(title,body,footer='',layout='center'){
  completionDraft=null;modalToken++;
  if(!document.querySelector('.drawer'))focusBeforeModal=document.activeElement;
  document.querySelector('#overlay-root').innerHTML=`<div class="overlay${layout==='center'?' overlay-centered':''}"><section class="drawer${layout==='center'?' drawer-centered':''}" role="dialog" aria-modal="true" aria-labelledby="drawer-title" tabindex="-1"><div class="drawer-header"><h2 id="drawer-title">${title}</h2>${action('close',icon('close'),'icon-btn','aria-label="关闭窗口"')}</div><div class="drawer-body">${body}</div>${footer?`<div class="drawer-footer">${footer}</div>`:''}</section></div>`;
  document.body.style.overflow='hidden';
  requestAnimationFrame(()=>document.querySelector('.drawer input:not([type=file]), .drawer textarea, .drawer')?.focus());
}
function closeDrawer(){
  if(completionBusy||serverchanBusy||attachmentBusy||ai.busy||workflow.busy)return;
  completionDraft=null;modalToken++;document.querySelector('#overlay-root').innerHTML='';document.body.style.overflow='';
  const target=focusBeforeModal?.isConnected?focusBeforeModal:focusBeforeModal?.dataset.action==='serverchan-configure'?document.querySelector('[data-action="serverchan-configure"]'):null;
  target?.focus();
}
function confirmDelete(id){
  const task=findTask(id);if(!task){toast('任务不存在或已删除，请刷新后重试',true);return;}
  openDrawer('删除任务',`<div class="delete-summary">${icon('trash')}<h3>确认删除这项任务？</h3><p class="delete-task-name">${esc(task.title)}</p><p>任务将移入回收站，并从任务台账和提醒中移除。可在「任务台账 → 回收站」恢复，操作记录会保留。</p>${task.templateId?'<p class="delete-rule-note">这是固定规则生成的任务。删除本次任务后，规则仍会正常生成后续任务；如需停止后续生成，请暂停对应固定规则。</p>':''}</div>`,`${action('close','取消','button')}${action('confirm-delete','确认删除','button danger',`data-id="${id}"`)}`);
}
async function openTrash(){
  const result=await api('/api/trash');
  openDrawer('回收站',`<p class="subtitle trash-intro">已删除的任务可在这里恢复，原负责人、状态和历史记录均会保留。</p>${result.tasks.length?`<div class="trash-list">${result.tasks.map(task=>`<article class="trash-item"><div><h3>${esc(task.title)}</h3><p>${esc(task.owner)} · ${esc(task.status)}</p><p>删除时间：${timeText(task.deletedAt)}</p></div>${action('restore','恢复任务','button small',`data-id="${task.id}"`)}</article>`).join('')}</div>`:empty('回收站为空','删除的任务会显示在这里。')}`,action('close','关闭','button'));
}
function field(label,name,value='',type='text',extra='',full=false){return `<div class="field ${full?'full':''}"><label for="field-${name}">${label}${extra.includes('required')?' <span class="required">*</span>':''}</label><input id="field-${name}" name="${name}" type="${type}" value="${esc(value)}" ${extra}></div>`;}
function selectField(label,name,value,choices,full=false){return `<div class="field ${full?'full':''}"><label for="field-${name}">${label}</label><select id="field-${name}" name="${name}">${choices.map(v=>option(v,value)).join('')}</select></div>`;}
function textareaField(label,name,value,extra=''){return `<div class="field full"><label for="field-${name}">${label}${extra.includes('required')?' <span class="required">*</span>':''}</label><textarea id="field-${name}" name="${name}" ${extra}>${esc(value)}</textarea></div>`;}
async function taskForm(id){const t=(id?await taskForModal(id):null)||{startDate:today(),dueDate:shiftDate(today(),3),submissionType:'文本',category:'临时任务',status:'待办'};if(id&&!t.id)return;openDrawer(id?'编辑任务':'新建任务',`<p class="subtitle" style="margin:0 0 22px">填写任务信息，带 * 的为必填项。点击任务的“标记完成”，即可上传素材、生成正文并提交。</p><form id="task-form" data-id="${id||''}"><div class="form-error" role="alert"></div><div class="form-grid">${field('任务名称','title',t.title,'text','required maxlength="120" placeholder="例如：完成本周生产例会纪要"',true)}${field('负责人','owner',t.owner,'text','required maxlength="50" placeholder="请输入负责人姓名"')}${selectField('任务分类','category',t.category,['临时任务','固定任务','党建工作'])}${field('开始日期','startDate',t.startDate,'date','required')}${field('截止日期','dueDate',t.dueDate,'date','required')}${selectField('提交形式','submissionType',taskSubmissionType(t),submissionTypes)}${selectField('任务状态','status',t.status,t.status==='已完成'?['待办','进行中','已完成']:['待办','进行中'])}${t.status==='已完成'?'<p class="hint field full">已完成任务可保留当前状态；若要变更为现有材料不支持的提交形式，请先重新打开任务。</p>':''}${textareaField('交付要求','deliverable',t.deliverable,'required maxlength="2000" placeholder="需要提交什么材料，达到什么标准？"')}${textareaField('补充说明','description',t.description,'maxlength="4000" placeholder="背景、注意事项或相关安排（选填）"')}</div></form>`,`${action('close','取消','button')}<button type="submit" form="task-form" class="button primary">${id?'保存修改':'创建任务'}</button>`);}
function attachmentList(t){const attachments=t.attachments||[];return attachments.length?`<ul class="attachment-list">${attachments.map(a=>`<li><div class="attachment-info"><div class="attachment-heading"><a class="attachment-download" href="/api/attachments/${encodeURIComponent(a.id)}" download>${icon('download')}<span>${esc(a.name)}</span></a>${action('delete-attachment','删除','link-button danger',`data-id="${esc(a.id)}" data-task-id="${esc(t.id)}" aria-label="删除已提交材料：${esc(a.name)}"`)}</div><p>${fileSizeText(a.size)} · ${timeText(a.uploadedAt)} · ${esc(a.submissionType||'文本')}</p>${a.note?`<p class="attachment-note">提交说明：${esc(a.note)}</p>`:''}</div></li>`).join('')}</ul>`:`<p class="attachment-empty">${t.status==='已完成'?'历史完成任务：当时未要求上传材料。':'尚未提交材料，标记完成时需上传。'}</p>`;}
function deletedAttachmentList(t,expanded=false){
  const attachments=t.deletedAttachments||[];if(!attachments.length)return '';
  return `<details class="deleted-attachments" ${expanded?'open':''}><summary>已删除材料（${attachments.length} 份）</summary><p class="attachment-empty">可在此恢复已删除的材料。恢复材料不会自动完成任务。</p><div id="attachment-action-error" class="form-error" role="alert"></div><ul class="attachment-list">${attachments.map(a=>`<li><div class="attachment-heading"><div class="attachment-info"><strong class="deleted-attachment-name">${esc(a.name)}</strong><p>${fileSizeText(a.size)} · 删除于 ${timeText(a.deletedAt)}</p></div>${action('restore-attachment','恢复','button small',`data-id="${esc(a.id)}" data-task-id="${esc(t.id)}" aria-label="恢复已删除材料：${esc(a.name)}"`)}</div></li>`).join('')}</ul></details>`;
}
function renderDetail(id,showDeleted=false){const t=detailData?.task.id===id?detailData.task:findTask(id);if(!t){toast('此任务暂时不可用，请刷新后重试',true);return;}openDrawer('任务详情',`<div class="button-row">${badge(t)}<span class="subtitle">提交形式：${esc(taskSubmissionType(t))}</span><span class="subtitle">第 ${t.number} 号</span></div><h3 class="detail-title">${esc(t.title)}</h3><dl class="detail-grid"><div><dt>负责人</dt><dd>${esc(t.owner)}</dd></div><div><dt>任务分类</dt><dd>${esc(t.category)}</dd></div><div><dt>开始日期</dt><dd>${t.startDate}</dd></div><div><dt>截止日期</dt><dd>${t.dueDate}</dd></div>${t.completedAt?`<div><dt>完成时间</dt><dd>${timeText(t.completedAt)}</dd></div>`:''}${t.templateId?'<div><dt>任务来源</dt><dd>固定规则自动生成</dd></div>':''}</dl><div class="detail-section"><h3>交付要求</h3><p>${esc(t.deliverable)}</p></div>${t.description?`<div class="detail-section"><h3>补充说明</h3><p>${esc(t.description)}</p></div>`:''}<div class="detail-section"><h3>提交材料${(t.attachments||[]).length?`（${t.attachments.length} 份）`:''}</h3>${attachmentList(t)}${deletedAttachmentList(t,showDeleted)}</div><div class="detail-section"><h3>操作记录</h3>${activity(detailData?.events||[])}${detailData?.pagination?.page<detailData?.pagination?.pageCount?action('detail-events-more','更早操作记录','button small',`data-id="${esc(id)}"`):''}</div>`,`${action('delete-task','删除任务','button danger drawer-delete',`data-id="${id}"`)}${action('edit-task',`${icon('edit')} 编辑任务`,'button',`data-id="${id}"`)}${action('status',t.status==='已完成'?'重新打开':'标记完成','button primary',`data-id="${id}" data-status="${t.status==='已完成'?'待办':'已完成'}" data-detail="true"`)}`);}
async function taskForModal(id){const token=++modalToken;try{const result=await api('/api/tasks/'+encodeURIComponent(id));if(token!==modalToken)return null;taskCache.set(id,result.task);data.tasks=data.tasks.map(task=>task.id===id?result.task:task);return result.task;}catch(error){if(token===modalToken)toast(error.message,true);return null;}}
async function detail(id,showDeleted=false,more=false){const token=++modalToken;try{const page=more&&detailData?.task.id===id?detailData.pagination.page+1:1;const result=await api(`/api/tasks/${encodeURIComponent(id)}?eventPage=${page}`);if(token!==modalToken)return;detailData={...result,events:more?[...detailData.events,...result.events]:result.events};taskCache.set(id,result.task);renderDetail(id,showDeleted);}catch(error){if(token===modalToken)toast(error.message,true);}}
function confirmDeleteAttachment(id,taskId){
  const task=findTask(taskId),attachment=task?.attachments?.find(a=>a.id===id);
  if(!attachment){toast('此材料暂时不可用，请刷新后重试',true);return;}
  openDrawer('删除提交材料',`<div id="attachment-action-error" class="form-error" role="alert"></div><div class="delete-summary">${icon('trash')}<h3>确认删除这份提交材料？</h3><p class="delete-task-name">${esc(attachment.name)}</p><p>删除后将不再显示于提交材料列表，可在任务详情的「已删除材料」中恢复。</p>${task.status==='已完成'?'<p class="delete-rule-note">若删除本次完成的最后一份材料，任务将转为进行中，需重新上传才能完成。</p>':''}</div>`,`${action('cancel-delete-attachment','取消','button',`data-task-id="${esc(taskId)}"`)}${action('confirm-delete-attachment','确认删除','button danger',`data-id="${esc(id)}" data-task-id="${esc(taskId)}"`)}`);
}
async function changeAttachment(kind,id,taskId,button){
  if(attachmentBusy)return;
  const err=document.querySelector('#attachment-action-error');if(err)err.textContent='';
  const controls=[...document.querySelectorAll('.drawer button')],states=controls.map(el=>[el,el.disabled]);
  const label=button.textContent;attachmentBusy=true;controls.forEach(el=>el.disabled=true);button.textContent=kind==='delete'?'正在删除…':'正在恢复…';
  try{
    const result=await api(`/api/attachments/${encodeURIComponent(id)}${kind==='restore'?'/restore':''}`,{method:kind==='delete'?'DELETE':'POST',body:'{}'});
    data.tasks=data.tasks.map(t=>t.id===taskId?result.task:t);await refresh();detail(taskId,true);
    toast(kind==='restore'?'材料已恢复':result.reopened?'材料已删除，任务已转为进行中，请重新上传材料后完成任务':'材料已删除，可在「已删除材料」中恢复');
  }catch(error){if(err){err.textContent=error.message;err.scrollIntoView({block:'nearest'});}else toast(error.message,true);}
  finally{attachmentBusy=false;states.forEach(([el,disabled])=>el.disabled=disabled);button.textContent=label;}
}
function templateForm(id){const t=data.templates.find(t=>t.id===id)||{nextDate:today(),frequency:'每周',submissionType:'文本',dueDays:2,active:true};openDrawer(id?'编辑固定任务':'新建固定任务',`<p class="subtitle" style="margin:0 0 22px">设置周期、负责人和交付要求。</p><form id="template-form" data-id="${id||''}"><div class="form-error" role="alert"></div><div class="form-grid">${field('任务名称','title',t.title,'text','required maxlength="120" placeholder="例如：每周生产例会纪要"',true)}${field('负责人','owner',t.owner,'text','required maxlength="50"')}${selectField('重复周期','frequency',t.frequency,['每周','每月','每季度','每年'])}${field(id?'下次开始日期':'首次开始日期','nextDate',t.nextDate,'date','required')}${field('完成天数','dueDays',t.dueDays,'number','required min="0" max="90"')}<div class="field full"><span class="hint">完成天数从开始日期起计算，填 0 表示当天完成。月末规则会自动适配不同月份。</span></div>${selectField('提交形式','submissionType',taskSubmissionType(t),submissionTypes)}${selectField('规则状态','active',t.active?'启用':'暂停',['启用','暂停'])}${textareaField('交付要求','deliverable',t.deliverable,'required maxlength="2000" placeholder="每次生成任务需要完成的具体内容"')}</div></form>`,`${action('close','取消','button')}<button type="submit" form="template-form" class="button primary">${id?'保存规则':'创建规则'}</button>`);}
function importForm(){openDrawer('批量导入固定任务',`<p class="subtitle" style="margin:0 0 18px">使用模板填写固定工作台账，一次导入多项周期规则。</p><div class="button-row">${action('download-template',`${icon('download')} 下载导入模板`,'button small')}</div><div class="csv-example">表头顺序：任务名称、负责人、首次开始日期、完成天数、周期、交付要求、提交形式。<br>日期格式：2026-10-19；周期：每周 / 每月 / 每季度 / 每年。<br>请将表格另存为「逗号分隔、万国码编码」的文件。格式错误时整批不会写入。</div><form id="import-form"><div class="form-error" role="alert"></div><label class="upload-zone">${icon('upload')}选择导出的表格文件<input type="file" id="csv-file" accept=".csv,text/csv" aria-label="选择导入文件"></label><div class="field"><label for="csv-text">或直接粘贴表格文本</label><textarea id="csv-text" name="csv" rows="8" placeholder="任务名称,负责人,首次开始日期,完成天数,周期,交付要求,提交形式"></textarea><span class="hint">最多导入 1000 条规则。导入后可在固定任务页面检查和调整。</span></div></form>`,`${action('close','取消','button')}<button type="submit" form="import-form" class="button primary">确认导入</button>`);}
function roadmap(){openDrawer('平台建设进度',`<p class="subtitle">当前为本地管理员单人版。</p><div class="roadmap"><section class="roadmap-item"><h3>第一期 · 本地任务管理</h3><p>任务录入、状态流转、负责人改派与全程留痕。<br>固定任务周期生成、批量导入与系统内提醒。<br>支持通过 Server酱配置个人微信每日汇总推送。<br>当前为管理员单人本地使用。</p></section><section class="roadmap-item"><h3>第二期 · 智能文档辅助</h3><p>根据所选素材、历史样例与文档模板生成会议纪要、会议决议、统计材料初稿。支持录音转写，核对确认后导出 Word 或 Markdown。使用前请在「AI 文档」配置模型。</p></section><section class="roadmap-item"><h3>第三期 · 协作与扩展</h3><p>评估多用户分权限、更多通知渠道与云端部署，按实际使用需要逐步扩展。</p></section></div>`,action('close','知道了','button primary'));}
function navigate(next){page=next;query='';ownerFilter='';submissionFilter='';taskFilter='全部';taskPage=1;location.hash=next;renderApp();refresh();window.scrollTo(0,0);}

async function completionForm(id){
  const t=await taskForModal(id);if(!t)return;
  const type=taskSubmissionType(t);
  openDrawer('提交材料并完成任务',`<form id="completion-form" data-id="${id}"><div class="form-error" role="alert"></div><h3 class="completion-title">${esc(t.title)}</h3><div class="completion-requirement"><p><strong>提交形式：</strong>${esc(type)}</p><p><strong>交付要求：</strong></p><p class="requirement-text">${esc(t.deliverable)}</p></div><p class="completion-guidance">请上传符合交付要求的本次材料。系统校验文件格式和大小，业务内容由提交人核对确认。${(t.attachments||[]).length?'之前提交的材料仍保留，本次需重新上传。':''}</p><label class="upload-zone completion-upload" for="completion-files">${icon('upload')}<span>选择交付文件（可多选）</span><input id="completion-files" type="file" multiple accept="${submissionFormats[type].map(ext=>'.'+ext).join(',')}" aria-label="上传交付文件"></label><p class="file-hint">支持 ${formatText(type)}；每个文件不超过 10MB，最多 5 个，总计不超过 25MB。</p><div id="completion-file-list" class="completion-file-list"></div><div class="field"><label for="completion-note">提交说明（选填）</label><textarea id="completion-note" name="note" maxlength="2000" placeholder="说明材料内容或交付情况"></textarea></div><label class="completion-confirm"><input type="checkbox" id="completion-confirmed" name="confirmed" required><span>我已按交付要求核对上传内容</span></label></form>`,`${action('close','取消','button')}<button type="submit" form="completion-form" class="button primary">上传并标记完成</button>`);
  completionDraft={taskId:id,files:[]};renderCompletionFiles();
}
function renderCompletionFiles(){
  const list=document.querySelector('#completion-file-list');if(!list||!completionDraft)return;
  list.innerHTML=completionDraft.files.length?completionDraft.files.map((file,index)=>`<div class="completion-file"><div><strong>${esc(file.name)}</strong><span>${fileSizeText(file.size)}</span></div>${action('remove-completion-file','移除','link-button',`data-index="${index}" aria-label="移除文件：${esc(file.name)}"`)}</div>`).join(''):'<p class="attachment-empty">尚未选择文件。</p>';
}
function addCompletionFiles(input){
  if(!completionDraft||completionBusy)return;
  const err=document.querySelector('#completion-form .form-error');err.textContent='';
  try{
    const type=taskSubmissionType(findTask(completionDraft.taskId));const files=[...completionDraft.files];
    for(const file of input.files){
      if(!submissionFormats[type].includes(file.name.split('.').at(-1).toLowerCase()))throw new Error(`“${file.name}”不符合提交形式“${type}”，请上传 ${formatText(type)} 文件。`);
      if(!file.size||file.size>10*1024*1024)throw new Error('每个文件必须非空，且不能超过 10MB。');
      if(!files.some(old=>old.name===file.name&&old.size===file.size&&old.lastModified===file.lastModified))files.push(file);
    }
    if(files.length>5)throw new Error('每次最多上传 5 个文件。');
    if(files.reduce((sum,file)=>sum+file.size,0)>25*1024*1024)throw new Error('本次文件总大小不能超过 25MB。');
    completionDraft.files=files;renderCompletionFiles();
  }catch(error){err.textContent=error.message;}finally{input.value='';}
}
function readFileBase64(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error(`无法读取“${file.name}”，请重新选择。`));reader.readAsDataURL(file);});}
async function submitCompletion(form){
  if(completionBusy||!completionDraft)return;
  const err=form.querySelector('.form-error');err.textContent='';
  if(!completionDraft.files.length){err.textContent='请先上传符合提交形式的交付文件。';return;}
  if(!form.querySelector('#completion-confirmed').checked){err.textContent='请按交付要求核对上传内容，并勾选确认。';return;}
  const id=completionDraft.taskId,note=form.querySelector('#completion-note').value;
  const controls=[...document.querySelectorAll('.drawer button,.drawer input,.drawer textarea')],submit=document.querySelector('button[form="completion-form"]');
  completionBusy=true;controls.forEach(el=>el.disabled=true);submit.textContent='正在上传…';
  try{
    const files=[];for(const file of completionDraft.files)files.push({name:file.name,contentBase64:await readFileBase64(file)});
    const result=await api(`/api/tasks/${encodeURIComponent(id)}/complete`,{method:'POST',body:JSON.stringify({files,confirmed:true,note})});
    data.tasks=data.tasks.map(t=>t.id===id?result.task:t);await refresh();completionBusy=false;closeDrawer();detail(id);toast('材料已保存，任务已完成');
  }catch(error){err.textContent=error.message;err.scrollIntoView({block:'nearest'});}finally{completionBusy=false;controls.forEach(el=>el.disabled=false);submit.textContent='上传并标记完成';}
}

document.addEventListener('click',async e=>{
  const button=e.target.closest('[data-action]');if(!button){return;}
  const a=button.dataset.action,id=button.dataset.id;
  if(a.startsWith('tw-')){await workflow.onAction(a.slice(3),button);return;}
  if(completionBusy||serverchanBusy||attachmentBusy||ai.busy||workflow.busy)return;
  if(a.startsWith('ai-')){await ai.onAction(a.slice(3),button);return;}
  if(a==='serverchan-configure'){serverchanForm();return;}
  if(a==='serverchan-test'||a==='serverchan-send'||a==='serverchan-clear'){await serverchanRequest(a.slice('serverchan-'.length),button);return;}
  if(a==='serverchan-clear-prompt'||a==='serverchan-clear-cancel'){document.querySelector('#serverchan-clear-confirm').hidden=a==='serverchan-clear-cancel';return;}
  if(a==='task-page'){taskPage=Math.max(1,Number(button.dataset.pageNumber)||1);await refresh();return;}
  if(a==='remove-completion-file'){if(completionDraft){completionDraft.files.splice(Number(button.dataset.index),1);renderCompletionFiles();}return;}
  if(a==='status'&&button.dataset.status==='已完成'){openWorkspace(id);return;}
  if(a==='navigate'){navigate(button.dataset.page);return;}
  if(a==='menu'){document.querySelector('.sidebar').classList.toggle('mobile-open');return;}
  if(a==='close'){closeDrawer();return;}
  if(a==='new-task'||a==='edit-task'){taskForm(id);return;}
  if(a==='detail'){await detail(id);return;}
  if(a==='detail-events-more'){await detail(id,false,true);return;}
  if(a==='workspace'){openWorkspace(id);return;}
  if(a==='delete-attachment'){confirmDeleteAttachment(id,button.dataset.taskId);return;}
  if(a==='cancel-delete-attachment'){detail(button.dataset.taskId);return;}
  if(a==='confirm-delete-attachment'||a==='restore-attachment'){await changeAttachment(a==='confirm-delete-attachment'?'delete':'restore',id,button.dataset.taskId,button);return;}
  if(a==='delete-task'){confirmDelete(id);return;}
  if(a==='trash'){button.disabled=true;try{await openTrash();}catch(error){toast(error.message,true);}finally{button.disabled=false;}return;}
  if(a==='new-template'||a==='edit-template'){templateForm(id);return;}
  if(a==='roadmap'){roadmap();return;}
  if(a==='import'){importForm();return;}
  if(a==='filter'){taskFilter=button.dataset.filter;taskPage=1;await refresh();return;}
  if(a==='stat'){navigate('tasks');taskFilter=button.dataset.filter;await refresh();return;}
  if(a==='layout'){layout=button.dataset.layout;renderApp();return;}
  if(a==='reminder-filter'){reminderFilter=button.dataset.filter;reminderPage=1;await refresh();return;}
  if(a==='reminder-page'){reminderPage=Math.max(1,Number(button.dataset.pageNumber)||1);await refresh();return;}
  if(a==='retry'){await refresh();return;}
  if(a==='download-template'){const csv=`\ufeff任务名称,负责人,首次开始日期,完成天数,周期,交付要求,提交形式\r\n每周生产例会纪要,张明,${today()},2,每周,整理并提交例会纪要,文本\r\n`;const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download='固定任务导入模板.csv';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);return;}
  button.disabled=true;
  try{
    if(a==='confirm-delete'){await api(`/api/tasks/${encodeURIComponent(id)}`,{method:'DELETE',body:'{}'});await refresh();closeDrawer();toast('任务已移入回收站，可在任务台账中恢复');}
    if(a==='restore'){await api(`/api/tasks/${encodeURIComponent(id)}/restore`,{method:'POST',body:'{}'});await refresh();await openTrash();toast('任务已恢复');}
    if(a==='status'){await api(`/api/tasks/${encodeURIComponent(id)}`,{method:'PATCH',body:JSON.stringify({status:button.dataset.status})});await refresh();if(button.dataset.detail)detail(id);toast(button.dataset.status==='已完成'?'任务已完成，记录已保存':button.dataset.status==='待办'?'任务已重新打开':'已开始处理这项任务');}
    if(a==='toggle-template'){const t=data.templates.find(t=>t.id===id);await api(`/api/templates/${encodeURIComponent(id)}`,{method:'PATCH',body:JSON.stringify({active:!t.active})});await refresh();toast(t.active?'已暂停该规则，历史任务仍然保留':'已启用周期生成规则');}
    if(a==='read'||a==='read-all'){await api('/api/reminders/read',{method:'POST',body:JSON.stringify(a==='read'?{ids:[id]}:{all:true})});await refresh();toast(a==='read'?'提醒已标记为已读':'全部提醒已标记为已读');}
    if(a==='run'){const r=await api('/api/run',{method:'POST',body:'{}'});await refresh();toast(`检查完成：生成 ${r.generated} 项任务，新增 ${r.reminded} 条提醒`);}
  }catch(error){toast(error.message,true);}finally{button.disabled=false;}
});
document.addEventListener('input',e=>{if(e.target.closest('.task-workspace'))workflow.input(e.target);if(e.target.id==='task-search'){query=e.target.value;taskPage=1;clearTimeout(searchTimer);searchTimer=setTimeout(()=>refresh(),200);}if(e.target.id==='ai-task-search'||e.target.closest('#ai-document-form,#ai-template-form'))ai.input(e.target);});
document.addEventListener('change',async e=>{
  if(e.target.closest('.task-workspace')){await workflow.change(e.target);return;}
  if(e.target.id==='ai-material-file'||e.target.id==='ai-template-file'){await ai.change(e.target);return;}
  if(e.target.id==='owner-filter'||e.target.id==='submission-filter'){if(e.target.id==='owner-filter')ownerFilter=e.target.value;else submissionFilter=e.target.value;taskPage=1;await refresh();}
  if(e.target.id==='task-page-select'){taskPage=Number(e.target.value)||1;await refresh();}
  if(e.target.id==='completion-files')addCompletionFiles(e.target);
  if(e.target.id==='field-startDate'){const input=document.querySelector('#field-dueDate');if(input)input.min=e.target.value;}
  if(e.target.id==='csv-file'){const f=e.target.files[0];if(f){if(f.size>1024*1024){toast('文件过大，请使用小于一兆的表格文件',true);e.target.value='';return;}document.querySelector('#csv-text').value=await f.text();}}
});
document.addEventListener('submit',async e=>{
  if(e.target.id.startsWith('tw-')){e.preventDefault();await workflow.onSubmit(e.target);return;}
  if(e.target.id.startsWith('ai-')){e.preventDefault();if(!ai.busy)await ai.onSubmit(e.target);return;}
  if(e.target.id==='completion-form'){e.preventDefault();await submitCompletion(e.target);return;}
  if(e.target.id==='serverchan-form'){e.preventDefault();await saveServerchan(e.target);return;}
  const form=e.target;if(!['task-form','template-form','settings-form','import-form'].includes(form.id))return;e.preventDefault();
  const fields=Object.fromEntries(new FormData(form));const buttons=[...document.querySelectorAll(`button[form="${form.id}"], #${form.id} button[type="submit"]`)];buttons.forEach(b=>b.disabled=true);const err=form.querySelector('.form-error');err.textContent='';
  try{
    if(form.id==='task-form'){
      if(fields.dueDate<fields.startDate)throw new Error('截止日期不能早于开始日期，请调整后再保存。');
      const id=form.dataset.id;await api(id?`/api/tasks/${encodeURIComponent(id)}`:'/api/tasks',{method:id?'PATCH':'POST',body:JSON.stringify(fields)});await refresh();closeDrawer();if(!id)navigate('tasks');toast(id?'任务已更新，变更已记录':'任务创建成功，已保存到本机');
    }
    if(form.id==='template-form'){fields.dueDays=Number(fields.dueDays);fields.active=fields.active==='启用';const id=form.dataset.id;await api(id?`/api/templates/${encodeURIComponent(id)}`:'/api/templates',{method:id?'PATCH':'POST',body:JSON.stringify(fields)});await refresh();closeDrawer();toast(id?'固定任务规则已更新':'固定任务规则已创建，将在检查时自动生成');}
    if(form.id==='settings-form'){fields.reminderDays=Number(fields.reminderDays);await api('/api/settings',{method:'PATCH',body:JSON.stringify(fields)});await refresh();toast('设置已保存，下次检查时生效');}
    if(form.id==='import-form'){if(!fields.csv.trim())throw new Error('请先选择文件或粘贴要导入的表格文本。');const r=await api('/api/templates/import',{method:'POST',body:JSON.stringify(fields)});await refresh();closeDrawer();toast(`已成功导入 ${r.created} 条固定任务规则`);}
  }catch(error){err.textContent=error.message;err.scrollIntoView({block:'nearest'});}finally{buttons.forEach(b=>b.disabled=false);}
});
document.addEventListener('keydown',e=>{
  const drawer=document.querySelector('.drawer');if(!drawer)return;
  if(e.key==='Escape'){closeDrawer();return;}
  if(e.key==='Tab'){const elements=[...drawer.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')].filter(el=>el.offsetParent!==null);const first=elements[0],last=elements.at(-1);if(e.shiftKey&&(document.activeElement===first||document.activeElement===drawer)){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}
});
window.addEventListener('hashchange',()=>{const p=location.hash.slice(1);if(p.startsWith('task/')){page='task';let taskId;try{taskId=decodeURIComponent(p.slice(5));}catch{taskId=p.slice(5);}workflow.open(taskId);renderApp();window.scrollTo(0,0);return;}if(pageNames[p]&&p!==page){page=p;query='';ownerFilter='';submissionFilter='';taskFilter='全部';taskPage=1;renderApp();refresh();window.scrollTo(0,0);}});
window.addEventListener('beforeunload',e=>{if(workflow.hasUnsaved){e.preventDefault();e.returnValue='';}});
setInterval(()=>{if(page!=='task'&&!workflow.busy&&!ai.busy&&!document.hidden&&!document.querySelector('.drawer, .sidebar.mobile-open')&&!['INPUT','SELECT','TEXTAREA'].includes(document.activeElement?.tagName))refresh();},30000);
renderApp();if(page==='task'){let taskId;try{taskId=decodeURIComponent(location.hash.slice(6));}catch{taskId=location.hash.slice(6);}workflow.open(taskId);}refresh();
